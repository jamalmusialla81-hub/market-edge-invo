"""TASK H (#86): stop-overshoot distribution report, read-only over the paper database.

Reads the `stop_overshoot` record the paper engine writes on every STOP / BREAKEVEN_STOP exit (paper/friction.py) and
summarises it per asset, per detection source and per gap-since-last-observation bucket. It changes nothing and feeds
nothing: Risk Sizing V2 is untouched, and no expected-overshoot number is proposed until enough real exits exist
(MIN_EXITS) and a separately authorised task cites this report.

    python -m market_edge_exec.analysis.stop_overshoot <paper.sqlite3> [--json]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from contextlib import closing
from typing import Optional

REPORT_VERSION = "STOP-OVERSHOOT-REPORT-V1"
MIN_EXITS = 30            # below this a distribution is shown for inspection only, never as an estimate
GAP_BUCKETS_MS = (("<=10s", 10_000), ("10s-60s", 60_000), ("60s-5m", 300_000), (">5m", math.inf))


def _quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def _stats(rows: list[dict]) -> dict:
    observed = [r for r in rows if r.get("observed") and isinstance(r.get("overshoot_bps"), (int, float))]
    bps = [r["overshoot_bps"] for r in observed]
    rs = [r["overshoot_R"] for r in observed if isinstance(r.get("overshoot_R"), (int, float))]
    out = {"exits": len(rows), "observed": len(observed), "not_observed": len(rows) - len(observed),
           "with_overshoot": sum(1 for v in bps if v > 0), "estimate_allowed": len(observed) >= MIN_EXITS}
    if bps:
        out.update({"overshoot_bps": {"median": _quantile(bps, .5), "p90": _quantile(bps, .9), "max": max(bps)},
                    "overshoot_R": {"median": _quantile(rs, .5), "p90": _quantile(rs, .9), "max": max(rs)} if rs else None,
                    "share_with_overshoot": out["with_overshoot"] / len(bps)})
    return out


def _bucket(ms: Optional[int]) -> str:
    if not isinstance(ms, (int, float)):
        return "unknown"
    return next(label for label, top in GAP_BUCKETS_MS if ms <= top)


def collect(paper_db: str) -> tuple[list[dict], int]:
    """Every stop exit with its record, plus the count of stop exits that predate the record (never back-filled)."""
    uri = "file:" + os.path.abspath(paper_db).replace(os.sep, "/") + "?mode=ro"
    rows, legacy = [], 0
    with closing(sqlite3.connect(uri, uri=True)) as conn:
        for trade_id, payload in conn.execute("SELECT trade_id, payload FROM paper_trades ORDER BY opened_at_ms, trade_id"):
            trade = json.loads(payload)
            for ex in trade.get("exits") or []:
                if ex.get("kind") not in ("STOP", "BREAKEVEN_STOP"):
                    continue
                record = ex.get("stop_overshoot")
                if record is None:
                    legacy += 1
                    continue
                rows.append({**record, "trade_id": trade_id, "asset": trade.get("asset") or trade.get("coin")})
    return rows, legacy


def report(paper_db: str) -> dict:
    rows, legacy = collect(paper_db)
    groups = {"asset": {}, "detection_source": {}, "gap_since_last_observation": {}}
    for r in rows:
        groups["asset"].setdefault(r["asset"], []).append(r)
        groups["detection_source"].setdefault(r["detection_source"], []).append(r)
        groups["gap_since_last_observation"].setdefault(_bucket(r.get("time_since_last_observation_ms")), []).append(r)
    return {"version": REPORT_VERSION, "min_exits_for_an_estimate": MIN_EXITS, "overall": _stats(rows), "legacy_stop_exits_without_record": legacy,
            "by": {k: {name: _stats(v) for name, v in sorted(g.items())} for k, g in groups.items()},
            "note": "Descriptive only. Volatility, liquidity and stop-distance dependence need far more exits than exist; no estimate is offered below the floor."}


def render_markdown(rep: dict) -> str:
    o = rep["overall"]
    lines = [f"# Stop overshoot report ({rep['version']})", "", f"Stop exits with a record: **{o['exits']}** (observed past the stop: {o['observed']}, "
             f"with any overshoot: {o['with_overshoot']}); older stop exits without a record: {rep['legacy_stop_exits_without_record']}.", ""]
    if not o["estimate_allowed"]:
        lines += [f"Fewer than {rep['min_exits_for_an_estimate']} observed exits: shown for inspection only, not an estimate.", ""]
    for title, groups in rep["by"].items():
        lines += [f"## by {title}", "", "| group | exits | observed | with overshoot | median bps | p90 bps | max bps |", "|---|---|---|---|---|---|---|"]
        for name, s in groups.items():
            b = s.get("overshoot_bps") or {}
            lines.append(f"| {name} | {s['exits']} | {s['observed']} | {s['with_overshoot']} | " + " | ".join(f"{b[k]:.1f}" if k in b else "n/a" for k in ("median", "p90", "max")) + " |")
        lines.append("")
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Read-only stop-overshoot distribution report (TASK H).")
    ap.add_argument("paper_db")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    rep = report(args.paper_db)
    print(json.dumps(rep, indent=2, sort_keys=True) if args.json else render_markdown(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
