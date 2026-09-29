"""MAJOR 6-pre (#70): Risk Sizing V2 forward comparison harness, the code MAJOR 6 (#27) runs once data exists.

Reads the paper ledger READ-ONLY. For every closed trade executed while `RISK_SIZING_V2_MODE=SHADOW`, the legacy
engine's AUTHORITATIVE sizing record and V2's COUNTERFACTUAL record were written at the same instant against the same
entry, stop and equity, and the trade then ran one price path. So the two sizings are compared on identical trades:

    V2 counterfactual net P&L = realised net P&L * (V2 quantity / legacy quantity)

That is exact for the paper engine (entry and exit fills are price-based slippage, partial exits are a fixed fraction of
the original quantity, fees are price * quantity * rate), up to 8dp rounding. A trade V2 would have rejected counts as
0 for V2, never dropped. A record whose stored hash does not match its body is excluded and counted, never used.

The bar is declared here up front and mirrors MAJOR 3H's (same 30 trades / 30 independent 24h episodes floor, same
cluster bootstrap). The verdict is evidence plus a recommendation only: nothing reads it to change a mode. Flipping
`RISK_SIZING_V2_MODE` to PAPER is a separate, human-authorised action (#27 OUT OF SCOPE).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from contextlib import closing
from typing import Optional

from market_edge_exec.exits.evaluation import cluster_bootstrap_ci, cluster_id, max_drawdown, percentile

REVIEW_VERSION = "SIZING-REVIEW-V1"
LABEL = "RESEARCH ONLY · EVIDENCE + RECOMMENDATION · NEVER CHANGES RISK_SIZING_V2_MODE · NO ORDERS"

SIZING_EVIDENCE_BAR_V1 = {
    "version": "SIZING-EVIDENCE-BAR-V1",
    "primary_metric": "stop overshoot rate: share of losing trades whose realised loss exceeded that sizing's own planned loss",
    "why_primary": "V2 exists to make the planned loss the real worst case (execution costs inside the budget). Return is "
                   "checked for non-inferiority, not maximised: V2 deliberately risks less, so it should earn less in "
                   "magnitude when the strategy wins, and that alone is not a failure.",
    "confidence": 0.95,
    "bootstrap_resamples": 4000,
    "cluster_hours": 24,                        # same episode definition as MAJOR 3H
    "min_trades": 30,
    "min_independent_episodes": 30,
    "max_v2_overshoot_rate": 0.10,              # V2's own planned loss may be exceeded on at most 10% of its losing trades
    "return_non_inferiority_pct_equity": 0.10,  # cluster-CI lower bound of (V2 - legacy) per-trade return >= -0.10% of equity
    "drawdown_tolerance_pct_equity": 0.0,       # V2's max drawdown may not be worse than legacy's
    "tail_tolerance_pct_equity": 0.0,           # V2's 5th-percentile per-trade return may not be worse than legacy's
    "seed": 20260929,
}

PAIR_MODE = "SHADOW"   # only SHADOW has both a legacy authoritative and a V2 counterfactual record per trade


def _connect_ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def load_pairs(ledger_path: str) -> dict:
    """Pair legacy + V2 sizing records with each trade's outcome. Returns pairs and exclusion counts."""
    excluded: Counter = Counter()
    with closing(_connect_ro(ledger_path)) as conn:
        if not (_has_table(conn, "risk_sizing_decisions") and _has_table(conn, "risk_sizing_outcomes")):
            return {"pairs": [], "excluded": {"NO_SIZING_TABLES": 1}, "decisions": 0, "outcomes": 0}
        decisions = conn.execute("SELECT signal_id, mode, role, record, record_hash, created_at_ms FROM risk_sizing_decisions "
                                 "ORDER BY created_at_ms, decision_id").fetchall()
        outcomes = {r["signal_id"]: json.loads(r["record"]) for r in conn.execute("SELECT signal_id, record FROM risk_sizing_outcomes")}
    by_signal: dict = defaultdict(dict)
    for d in decisions:
        if hashlib.sha256(d["record"].encode()).hexdigest() != d["record_hash"]:
            excluded["RECORD_HASH_MISMATCH"] += 1
            continue
        by_signal[d["signal_id"]].setdefault(d["role"], (d["mode"], json.loads(d["record"])))
    pairs = []
    for sid, roles in by_signal.items():
        auth, cf = roles.get("AUTHORITATIVE"), roles.get("COUNTERFACTUAL")
        if auth is None:
            excluded["NOT_EXECUTED"] += 1          # rejected before execution: no trade, nothing to compare
            continue
        if auth[0] != PAIR_MODE or cf is None:
            excluded[f"MODE_{auth[0]}_NO_COUNTERFACTUAL"] += 1
            continue
        outcome = outcomes.get(sid)
        if outcome is None:
            excluded["OPEN_OR_UNRESOLVED"] += 1      # never train or judge on unresolved outcomes
            continue
        legacy, v2 = auth[1], cf[1]
        legacy_qty = float(legacy.get("final_quantity") or 0.0)
        if legacy_qty <= 0 or outcome.get("realised_net_pnl") is None:
            excluded["INVALID_LEGACY_RECORD"] += 1
            continue
        pairs.append(_pair(sid, legacy, v2, outcome))
    pairs.sort(key=lambda p: (p["opened_at_ms"], p["signal_id"]))
    return {"pairs": pairs, "excluded": dict(excluded), "decisions": len(decisions), "outcomes": len(outcomes)}


def _pair(sid: str, legacy: dict, v2: dict, outcome: dict) -> dict:
    equity = float(legacy.get("wallet_equity") or v2.get("wallet_equity") or 0.0)
    legacy_qty = float(legacy["final_quantity"])
    v2_approved = bool(v2.get("approved"))
    v2_qty = float(v2.get("final_quantity") or 0.0) if v2_approved else 0.0
    scale = v2_qty / legacy_qty
    legacy_net = float(outcome["realised_net_pnl"])
    v2_net = legacy_net * scale
    legacy_planned = float(legacy.get("planned_loss_dollars") or 0.0)
    v2_planned = float(v2.get("planned_loss_dollars") or 0.0) if v2_approved else 0.0

    def pct(x: float) -> Optional[float]:
        return x / equity * 100.0 if equity > 0 else None

    def overshoot(net: float, planned: float) -> Optional[bool]:
        if net >= 0 or planned <= 0:
            return None                                  # only a losing trade can overshoot its plan
        return -net > planned * (1 + 1e-9)

    return {
        "signal_id": sid, "asset": legacy.get("asset") or v2.get("asset"), "direction": legacy.get("direction"),
        "opened_at_ms": int(legacy.get("timestamp") or 0), "exit_reason": outcome.get("exit_reason"),
        "wallet_equity": equity, "legacy_qty": legacy_qty, "v2_qty": v2_qty, "size_ratio": scale,
        "v2_approved": v2_approved, "v2_rejection_reason": None if v2_approved else v2.get("rejection_reason"),
        "legacy_net": legacy_net, "v2_net": v2_net, "legacy_ret_pct": pct(legacy_net), "v2_ret_pct": pct(v2_net),
        "legacy_planned": legacy_planned, "v2_planned": v2_planned,
        "legacy_planned_pct": pct(legacy_planned), "v2_planned_pct": pct(v2_planned),
        "legacy_loss_vs_planned": (-legacy_net / legacy_planned) if legacy_net < 0 and legacy_planned > 0 else None,
        "v2_loss_vs_planned": (-v2_net / v2_planned) if v2_net < 0 and v2_planned > 0 else None,
        "legacy_overshoot": overshoot(legacy_net, legacy_planned), "v2_overshoot": overshoot(v2_net, v2_planned),
        "legacy_binding": legacy.get("sizing_binding_constraint"), "v2_binding": v2.get("sizing_binding_constraint"),
        "v2_vol_multiplier": v2.get("vol_multiplier"), "v2_drawdown_multiplier": v2.get("drawdown_multiplier"),
        "v2_risk_budget": v2.get("risk_budget_dollars"), "cluster_id": v2.get("cluster_id") or legacy.get("cluster_id"),
        "v2_cluster_cap_applied": bool(v2.get("cluster_cap_applied")),
    }


def _mean(values: list) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def _rate(flags: list) -> Optional[float]:
    vals = [f for f in flags if f is not None]
    return sum(1 for f in vals if f) / len(vals) if vals else None


def _side(pairs: list, who: str) -> dict:
    rets = [p[f"{who}_ret_pct"] for p in pairs if p[f"{who}_ret_pct"] is not None]
    losers = [p for p in pairs if p[f"{who}_overshoot"] is not None]
    return {
        "total_net_pnl": sum(p[f"{who}_net"] for p in pairs),
        "mean_return_pct_equity": _mean(rets), "p05_return_pct_equity": percentile(rets, 0.05),
        "max_drawdown_pct_equity": max_drawdown(rets),
        "mean_planned_loss_pct_equity": _mean([p[f"{who}_planned_pct"] for p in pairs if p[f"{who}_planned"] > 0]),
        "losing_trades": len(losers), "overshoot_rate": _rate([p[f"{who}_overshoot"] for p in pairs]),
        "mean_loss_vs_planned": _mean([p[f"{who}_loss_vs_planned"] for p in pairs]),
        "max_loss_vs_planned": max([p[f"{who}_loss_vs_planned"] for p in pairs if p[f"{who}_loss_vs_planned"] is not None], default=None),
        "binding_constraints": dict(Counter(str(p[f"{who}_binding"]) for p in pairs if who == "legacy" or p["v2_approved"])),
    }


def _concentration(pairs: list, who: str) -> dict:
    by_cluster: dict = defaultdict(float)
    for p in pairs:
        by_cluster[str(p["cluster_id"])] += p[f"{who}_planned"]
    total = sum(by_cluster.values())
    shares = {k: v / total for k, v in sorted(by_cluster.items())} if total > 0 else {}
    return {"planned_risk_share_by_cluster": shares, "max_cluster_share": max(shares.values(), default=None)}


def review(ledger_path: str, bar: dict = SIZING_EVIDENCE_BAR_V1) -> dict:
    loaded = load_pairs(ledger_path)
    pairs = loaded["pairs"]
    clusters = [cluster_id(p["opened_at_ms"], bar["cluster_hours"]) for p in pairs]
    deltas = [(p["v2_ret_pct"] or 0.0) - (p["legacy_ret_pct"] or 0.0) for p in pairs]
    lo, hi = cluster_bootstrap_ci(deltas, clusters, bar["bootstrap_resamples"], bar["confidence"], bar["seed"])
    ratios = [p["size_ratio"] for p in pairs if p["v2_approved"]]
    approved = [p for p in pairs if p["v2_approved"]]
    by_asset: dict = defaultdict(list)
    for p, d in zip(pairs, deltas):
        by_asset[str(p["asset"])].append(d)
    metrics = {
        "trades": len(pairs), "independent_episodes": len(set(clusters)),
        "legacy": _side(pairs, "legacy"), "v2": _side(pairs, "v2"),
        "delta_mean_return_pct_equity": _mean(deltas), "delta_ci": [lo, hi],
        "v2_rejected_trades": len(pairs) - len(approved),
        "v2_rejections_by_reason": dict(Counter(str(p["v2_rejection_reason"]) for p in pairs if not p["v2_approved"])),
        "size_ratio": {"median": percentile(ratios, 0.5), "p10": percentile(ratios, 0.1), "p90": percentile(ratios, 0.9),
                       "v2_smaller_share": _rate([r < 1 for r in ratios]), "v2_larger_share": _rate([r > 1 for r in ratios])},
        "under_over_risk": {
            "mean_planned_ratio_v2_over_legacy": _mean([p["v2_planned"] / p["legacy_planned"] for p in approved if p["legacy_planned"] > 0]),
            "v2_planned_below_budget_share": _rate([p["v2_planned"] < (p["v2_risk_budget"] or 0) * (1 - 1e-6) for p in approved
                                                    if p["v2_risk_budget"]]),
        },
        "reductions": {
            "volatility_reduced_share": _rate([(p["v2_vol_multiplier"] or 1.0) < 1.0 for p in approved]),
            "mean_vol_multiplier": _mean([p["v2_vol_multiplier"] for p in approved]),
            "drawdown_reduced_share": _rate([(p["v2_drawdown_multiplier"] or 1.0) < 1.0 for p in approved]),
            "cluster_cap_applied_share": _rate([p["v2_cluster_cap_applied"] for p in approved]),
        },
        "concentration": {"legacy": _concentration(pairs, "legacy"), "v2": _concentration(pairs, "v2")},
        "breakdown_by_asset": {k: {"trades": len(v), "mean_delta_return_pct_equity": _mean(v)} for k, v in sorted(by_asset.items())},
    }
    return {"version": REVIEW_VERSION, "label": LABEL, "evidence_bar": bar, "ledger_counts": {
                "sizing_decisions": loaded["decisions"], "sizing_outcomes": loaded["outcomes"], "excluded": loaded["excluded"]},
            **metrics, **_verdict(metrics, bar),
            "promotion": "NONE. A PASS is a recommendation; switching RISK_SIZING_V2_MODE to PAPER is a separate owner-authorised action."}


def _verdict(m: dict, bar: dict) -> dict:
    if m["trades"] < bar["min_trades"] or m["independent_episodes"] < bar["min_independent_episodes"] or m["delta_ci"][0] is None:
        return {"verdict": "INSUFFICIENT_EVIDENCE", "recommendation": "NOT YET: re-run after more forward SHADOW trades close.",
                "checks": {}, "failed_checks": [],
                "reason": f"{m['trades']} closed SHADOW trades / {m['independent_episodes']} independent episodes; the bar needs at "
                          f"least {bar['min_trades']} / {bar['min_independent_episodes']}."}
    leg, v2 = m["legacy"], m["v2"]
    checks = {
        "v2_overshoot_within_cap": v2["overshoot_rate"] is not None and v2["overshoot_rate"] <= bar["max_v2_overshoot_rate"],
        "v2_overshoot_not_worse_than_legacy": (v2["overshoot_rate"] or 0.0) <= (leg["overshoot_rate"] or 0.0),
        "return_non_inferior": m["delta_ci"][0] >= -bar["return_non_inferiority_pct_equity"],
        "drawdown_not_worse": v2["max_drawdown_pct_equity"] <= leg["max_drawdown_pct_equity"] + bar["drawdown_tolerance_pct_equity"],
        "tail_not_worse": v2["p05_return_pct_equity"] >= leg["p05_return_pct_equity"] - bar["tail_tolerance_pct_equity"],
    }
    failed = [k for k, v in checks.items() if not v]
    return {"verdict": "PASS" if not failed else "FAIL", "checks": checks, "failed_checks": failed,
            "recommendation": ("Evidence supports proposing RISK_SIZING_V2_MODE=PAPER to the owner." if not failed
                               else "Keep RISK_SIZING_V2_MODE=SHADOW; failed: " + ", ".join(failed) + ".")}


def render_markdown(r: dict) -> str:
    fmt = lambda v, d=3: "n/a" if v is None else f"{v:.{d}f}"
    bar, leg, v2 = r["evidence_bar"], r["legacy"], r["v2"]
    lines = [f"# Risk Sizing V2 forward review (generated, {r['version']})", "", f"_{r['label']}_", "",
             f"Evidence bar `{bar['version']}`. Primary metric: {bar['primary_metric']}.", "",
             f"Closed SHADOW trades compared: **{r['trades']}** in **{r['independent_episodes']}** independent "
             f"{bar['cluster_hours']}h episodes (the bar needs {bar['min_trades']} / {bar['min_independent_episodes']}).",
             f"Ledger: {r['ledger_counts']['sizing_decisions']} sizing decisions, {r['ledger_counts']['sizing_outcomes']} outcomes, "
             f"excluded {r['ledger_counts']['excluded'] or 'none'}.", "",
             f"**Verdict: {r['verdict']}.** {r['recommendation']}", "",
             "| metric | legacy | V2 counterfactual |", "|---|---|---|",
             f"| total net P&L | {fmt(leg['total_net_pnl'], 2)} | {fmt(v2['total_net_pnl'], 2)} |",
             f"| mean return per trade (% equity) | {fmt(leg['mean_return_pct_equity'])} | {fmt(v2['mean_return_pct_equity'])} |",
             f"| p05 return per trade (% equity) | {fmt(leg['p05_return_pct_equity'])} | {fmt(v2['p05_return_pct_equity'])} |",
             f"| max drawdown (% equity, summed) | {fmt(leg['max_drawdown_pct_equity'])} | {fmt(v2['max_drawdown_pct_equity'])} |",
             f"| mean planned loss (% equity) | {fmt(leg['mean_planned_loss_pct_equity'])} | {fmt(v2['mean_planned_loss_pct_equity'])} |",
             f"| stop overshoot rate (losers) | {fmt(leg['overshoot_rate'])} ({leg['losing_trades']}) | {fmt(v2['overshoot_rate'])} ({v2['losing_trades']}) |",
             f"| max loss / planned | {fmt(leg['max_loss_vs_planned'])} | {fmt(v2['max_loss_vs_planned'])} |", "",
             f"Paired Δ return (V2 − legacy, % equity per trade): {fmt(r['delta_mean_return_pct_equity'])}, "
             f"{int(bar['confidence'] * 100)}% cluster CI [{fmt(r['delta_ci'][0])}, {fmt(r['delta_ci'][1])}].",
             f"V2 would have rejected {r['v2_rejected_trades']} of these trades: {r['v2_rejections_by_reason'] or 'none'}.",
             f"Binding caps, legacy: {leg['binding_constraints'] or 'none'}; V2: {v2['binding_constraints'] or 'none'}.", ""]
    if r["checks"]:
        lines += ["| check | result |", "|---|---|"] + [f"| {k} | {'pass' if v else 'FAIL'} |" for k, v in r["checks"].items()] + [""]
    lines.append(f"**Promotion:** {r['promotion']}")
    return "\n".join(lines) + "\n"


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Risk Sizing V2 forward review (read-only). " + LABEL)
    ap.add_argument("ledger", help="path to market_edge_paper.sqlite3 (opened read-only)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of markdown")
    args = ap.parse_args(argv)
    result = review(args.ledger)
    sys.stdout.write(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n" if args.json else render_markdown(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
