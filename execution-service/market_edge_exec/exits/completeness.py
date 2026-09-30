"""Exit-replay linkage and completeness (#119): is a closed paper trade's counterfactual evidence usable by 3H?

3H compares every policy with CURRENT_POLICY on the SAME trades, but it used to accept whatever finalized rows existed. A trade
opened before the exit shadow was installed has no path (or a path that starts hours after entry), so replaying it reproduces the
real outcome for every policy and looks like "adaptive exits changed nothing". That is missing evidence, not a result.

This module is read only. It never edits, deletes, backfills or invents a row. It labels each trade and the pipeline, and hands 3H
only the trades whose path is complete. The evidence bar itself (EXIT-EVIDENCE-BAR-V1) is not touched.

Labels (per trade):
  OPEN              still open: not evidence yet
  LEGACY_UNLINKED   opened before the exit shadow was installed: history is never fabricated
  COMPLETE          path covers entry to close and every registered policy has a finalized replay
  PATH_INCOMPLETE   post-install trade whose path starts late, has a gap, or stops before the close
  REPLAYS_MISSING   path is fine but a registered policy has no finalized replay
Pipeline: RESEARCH_PIPELINE_DEGRADED if any post-install closed trade is neither COMPLETE nor LEGACY_UNLINKED.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from typing import Callable, Optional

from market_edge_exec.exits import policies as pol
from market_edge_exec.exits.model import CANDLE_MS
from market_edge_exec.exits.store import ExitStore

COMPLETENESS_VERSION = "EXIT-PATH-COMPLETENESS-V1"
# Data-plumbing tolerances, declared before looking at any outcome. Real ledgers show ordinary monitor gaps up to ~50 min (app asleep),
# so the gap limit sits above that; the start limit is one candle interval plus a minute.
START_TOLERANCE_MS = CANDLE_MS + 60_000
MAX_GAP_MS = 60 * 60_000
END_TOLERANCE_MS = CANDLE_MS

OPEN, LEGACY, COMPLETE, PATH_INCOMPLETE, REPLAYS_MISSING = "OPEN", "LEGACY_UNLINKED", "COMPLETE", "PATH_INCOMPLETE", "REPLAYS_MISSING"
DEGRADED = "RESEARCH_PIPELINE_DEGRADED"


# A trade is expected to carry the policies of the registry version it was recorded under, not policies added later (Task O's
# structural variants arrived in V2; trades recorded under V1 are not "missing" them).
REGISTRY_ORDER = ["EXIT-POLICIES-V1", "EXIT-POLICIES-V2", "EXIT-POLICIES-V3"]
STUDY_ADDED_IN = {"3O": "EXIT-POLICIES-V2", "3Q": "EXIT-POLICIES-V3"}


def expected_policies(registry, version: Optional[str]) -> list[str]:
    """Registry members that existed in `version`; unknown or missing version means the current registry."""
    if version not in REGISTRY_ORDER:
        return sorted(registry.keys())
    idx = REGISTRY_ORDER.index(version)
    return sorted(name for name, p in registry.items()
                  if REGISTRY_ORDER.index(STUDY_ADDED_IN.get(p.study, REGISTRY_ORDER[0])) <= idx)


def install_time_ms(connect: Callable[[], sqlite3.Connection]) -> Optional[int]:
    """When the exit-shadow schema migration was applied, or None if the ledger does not record it."""
    with closing(connect()) as conn:
        try:
            row = conn.execute("SELECT applied_at FROM schema_history WHERE name='exit_shadow'").fetchone()
        except sqlite3.Error:
            return None
    return int(row[0] * 1000) if row and row[0] is not None else None


def _trades(connect: Callable[[], sqlite3.Connection]) -> list[dict]:
    with closing(connect()) as conn:
        rows = conn.execute("SELECT trade_id, status, opened_at_ms, closed_at_ms, payload FROM paper_trades ORDER BY opened_at_ms").fetchall()
    out = []
    for r in rows:
        payload = json.loads(r[4]) if r[4] else {}
        out.append({"trade_id": r[0], "status": r[1], "opened_at_ms": r[2], "closed_at_ms": r[3], "asset": payload.get("asset")})
    return out


def _known_times(connect: Callable[[], sqlite3.Connection], trade_id: str) -> list[int]:
    with closing(connect()) as conn:
        rows = conn.execute("SELECT at_ms, kind FROM exit_path_observations WHERE trade_id=?", (trade_id,)).fetchall()
    return sorted(int(r[0]) + (CANDLE_MS if r[1] == "CANDLE" else 0) for r in rows)


def classify_path(opened_ms: int, closed_ms: int, known_ms: list[int]) -> list[str]:
    """Reasons a recorded path does not cover entry to close. Empty list = complete."""
    if not known_ms:
        return ["NO_OBSERVATIONS"]
    reasons = []
    if known_ms[0] > opened_ms + START_TOLERANCE_MS:
        reasons.append(f"STARTS_LATE_BY_{(known_ms[0] - opened_ms) // 60_000}MIN")
    inside = [t for t in known_ms if opened_ms <= t <= closed_ms + END_TOLERANCE_MS]
    if inside:
        worst = max((b - a for a, b in zip(inside, inside[1:])), default=0)
        if worst > MAX_GAP_MS:
            reasons.append(f"GAP_OF_{worst // 60_000}MIN")
        if inside[-1] < closed_ms - END_TOLERANCE_MS:
            reasons.append(f"ENDS_{(closed_ms - inside[-1]) // 60_000}MIN_BEFORE_CLOSE")
    else:
        reasons.append("NO_OBSERVATIONS_BETWEEN_ENTRY_AND_CLOSE")
    return reasons


def assess(connect: Callable[[], sqlite3.Connection], registry=pol.REGISTRY, installed_at_ms: Optional[int] = None) -> dict:
    """Label every paper trade and the pipeline. `installed_at_ms` overrides the ledger's own migration time (tests)."""
    store = ExitStore(connect)
    install = installed_at_ms if installed_at_ms is not None else install_time_ms(connect)
    trades = []
    for t in _trades(connect):
        rows = store.load(t["trade_id"])
        finalized = sorted(k for k, v in rows.items() if v["finalized"])
        versions = {v["record"].get("registry_version") for v in rows.values()} - {None}
        recorded = max(versions, key=lambda x: REGISTRY_ORDER.index(x) if x in REGISTRY_ORDER else -1) if versions else None
        expected = expected_policies(registry, recorded)
        missing = [p for p in expected if p not in finalized]
        entry = {"trade_id": t["trade_id"], "asset": t["asset"], "status": t["status"], "expected_replays": len(expected),
                 "registry_version": recorded, "finalized_replays": len(finalized), "missing_policies": missing if t["status"] == "CLOSED" else [], "reasons": []}
        if t["status"] != "CLOSED" or t["closed_at_ms"] is None:
            entry["label"] = OPEN if t["status"] != "CLOSED" else PATH_INCOMPLETE
        elif install is not None and t["opened_at_ms"] < install:
            entry["label"] = LEGACY
            entry["reasons"] = ["OPENED_BEFORE_EXIT_SHADOW_INSTALLED"]
        else:
            reasons = classify_path(t["opened_at_ms"], t["closed_at_ms"], _known_times(connect, t["trade_id"]))
            if reasons:
                entry["label"], entry["reasons"] = PATH_INCOMPLETE, reasons
            elif missing:
                entry["label"], entry["reasons"] = REPLAYS_MISSING, [f"{len(missing)}_OF_{len(expected)}_POLICY_REPLAYS_MISSING"]
            else:
                entry["label"] = COMPLETE
        trades.append(entry)
    degraded = [t for t in trades if t["label"] in (PATH_INCOMPLETE, REPLAYS_MISSING)]
    counts = {k: sum(1 for t in trades if t["label"] == k) for k in (OPEN, LEGACY, COMPLETE, PATH_INCOMPLETE, REPLAYS_MISSING)}
    return {"version": COMPLETENESS_VERSION, "registry_version": pol.POLICY_REGISTRY_VERSION, "expected_policies_current": len(registry),
            "shadow_installed_at_ms": install, "trades": trades, "counts": counts,
            "pipeline_status": DEGRADED if degraded else "OK",
            "degraded_trades": [{"trade_id": t["trade_id"], "label": t["label"], "reasons": t["reasons"],
                                 "missing_policies": t["missing_policies"]} for t in degraded],
            "eligible_trade_ids": sorted(t["trade_id"] for t in trades if t["label"] == COMPLETE),
            "note": "Read only. Legacy and incomplete trades are labelled, never repaired or backfilled, and are excluded from 3H by reason."}


def eligible_records(records: list[dict], report: dict) -> list[dict]:
    keep = set(report["eligible_trade_ids"])
    return [r for r in records if r["trade_id"] in keep]


def evaluate_eligible(connect: Callable[[], sqlite3.Connection], installed_at_ms: Optional[int] = None) -> dict:
    """The unchanged 3H evaluation over complete-path trades only, with the integrity report attached."""
    from market_edge_exec.exits.evaluation import evaluate

    report = assess(connect, installed_at_ms=installed_at_ms)
    result = evaluate(eligible_records(ExitStore(connect).finalized_records(), report))
    result["evidence_integrity"] = {k: report[k] for k in ("version", "pipeline_status", "counts", "degraded_trades", "expected_policies_current")}
    result["evidence_integrity"]["excluded"] = [{"trade_id": t["trade_id"], "label": t["label"], "reasons": t["reasons"]}
                                                for t in report["trades"] if t["label"] in (LEGACY, PATH_INCOMPLETE, REPLAYS_MISSING)]
    return result
