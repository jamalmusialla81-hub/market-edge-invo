"""DATA 18: counterfactual portfolio learning. Did rank #1 beat #2/#3? Did the chosen asset beat the rejected ones? Did correlated
selections hurt? Did the exposure caps help or hurt?

FINDINGS ONLY. Nothing here proposes or applies a change to caps, ranking or candidate generation; a "would have been better"
result still has to go through DATA 6/7/8/10/11 like any other research finding.

Rules (each has a test):
  - every R is the shadow resolver's own after-cost 72h `policy_r` (the paper lifecycle's FEE_PCT / SLIPPAGE_PCT, both sides). This module
    has no cost model of its own and never re-costs, so a counterfactual can never be cheaper than what real execution would pay
  - an alternative counts only if it was a research-valid candidate at decision time, its data-quality verdict is VALID and its final
    outcome resolved OK. Anything else is excluded and counted by reason; nothing is ever assumed to "have executed"
  - hypothetical results are labelled HYPOTHETICAL throughout (same discipline as the POST-OUTCOME label in Trade Detail)
  - intervals resample whole clusters (shadow.stats.grouped_bootstrap); the scan is the unit of comparison
  - the database is opened read-only
"""
from __future__ import annotations

import os
import re
import sqlite3
from collections import Counter, defaultdict
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.datasets import builder as B
from market_edge_exec.paper import lifecycle
from market_edge_exec.quality import checks as K, runner as quality_runner
from market_edge_exec.shadow import contracts as C, stats as S

ANALYSIS_VERSION = "COUNTERFACTUAL-PORTFOLIO-V1"
LABEL = "HYPOTHETICAL · RESEARCH ONLY · NOT EXECUTED · FINDINGS ONLY · CHANGES NOTHING"
COST_MODEL = {"source": "market_edge_exec.paper.lifecycle (used by the shadow resolver that produced every R here)", "fee_pct_per_side": lifecycle.FEE_PCT,
              "slippage_pct_per_side": lifecycle.SLIPPAGE_PCT, "re_costed_here": False}
CAP_REASONS = re.compile(r"EXPOSURE_CAP|MAX_CONCURRENT")
CONCENTRATION_WINDOW_MS = 24 * C.HOUR
MIN_SCANS_FOR_A_FINDING = 30


def _mean(xs: list[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def _drawdown(rs: list[float]) -> float:
    peak = eq = worst = 0.0
    for r in rs:
        eq += r
        peak = max(peak, eq)
        worst = max(worst, peak - eq)
    return worst


# ---- loading: only candidates that were valid and resolved ---------------------------------------------------
def load(shadow_db_path: str, *, horizon: str = "72h") -> dict:
    ro = B._ReadOnlyShadow(shadow_db_path)
    with closing(ro._connect()) as conn:
        newest = conn.execute("SELECT MAX(created_at_ms) FROM shadow_observations").fetchone()[0] or 0
    verdicts = {v["subject_id"]: v["verdict"] for v in quality_runner.compute(ro, None, newest) if v["subject_kind"] == quality_runner.SHADOW_OBSERVATION}
    excluded: Counter = Counter()
    rows: list[dict] = []
    with closing(ro._connect()) as conn:
        executed = {r[0] for r in conn.execute("SELECT observation_id FROM forward_paper_executed")}
        for r in conn.execute("SELECT o.*, l.labels AS label_blob FROM shadow_observations o LEFT JOIN shadow_labels l "
                              "ON l.observation_id=o.observation_id AND l.batch=? ORDER BY o.decision_ts, o.observation_id", (C.FINAL_BATCH,)):
            if r["kind"] != C.KIND_CANDIDATE:
                continue
            if not r["research_candidate_valid"]:
                excluded["NOT_RESEARCH_VALID_AT_DECISION_TIME"] += 1
                continue
            if verdicts.get(r["observation_id"]) != K.VALID:
                excluded["DATA_QUALITY_" + str(verdicts.get(r["observation_id"], "NO_VERDICT"))] += 1
                continue
            label = (B._unblob(r["label_blob"]).get(horizon) or {}) if r["label_blob"] else None
            y = (label or {}).get("policy_r")
            if label is None or label.get("label_status") != "OK" or not isinstance(y, (int, float)) or isinstance(y, bool):
                excluded["OUTCOME_UNRESOLVED_OR_NOT_EXECUTABLE"] += 1
                continue
            rows.append({"observation_id": r["observation_id"], "scan_id": r["scan_id"], "asset": r["asset"], "direction": r["direction"], "strategy": r["strategy"],
                         "decision_ts": r["decision_ts"], "rank": r["scan_candidate_rank"], "is_pick": bool(r["is_production_pick"]), "production_rank": r["production_rank"],
                         "cluster": r["observation_cluster_id"], "episode": r["market_episode_id"], "exec_status": r["execution_status"], "reject_reason": r["execution_rejection_reason"],
                         "executed": r["observation_id"] in executed, "r": float(y)})
    return {"rows": rows, "excluded": dict(excluded), "cost_model": COST_MODEL}


def _by_scan(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[r["scan_id"]].append(r)
    return out


def _paired(scans: list[tuple[dict, dict]], bootstrap_n: int, seed: int) -> dict:
    """(a, b) per scan; delta = a.r - b.r, clustered by a's cluster."""
    paired = [{"cluster": a["cluster"], "d": a["r"] - b["r"]} for a, b in scans]
    if not paired:
        return {"scans": 0, "mean_delta_R": None, "ci95": None, "first_wins_share": None, "mean_win_R": None, "mean_loss_R": None}
    ci = S.grouped_bootstrap(paired, lambda p: p["d"], "cluster", n=bootstrap_n, seed=seed) if bootstrap_n > 0 else None
    wins, losses = [p["d"] for p in paired if p["d"] > 0], [p["d"] for p in paired if p["d"] < 0]
    return {"scans": len(paired), "mean_delta_R": _mean([p["d"] for p in paired]), "ci95": ci and ci.get("ci"), "cluster_groups": ci and ci.get("groups"),
            "first_wins_share": len(wins) / len(paired), "ties": len(paired) - len(wins) - len(losses), "mean_win_R": _mean(wins), "mean_loss_R": _mean(losses)}


def _verdict(stat: dict) -> str:
    if stat["scans"] < MIN_SCANS_FOR_A_FINDING:
        return f"NOT_ENOUGH_SCANS: have {stat['scans']}, need {MIN_SCANS_FOR_A_FINDING}"
    ci = stat["ci95"]
    if not ci:
        return "NO_INTERVAL"
    return "FIRST_BETTER" if ci[0] > 0 else "SECOND_BETTER" if ci[1] < 0 else "NO_CLEAR_DIFFERENCE"


# ---- the analyses ---------------------------------------------------------------------------------------------------
def rank_comparison(rows: list[dict], bootstrap_n: int = 1000, seed: int = 7) -> dict:
    """Rank #1 vs #2 and #3 in the same scan, among candidates that were valid and resolved."""
    out: dict[str, Any] = {"mean_R_by_rank": {}}
    by_rank: dict[int, list[float]] = defaultdict(list)
    for r in rows:
        if r["rank"] is not None:
            by_rank[r["rank"]].append(r["r"])
    out["mean_R_by_rank"] = {str(k): {"n": len(v), "mean_R": _mean(v)} for k, v in sorted(by_rank.items()) if k <= 5}
    scans = _by_scan(rows)
    for other in (2, 3):
        pairs = []
        for cands in scans.values():
            first = next((c for c in cands if c["rank"] == 1), None)
            second = next((c for c in cands if c["rank"] == other), None)
            if first and second:
                pairs.append((first, second))
        stat = _paired(pairs, bootstrap_n, seed)
        out[f"rank1_vs_rank{other}"] = {**stat, "verdict": _verdict(stat)}
    return out


def chosen_vs_rejected(rows: list[dict], bootstrap_n: int = 1000, seed: int = 7) -> dict:
    """Where paper execution actually took a trade: its R versus the mean of the scan's other valid resolved candidates, and versus the best of them."""
    scans = _by_scan(rows)
    vs_mean, vs_best, regret = [], [], []
    for cands in scans.values():
        chosen = [c for c in cands if c["executed"]]
        others = [c for c in cands if not c["executed"]]
        if not chosen or not others:
            continue
        c = chosen[0]
        avg = {"cluster": c["cluster"], "r": _mean([o["r"] for o in others])}
        best = max(others, key=lambda o: o["r"])
        vs_mean.append((c, avg))
        vs_best.append((c, best))
        regret.append(max(0.0, best["r"] - c["r"]))
    m, b = _paired(vs_mean, bootstrap_n, seed), _paired(vs_best, bootstrap_n, seed)
    return {"chosen_vs_mean_of_rejected": {**m, "verdict": _verdict(m)}, "chosen_vs_best_rejected": {**b, "verdict": _verdict(b)}, "mean_regret_R": _mean(regret),
            "note": "rejected alternatives are candidates that were valid and resolved at decision time; their R is what the shared cost model gives, not an assertion they would have filled"}


def concentration(rows: list[dict]) -> dict:
    """Among selections paper execution actually took: those that shared an episode or cluster with another selection inside the window, versus the rest,
    and the drawdown of the actual sequence versus a de-concentrated alternative (first selection per episode only)."""
    taken = sorted((r for r in rows if r["executed"]), key=lambda r: (r["decision_ts"], r["observation_id"]))
    flagged = set()
    for i, a in enumerate(taken):
        for b in taken[i + 1:]:
            if b["decision_ts"] - a["decision_ts"] > CONCENTRATION_WINDOW_MS:
                break
            if a["episode"] == b["episode"] or a["cluster"] == b["cluster"]:
                flagged.update((a["observation_id"], b["observation_id"]))
    conc = [r["r"] for r in taken if r["observation_id"] in flagged]
    rest = [r["r"] for r in taken if r["observation_id"] not in flagged]
    seen, dedup = set(), []
    for r in taken:
        if r["episode"] not in seen:
            seen.add(r["episode"])
            dedup.append(r)
    actual = [r["r"] for r in taken]
    return {"selections": len(taken), "concentrated": {"n": len(conc), "mean_R": _mean(conc)}, "not_concentrated": {"n": len(rest), "mean_R": _mean(rest)},
            "actual": {"n": len(actual), "cumulative_R": sum(actual), "max_drawdown_R": _drawdown(actual)},
            "hypothetical_first_per_episode": {"n": len(dedup), "cumulative_R": sum(r["r"] for r in dedup), "max_drawdown_R": _drawdown([r["r"] for r in dedup]),
                                               "note": "HYPOTHETICAL: uses only selections that really were executed, dropping later ones in an already-used episode"},
            "window_hours": CONCENTRATION_WINDOW_MS / C.HOUR, "enough_for_a_finding": len(taken) >= MIN_SCANS_FOR_A_FINDING}


def cap_effect(rows: list[dict]) -> dict:
    """Production picks that execution REJECTED because of an exposure or concurrent-position cap, versus those it took. Informational only."""
    capped = [r for r in rows if r["is_pick"] and r["exec_status"] == "REJECTED" and r["reject_reason"] and CAP_REASONS.search(r["reject_reason"])]
    taken = [r for r in rows if r["executed"]]
    reasons = Counter(r["reject_reason"] for r in capped)
    return {"blocked_by_caps": {"n": len(capped), "mean_R": _mean([r["r"] for r in capped]), "sum_R": sum(r["r"] for r in capped), "reasons": dict(reasons)},
            "taken": {"n": len(taken), "mean_R": _mean([r["r"] for r in taken])},
            "reading": ("HYPOTHETICAL and informational: a positive blocked sum means the caps withheld winners, a negative one that they withheld losers. "
                        "It does not propose changing a cap."),
            "enough_for_a_finding": len(capped) >= MIN_SCANS_FOR_A_FINDING}


def analyse(shadow_db_path: str, *, bootstrap_n: int = 1000, seed: int = 7) -> dict:
    data = load(shadow_db_path)
    rows = data["rows"]
    return {"analysis_version": ANALYSIS_VERSION, "label": LABEL, "cost_model": data["cost_model"], "candidates_used": len(rows), "scans": len(_by_scan(rows)),
            "excluded": data["excluded"], "rank_comparison": rank_comparison(rows, bootstrap_n, seed), "chosen_vs_rejected": chosen_vs_rejected(rows, bootstrap_n, seed),
            "concentration": concentration(rows), "cap_effect": cap_effect(rows),
            "proposes_changes": False, "note": "Findings only. Any change suggested by these numbers must go through DATA 6/7/8/10/11."}


def render_markdown(result: dict) -> str:
    rc, cv, co, ce = result["rank_comparison"], result["chosen_vs_rejected"], result["concentration"], result["cap_effect"]
    lines = [f"# Counterfactual portfolio learning", "", f"**{result['label']}**", "",
             f"{result['candidates_used']} valid, resolved candidates in {result['scans']} scans. Excluded: {result['excluded'] or 'none'}.",
             f"Costs: {result['cost_model']['fee_pct_per_side']:.4%} fee and {result['cost_model']['slippage_pct_per_side']:.4%} slippage per side, taken from the paper lifecycle via the resolver (not re-costed here).", "",
             "## Rank #1 versus #2 and #3"]
    for k in ("rank1_vs_rank2", "rank1_vs_rank3"):
        s = rc[k]
        lines.append(f"- {k}: {s['scans']} scans, mean delta {s['mean_delta_R']}, CI {s['ci95']}, verdict {s['verdict']}")
    lines += ["", "## Chosen versus rejected", f"- chosen vs mean of rejected: {cv['chosen_vs_mean_of_rejected']['verdict']} ({cv['chosen_vs_mean_of_rejected']['scans']} scans)",
              f"- chosen vs best rejected: {cv['chosen_vs_best_rejected']['verdict']}; mean regret {cv['mean_regret_R']}", "",
              "## Concentration", f"- {co['selections']} selections, {co['concentrated']['n']} concentrated; actual max drawdown {co['actual']['max_drawdown_R']:.3f}R vs {co['hypothetical_first_per_episode']['max_drawdown_R']:.3f}R (HYPOTHETICAL de-concentrated)", "",
              "## Caps", f"- blocked by caps: {ce['blocked_by_caps']['n']} picks, sum {ce['blocked_by_caps']['sum_R']:.3f}R (HYPOTHETICAL). {ce['reading']}", "", result["note"]]
    return "\n".join(lines) + "\n"
