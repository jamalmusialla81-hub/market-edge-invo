"""Executable Shadow exit replay (#120): more legitimate forward counterfactual evidence for the 3H exit bar, at zero capital.

Pipeline: SHADOW CANDIDATE -> point-in-time eligibility -> SHADOW_ENTRY_MODEL_V1 -> full 5m path replay of CURRENT_POLICY and every
registered adaptive policy (the unchanged 3G engine) -> finalized rows -> the unchanged 3H evaluation, once per cohort.

Cohorts are labelled on every row and are never merged in a report:
  A  actual paper trades. Handled by the existing exit shadow; only counted here.
  B  executable Shadow candidates not executed for an operational / selection reason (rank lost, portfolio full, duplicate instrument).
  C  every other Shadow candidate with computable geometry: hypothesis evidence only.

Rules this module keeps:
  * Only decision-time fields decide eligibility. A missing required field is UNKNOWN_EXECUTABILITY, never EXECUTABLE.
  * The entry is the first 5m bar OPEN at or after the decision plus the paper engine's own adverse slippage; never the signal price.
  * The replay reads recorded candles in order (conservative stop-first inside a candle). Nothing is invented: a path with a gap or an
    unfinished exit is not finalized, it stays pending and is counted as such.
  * Only the first observation of each observation cluster is replayed, so 20 overlapping PUMP rows are one replay, not 20.
  * Results go to a separate research table (`shadow_exit_replays`, immutable rows) inside the shadow database. It touches no trade,
    order, router, sizing, ranking or threshold, and the 30 trade / 30 episode bar is unchanged and never fed by Cohort B or C.
"""
from __future__ import annotations

import json
import sqlite3
import time
from collections import defaultdict
from contextlib import closing
from typing import Iterable, Optional

from market_edge_exec.exits import EXIT_MANAGER_VERSION, policies as pol, replay as rp
from market_edge_exec.exits.evaluation import EVIDENCE_BAR_V1, cluster_id, evaluate
from market_edge_exec.exits.model import CANDLE_MS, Observation, TradeSpec
from market_edge_exec.paper import lifecycle
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import _blob, _unblob

SHADOW_REPLAY_VERSION = "SHADOW-EXIT-REPLAY-V1"
ELIGIBILITY_VERSION = "EXECUTABLE-ELIGIBILITY-V1"
ENTRY_MODEL_VERSION = "SHADOW_ENTRY_MODEL_V1"
EPISODE_CLASS_VERSION = "EXIT-EPISODE-CLASS-V1"

COHORT_A, COHORT_B, COHORT_C = "A_PAPER", "B_EXECUTABLE_SHADOW", "C_RESEARCH_ONLY"
EXECUTABLE, NOT_EXECUTABLE, UNKNOWN = "EXECUTABLE", "NOT_EXECUTABLE", "UNKNOWN_EXECUTABILITY"

# Why an otherwise executable candidate was not executed. Operational / selection reasons only; an absent signal is not one of them.
B_REASONS = frozenset({"RANK_BELOW_SELECTED", "NOT_ASSET_PICK", "POSITION_EXPOSURE_CAP", "PORTFOLIO_EXPOSURE_CAP",
                       "MAX_CONCURRENT_POSITIONS_EXCEEDED", "DUPLICATE_INSTRUMENT"})
# Risk Sizing V2 rejections that say the TRADE itself cannot be sized (a hard property of the candidate). Rejections that only reflect
# portfolio state (positions, drawdown pause, caps) or missing sizing inputs do not make it non-executable: they are noted.
V2_BLOCKING = frozenset({"INVALID_STOP", "INVALID_RISK_CALCULATION", "EXCESS_EXPECTED_SLIPPAGE", "MIN_ORDER_EXCEEDS_SAFE_SIZE", "LIQUIDITY_CAP"})
PATH_HORIZON_MS = 6 * 24 * 3_600_000      # a replay still unfinished this long after the decision is reported as path-unavailable
MAX_PER_CALL = 10                          # bounds CPU per resolve call (22 policies over up to 1,440 bars each)

# Diagnostic episode labels. Thresholds were fixed here before any result was viewed; the labels are never decision-time features.
EPISODE_CLASS = {"version": EPISODE_CLASS_VERSION, "entry_failure_mfe_R_below": 0.5, "giveback_failure_mfe_R_at_least": 1.0,
                 "giveback_failure_giveback_R_at_least": 1.0, "early_exit_baseline_R_at_least": 1.0, "early_exit_mean_delta_R_at_most": -0.5}

DDL = """
CREATE TABLE IF NOT EXISTS shadow_exit_replays (
    observation_id TEXT NOT NULL, policy_version TEXT NOT NULL, cohort TEXT NOT NULL, replay_version TEXT NOT NULL,
    entry_model_version TEXT NOT NULL, eligibility_version TEXT NOT NULL, asset TEXT NOT NULL, direction TEXT NOT NULL,
    decision_ts INTEGER NOT NULL, opened_at_ms INTEGER NOT NULL, observation_cluster_id TEXT NOT NULL,
    market_episode_id TEXT NOT NULL, record BLOB NOT NULL, created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (observation_id, policy_version)
);
CREATE INDEX IF NOT EXISTS shadow_exit_replays_cohort ON shadow_exit_replays (cohort, decision_ts);
CREATE TRIGGER IF NOT EXISTS shadow_exit_replays_no_update BEFORE UPDATE ON shadow_exit_replays
    BEGIN SELECT RAISE(ABORT, 'SHADOW_RESEARCH_ROW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS shadow_exit_replays_no_delete BEFORE DELETE ON shadow_exit_replays
    BEGIN SELECT RAISE(ABORT, 'SHADOW_RESEARCH_ROW_IMMUTABLE'); END;
"""


def ensure_table(connect) -> None:
    with closing(connect()) as conn:
        conn.executescript(DDL)
        conn.commit()


def has_table(connect) -> bool:
    with closing(connect()) as conn:
        return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shadow_exit_replays'").fetchone() is not None


def _num(value) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value == value else None


# ---- 1. eligibility (decision-time fields only) ------------------------------------------------------------
def reconstruct_eligibility(row: dict, decision: dict) -> dict:
    """`row` is the shadow_observations row, `decision` its decoded decision-time payload. Deterministic; no hindsight field is read."""
    out = {"eligibility_version": ELIGIBILITY_VERSION, "status": UNKNOWN, "reasons": [], "cohort": COHORT_C, "notes": []}

    def finish(status: str, reasons: list, cohort: str):
        out.update(status=status, reasons=reasons, cohort=cohort)
        return out

    if row.get("execution_status") == "EXECUTED":
        return finish(EXECUTABLE, ["EXECUTED_AS_PAPER_TRADE"], COHORT_A)
    if row.get("kind") != C.KIND_CANDIDATE:
        return finish(NOT_EXECUTABLE, ["NOT_A_CANDIDATE"], COHORT_C)
    cand, market = decision.get("candidate"), decision.get("market")
    missing = [k for k, ok in (("candidate", isinstance(cand, dict)), ("market", isinstance(market, dict))) if not ok]
    if not missing:
        for key in ("direction", "entry", "stop", "tp1", "tp2"):
            if cand.get(key) is None:
                missing.append(f"candidate.{key}")
        for key in ("price", "data_age_ms", "venue"):
            if market.get(key) is None:
                missing.append(f"market.{key}")
    if missing:
        return finish(UNKNOWN, [f"MISSING_REQUIRED_FIELD:{m}" for m in missing], COHORT_C)
    blocking = []
    if not row.get("research_candidate_valid"):
        blocking.append(row.get("invalid_reason") or "INVALID_CANDIDATE")
    if market["venue"] != C.OUTCOME_VENUE:
        blocking.append("VENUE_NOT_SUPPORTED")
    if row.get("production_state") == "OUTSIDE_PRODUCTION_UNIVERSE":
        blocking.append("OUTSIDE_PRODUCTION_UNIVERSE")
    if cand.get("geometry_complete") is False:
        blocking.append("INCOMPLETE_GEOMETRY")
    sizing = decision.get("counterfactual_sizing")
    if isinstance(sizing, dict):
        if sizing.get("approved") is False:
            why = sizing.get("rejection_reason")
            if why in V2_BLOCKING:
                blocking.append(f"RISK_SIZING_V2_REJECTED:{why}")
            else:
                out["notes"].append(f"RISK_SIZING_V2_NOT_APPLICABLE:{why}")
    else:
        out["notes"].append("RISK_SIZING_V2_COUNTERFACTUAL_NOT_AVAILABLE")
    if not (isinstance(sizing, dict) and sizing.get("liquidity_cap_notional") is not None):
        out["notes"].append("LIQUIDITY_NOT_AVAILABLE")
    if blocking:
        return finish(NOT_EXECUTABLE, blocking, COHORT_C)
    reason = row.get("execution_rejection_reason")
    if row.get("execution_status") in ("NOT_SUBMITTED", "REJECTED") and reason in B_REASONS:
        return finish(EXECUTABLE, [f"NOT_EXECUTED_FOR:{reason}"], COHORT_B)
    return finish(EXECUTABLE, [f"NOT_EXECUTED_FOR:{reason}" if reason else "NO_EXECUTION_REASON_RECORDED"], COHORT_C)


# ---- 2. entry model + path -----------------------------------------------------------------------------------
def clean_path(candles: Iterable[dict], first_bar_ts: int, now_ms: int) -> list[dict]:
    """The maximal contiguous run of complete 5m bars starting at the entry bar. A gap ends the path; nothing is repaired."""
    by_time = {}
    for c in candles or []:
        try:
            bar = {k: float(c[k]) for k in ("open", "high", "low", "close")}
            t = int(c["time"])
        except (KeyError, TypeError, ValueError):
            continue
        if t % CANDLE_MS or t + CANDLE_MS > now_ms or bar["low"] <= 0 or bar["high"] < max(bar["open"], bar["close"]) or bar["low"] > min(bar["open"], bar["close"]):
            continue
        by_time[t] = {"time": t, **bar}
    out, t = [], first_bar_ts
    while t in by_time:
        out.append(by_time[t])
        t += CANDLE_MS
    return out


def shadow_entry(observation_id: str, row: dict, decision: dict, path: list[dict]) -> tuple[Optional[TradeSpec], dict]:
    """SHADOW_ENTRY_MODEL_V1: fill at the first eligible 5m bar open plus the paper engine's adverse slippage. Returns (spec, model record)."""
    cand = decision["candidate"]
    long = cand["direction"] == "long"
    stop, tp1, tp2 = float(cand["stop"]), float(cand["tp1"]), float(cand["tp2"])
    bar0 = path[0]
    fill = lifecycle.slipped(bar0["open"], "buy" if long else "sell")
    model = {"entry_model_version": ENTRY_MODEL_VERSION, "decision_ts": row["decision_ts"], "fill_bar_open_ts": bar0["time"],
             "latency_ms": bar0["time"] - row["decision_ts"], "reference_open": bar0["open"], "assumed_fill": fill,
             "signal_entry": cand["entry"], "slippage_pct_per_side": lifecycle.SLIPPAGE_PCT, "fee_pct_per_side": lifecycle.FEE_PCT,
             "spread": "NOT_RECORDED_IN_SHADOW_DATA_COVERED_BY_SLIPPAGE_ASSUMPTION", "rejection": None}
    if (long and fill <= stop) or (not long and fill >= stop):
        model["rejection"] = "STOP_ALREADY_BREACHED_AT_FILL"
        return None, model
    if (long and fill >= tp1) or (not long and fill <= tp1):
        model["rejection"] = "TP1_ALREADY_PASSED_AT_FILL"
        return None, model
    quantity = 1.0 / abs(fill - stop)      # normalises 1R to one dollar; R is scale free
    spec = TradeSpec(trade_id=observation_id, direction=cand["direction"], entry=fill, stop=stop, tp1=tp1, tp2=tp2, quantity=quantity,
                     opened_at_ms=bar0["time"], entry_fee=lifecycle.fee(fill, quantity), asset=row["asset"])
    return spec, model


def _observations(path: list[dict]) -> list[Observation]:
    return [Observation(seq=i + 1, kind="CANDLE", at_ms=b["time"], eval_ms=b["time"] + CANDLE_MS, price=b["close"], high=b["high"],
                        low=b["low"], open=b["open"], batch=i + 1, last=True) for i, b in enumerate(path)]


# ---- 3. replay -----------------------------------------------------------------------------------------------
def replay_observation(observation_id: str, row: dict, decision: dict, candles: Iterable[dict], now_ms: int,
                       registry=pol.REGISTRY) -> dict:
    """Never raises for missing data. `status` is one of:
    NOT_REPLAYABLE (with reasons), PATH_PENDING (no finished exit yet), or FINAL (every policy exited on a complete path)."""
    eligibility = reconstruct_eligibility(row, decision)
    if eligibility["cohort"] == COHORT_A:
        return {"status": "NOT_REPLAYABLE", "reasons": ["COHORT_A_HAS_A_REAL_PATH"], "eligibility": eligibility}
    if eligibility["status"] == UNKNOWN:
        return {"status": "NOT_REPLAYABLE", "reasons": eligibility["reasons"], "eligibility": eligibility}
    path = clean_path(candles, row["first_bar_ts"], now_ms)
    if not path:
        return {"status": "PATH_PENDING", "reasons": ["NO_ENTRY_BAR_YET"], "eligibility": eligibility}
    spec, model = shadow_entry(observation_id, row, decision, path)
    if spec is None:
        return {"status": "NOT_REPLAYABLE", "reasons": [model["rejection"]], "eligibility": eligibility, "entry_model": model}
    observations = _observations(path)
    records = {}
    for name, policy in registry.items():
        run = rp.replay(spec, observations, policy)
        record = rp.summarize(spec, run)
        record.update({"policy_version": name, "study": policy.study, "registry_version": pol.POLICY_REGISTRY_VERSION,
                       "manager_version": EXIT_MANAGER_VERSION, "asset": spec.asset, "direction": spec.direction,
                       "opened_at_ms": spec.opened_at_ms, "stop_distance_pct": spec.risk_distance / spec.entry * 100.0,
                       "params": dict(policy.params)})
        records[name] = record
    if any(r["status"] != "EXITED" for r in records.values()):
        return {"status": "PATH_PENDING", "reasons": ["NO_FINISHED_EXIT_ON_THE_PATH_SO_FAR"], "path_bars": len(path),
                "eligibility": eligibility, "entry_model": model}
    base = records[pol.BASELINE]["counterfactual_R"]
    for r in records.values():
        r["real_R"] = base    # what the trade did with no adaptive exit, on the same path: the reference for early-exit regret
        r["cohort"], r["eligibility"], r["entry_model"] = eligibility["cohort"], eligibility, model
        r["replay_version"] = SHADOW_REPLAY_VERSION
    return {"status": "FINAL", "records": records, "eligibility": eligibility, "entry_model": model, "path_bars": len(path)}


# ---- 4. runner over the shadow database ----------------------------------------------------------------------
_LEADER_SQL = """
SELECT o.observation_id, o.asset, o.coin, o.kind, o.direction, o.decision_ts, o.first_bar_ts, o.execution_status,
       o.execution_rejection_reason, o.research_candidate_valid, o.invalid_reason, o.production_state,
       o.observation_cluster_id, o.market_episode_id, o.decision
FROM shadow_observations o
WHERE o.kind='CANDIDATE' AND o.research_candidate_valid=1 AND o.execution_status IN ('NOT_SUBMITTED','REJECTED')
  AND o.decision_ts {age_op} ? {coin_clause}
  AND NOT EXISTS (SELECT 1 FROM shadow_observations p WHERE p.observation_cluster_id=o.observation_cluster_id AND p.kind=o.kind
                  AND (p.decision_ts < o.decision_ts OR (p.decision_ts = o.decision_ts AND p.observation_id < o.observation_id)))
  AND NOT EXISTS (SELECT 1 FROM shadow_exit_replays r WHERE r.observation_id=o.observation_id)
ORDER BY CASE WHEN o.execution_rejection_reason IN ({b_marks}) THEN 0 ELSE 1 END, o.decision_ts
"""


def _pending_rows(connect, now_ms: int, coin: Optional[str], limit: Optional[int], expired: bool = False, create: bool = True) -> list[dict]:
    """Leader observations with no replay row yet: inside the path horizon, or (expired=True) past it. Read-only callers pass create=False."""
    if create:
        ensure_table(connect)
    elif not has_table(connect):
        return []   # nothing has ever been replayed: every leader would be pending, but a read never creates the table
    sql = _LEADER_SQL.format(age_op="<" if expired else ">=", coin_clause="AND o.coin=?" if coin else "", b_marks=",".join("?" * len(B_REASONS)))
    if limit:
        sql += f" LIMIT {int(limit)}"
    args = [now_ms - PATH_HORIZON_MS] + ([coin] if coin else []) + sorted(B_REASONS)
    with closing(connect()) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def pending_coins(connect, now_ms: Optional[int] = None, limit: int = 50) -> list[dict]:
    """Coins with a leader observation still waiting for its path: {coin, since_ms} in the shape /shadow/pending uses."""
    now_ms = now_ms or int(time.time() * 1000)
    since: dict = {}
    for r in _pending_rows(connect, now_ms, None, None):
        if now_ms - r["first_bar_ts"] >= CANDLE_MS:
            since[r["coin"]] = min(since.get(r["coin"], r["first_bar_ts"]), r["first_bar_ts"])
    return [{"coin": c, "since_ms": s} for c, s in sorted(since.items(), key=lambda kv: kv[1])][:limit]


def run_for_coin(connect, coin: str, candles: list[dict], now_ms: Optional[int] = None, registry=pol.REGISTRY,
                 limit: int = MAX_PER_CALL) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    tally = {"coin": coin, "finalized": 0, "pending": 0, "not_replayable": 0}
    for row in _pending_rows(connect, now_ms, coin, limit):
        result = replay_observation(row["observation_id"], row, _unblob(row["decision"]), candles, now_ms, registry)
        if result["status"] == "PATH_PENDING":
            tally["pending"] += 1
            continue
        if result["status"] == "NOT_REPLAYABLE":
            tally["not_replayable"] += 1
            continue
        with closing(connect()) as conn:
            for name, record in result["records"].items():
                conn.execute("INSERT OR IGNORE INTO shadow_exit_replays VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                             (row["observation_id"], name, record["cohort"], SHADOW_REPLAY_VERSION, ENTRY_MODEL_VERSION, ELIGIBILITY_VERSION,
                              row["asset"], row["direction"], row["decision_ts"], record["opened_at_ms"], row["observation_cluster_id"],
                              row["market_episode_id"], _blob(record), now_ms))
            conn.commit()
        tally["finalized"] += 1
    return tally


# ---- 5. reporting, cohort by cohort --------------------------------------------------------------------------
def _records(connect, cohort: str) -> list[dict]:
    if not has_table(connect):
        return []
    with closing(connect()) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT observation_id, policy_version, observation_cluster_id, market_episode_id, record FROM shadow_exit_replays "
                            "WHERE cohort=? ORDER BY decision_ts, observation_id, policy_version", (cohort,)).fetchall()
    return [{"trade_id": r["observation_id"], "cluster": r["observation_cluster_id"], "episode": r["market_episode_id"],
             "policy_version": r["policy_version"], **_unblob(r["record"])} for r in rows]


def classify_episode(records_by_policy: dict) -> str:
    """Diagnostic label for one replayed observation (CURRENT_POLICY outcome plus what the adaptive policies did to it)."""
    cfg, base = EPISODE_CLASS, records_by_policy[pol.BASELINE]
    if base["MFE_R"] < cfg["entry_failure_mfe_R_below"] and base["counterfactual_R"] < 0:
        return "ENTRY_FAILURE"
    if base["MFE_R"] >= cfg["giveback_failure_mfe_R_at_least"] and base["giveback_R"] >= cfg["giveback_failure_giveback_R_at_least"]:
        return "GIVEBACK_FAILURE"
    deltas = [r["counterfactual_R"] - base["counterfactual_R"] for n, r in records_by_policy.items()
              if n != pol.BASELINE and r.get("reason") in ("POLICY_STOP", "POLICY_EXIT", "POLICY_PARTIAL")]
    if base["counterfactual_R"] >= cfg["early_exit_baseline_R_at_least"] and deltas and sum(deltas) / len(deltas) <= cfg["early_exit_mean_delta_R_at_most"]:
        return "EARLY_EXIT_RISK"
    if base["counterfactual_R"] > 0:
        return "SUCCESSFUL_FIXED_EXIT"
    return "OTHER_INDETERMINATE"


def cohort_report(connect, now_ms: Optional[int] = None) -> dict:
    """Evidence per cohort. B and C are evaluated separately with the unchanged 3H function and never combined with each other or with
    the paper cohort; nothing here counts toward the 30 trade / 30 episode paper bar."""
    now_ms = now_ms or int(time.time() * 1000)
    cohorts = {}
    for cohort in (COHORT_B, COHORT_C):
        records = _records(connect, cohort)
        by_obs: dict = defaultdict(dict)
        meta: dict = {}
        for r in records:
            by_obs[r["trade_id"]][r["policy_version"]] = r
            meta[r["trade_id"]] = (r["cluster"], r["episode"], r["opened_at_ms"])
        classes: dict = defaultdict(int)
        for policies in by_obs.values():
            if pol.BASELINE in policies:
                classes[classify_episode(policies)] += 1
        evaluation = evaluate(records)
        cohorts[cohort] = {
            "replayed_observations": len(by_obs), "observation_clusters": len({m[0] for m in meta.values()}),
            "market_episodes": len({m[1] for m in meta.values()}),
            "independence_units_3h": len({cluster_id(m[2], EVIDENCE_BAR_V1["cluster_hours"]) for m in meta.values()}),
            "episode_classes": dict(sorted(classes.items())), "evaluation": evaluation}
    pending_rows = _pending_rows(connect, now_ms, None, None, create=False)
    return {
        "version": SHADOW_REPLAY_VERSION, "entry_model": ENTRY_MODEL_VERSION, "eligibility": ELIGIBILITY_VERSION,
        "episode_class_thresholds": EPISODE_CLASS,
        "independence_unit": (f"3H's own {EVIDENCE_BAR_V1['cluster_hours']}h UTC window on the entry time (coarser than any per asset/direction "
                              "grouping, so it can only under-count independence). Rows also carry observation_cluster_id and market_episode_id."),
        "cohort_A_note": "Actual paper trades: reported by /research/exit-policies/evaluation, never mixed with B or C here.",
        "cohorts": cohorts,
        "pending_leader_observations": len(pending_rows),
        "expired_without_replay": len(_pending_rows(connect, now_ms, None, None, expired=True, create=False)),
        "selection_caveat": ("A row is final only once every policy has exited on a complete recorded path. Observations still open when the "
                             "path ends are not counted (they are reported as pending), so long holds are under-represented until their "
                             "paths complete. The paired comparison uses identical paths for every policy."),
        "counts_toward_paper_bar": False,
        "promotion": "NONE. Evidence only; Cohort B/C never enables PAPER_CANARY or PAPER."}
