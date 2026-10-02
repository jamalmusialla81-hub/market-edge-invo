"""Exit policy evaluation (MAJOR 3H): the evidence gate.

Reads finalized counterfactuals (3G) and, for each candidate policy, compares it
with CURRENT_POLICY on the SAME trades. Trades cluster in time and market
conditions, so uncertainty comes from a CLUSTER bootstrap (whole episodes are
resampled), never a per-trade one. The bar is declared here, up front, and the
verdict is per policy and per criterion: no policy is ever ranked on one scalar,
and this module only produces evidence. It promotes nothing and no code reads
its verdict to change behaviour (that is MAJOR 4, a separate human decision).
"""
from __future__ import annotations

import random
from collections import defaultdict
from typing import Optional

from market_edge_exec.exits.policies import BASELINE

EVIDENCE_BAR_V1 = {
    "version": "EXIT-EVIDENCE-BAR-V1",
    "primary_metric": "mean per-trade paired difference in after-cost R (policy minus CURRENT_POLICY, same trades)",
    "why_primary": "It is the change in what a trade actually earns after fees and slippage, measured on identical price paths; "
                   "giveback reduction is reported alongside but can be bought with premature exits, so it cannot be the gate.",
    "confidence": 0.95,
    "bootstrap_resamples": 4000,
    "cluster_hours": 24,                 # trades opened within the same UTC-aligned 24h window are one episode
    "min_independent_episodes": 30,      # fewer episodes than this -> INSUFFICIENT_EVIDENCE, never a verdict
    "min_trades": 30,
    "ci_lower_must_exceed": 0.0,         # the cluster-bootstrap CI of the primary metric must exclude zero improvement
    "tail_tolerance_R": 0.10,            # 5th-percentile R may be at most this much worse than CURRENT's
    "drawdown_tolerance_R": 0.50,        # max drawdown of cumulative R may be at most this much worse
    "max_premature_exit_rate": 0.40,
    "premature_margin_R": 0.10,          # an intervention is premature if the real trade then finished this much better
    "bucket_min_trades": 10,
    "bucket_harm_R": 0.20,               # no bucket (asset / direction / regime / TP1 status) may average this much worse
    "seed": 20260929,
}
POLICY_EXITS = ("POLICY_STOP", "POLICY_EXIT", "POLICY_PARTIAL")


def percentile(values: list, q: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    pos = q * (len(s) - 1)
    lo, hi = int(pos), min(int(pos) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def cluster_id(opened_at_ms: int, hours: int) -> int:
    return int(opened_at_ms // (hours * 3_600_000))


def cluster_bootstrap_ci(values: list, clusters: list, resamples: int, confidence: float, seed: int) -> tuple[Optional[float], Optional[float]]:
    """Percentile CI of the mean, resampling whole clusters with replacement."""
    groups: dict = defaultdict(list)
    for v, c in zip(values, clusters):
        groups[c].append(v)
    sums = [(sum(g), len(g)) for g in groups.values()]
    if len(sums) < 2:
        return None, None
    rng = random.Random(seed)
    n = len(sums)
    means = []
    for _ in range(resamples):
        picked = [sums[rng.randrange(n)] for _ in range(n)]
        total, count = sum(p[0] for p in picked), sum(p[1] for p in picked)
        means.append(total / count)
    tail = (1.0 - confidence) / 2.0
    return percentile(means, tail), percentile(means, 1.0 - tail)


def max_drawdown(values_in_time_order: list) -> float:
    peak = cum = worst = 0.0
    for v in values_in_time_order:
        cum += v
        peak = max(peak, cum)
        worst = max(worst, peak - cum)
    return worst


def _tercile_edges(values: list) -> tuple[float, float]:
    return percentile(values, 1 / 3), percentile(values, 2 / 3)


def _regime(value: float, edges: tuple) -> str:
    return "LOW_VOL" if value <= edges[0] else ("MID_VOL" if value <= edges[1] else "HIGH_VOL")


def _mean(values: list) -> Optional[float]:
    return sum(values) / len(values) if values else None


def _breakdown(rows: list, key) -> dict:
    groups: dict = defaultdict(list)
    for r in rows:
        groups[key(r)].append(r["delta_R"])
    return {str(k): {"trades": len(v), "mean_delta_R": _mean(v)} for k, v in sorted(groups.items(), key=lambda kv: str(kv[0]))}


def evaluate(records: list[dict], bar: dict = EVIDENCE_BAR_V1) -> dict:
    """`records` are finalized counterfactual records (ExitStore.finalized_records())."""
    by_trade: dict = defaultdict(dict)
    for r in records:
        if r.get("status") == "EXITED":
            by_trade[r["trade_id"]][r["policy_version"]] = r
    trades = {t: p for t, p in by_trade.items() if BASELINE in p}
    edges = _tercile_edges([p[BASELINE]["stop_distance_pct"] for p in trades.values()]) if trades else (0.0, 0.0)
    policy_names = sorted({name for p in trades.values() for name in p if name != BASELINE})
    results = {}
    for name in policy_names:
        rows = []
        for trade_id, p in sorted(trades.items(), key=lambda kv: kv[1][BASELINE]["opened_at_ms"]):
            if name not in p:
                continue
            base, cf = p[BASELINE], p[name]
            rows.append({
                "trade_id": trade_id, "R": cf["counterfactual_R"], "base_R": base["counterfactual_R"],
                "delta_R": cf["counterfactual_R"] - base["counterfactual_R"], "giveback": cf["giveback_R"],
                "base_giveback": base["giveback_R"], "cluster": cluster_id(base["opened_at_ms"], bar["cluster_hours"]),
                "asset": base.get("asset"), "direction": base.get("direction"),
                "regime": _regime(base["stop_distance_pct"], edges), "tp1": "AFTER_TP1" if cf.get("tp1_hit") else "BEFORE_TP1",
                "tp2": any(e["kind"] == "TP2" for e in cf["events"]), "base_tp2": any(e["kind"] == "TP2" for e in base["events"]),
                "policy_exit": cf.get("reason") in POLICY_EXITS, "real_R": cf.get("real_R"),
            })
        n, clusters = len(rows), len({r["cluster"] for r in rows})
        r_pol, r_base = [r["R"] for r in rows], [r["base_R"] for r in rows]
        deltas = [r["delta_R"] for r in rows]
        lo, hi = cluster_bootstrap_ci(deltas, [r["cluster"] for r in rows], bar["bootstrap_resamples"], bar["confidence"], bar["seed"])
        premature = [r for r in rows if r["policy_exit"] and r["real_R"] is not None and r["real_R"] - r["R"] >= bar["premature_margin_R"]]
        interventions = [r for r in rows if abs(r["delta_R"]) > 1e-12]
        metrics = {
            "trades": n, "independent_episodes": clusters,
            "mean_R": _mean(r_pol), "median_R": percentile(r_pol, 0.5), "p05_R": percentile(r_pol, 0.05),
            "win_rate": _mean([1.0 if x > 0 else 0.0 for x in r_pol]), "max_drawdown_R": max_drawdown(r_pol),
            "mean_giveback_R": _mean([r["giveback"] for r in rows]), "tp2_capture_rate": _mean([1.0 if r["tp2"] else 0.0 for r in rows]),
            "premature_exit_rate": len(premature) / n if n else None, "intervention_rate": len(interventions) / n if n else None,
            "baseline": {"mean_R": _mean(r_base), "median_R": percentile(r_base, 0.5), "p05_R": percentile(r_base, 0.05),
                         "max_drawdown_R": max_drawdown(r_base), "mean_giveback_R": _mean([r["base_giveback"] for r in rows]),
                         "tp2_capture_rate": _mean([1.0 if r["base_tp2"] else 0.0 for r in rows])},
            "delta_mean_R": _mean(deltas), "delta_ci": [lo, hi],
            # Early-exit regret (#121), per trade against CURRENT_POLICY on the same path. Reported next to the gate, never a substitute for it:
            # a policy that saves small losses by sacrificing rare big winners shows a large upside_sacrificed_R and cannot hide behind the mean.
            "early_exit_regret": {"profit_saved_R": _mean([max(d, 0.0) for d in deltas]), "upside_sacrificed_R": _mean([max(-d, 0.0) for d in deltas]),
                                  "net_exit_value_R": _mean(deltas), "worst_single_sacrifice_R": max([-d for d in deltas], default=None)},
            "breakdown": {"asset": _breakdown(rows, lambda r: r["asset"]), "direction": _breakdown(rows, lambda r: r["direction"]),
                          "volatility_regime": _breakdown(rows, lambda r: r["regime"]), "tp1_status": _breakdown(rows, lambda r: r["tp1"])},
        }
        results[name] = {**metrics, **_verdict(metrics, bar)}
    return {"evidence_bar": bar, "baseline": BASELINE, "trades_with_baseline": len(trades),
            "independent_episodes": len({cluster_id(p[BASELINE]["opened_at_ms"], bar["cluster_hours"]) for p in trades.values()}),
            "volatility_regime_edges_stop_distance_pct": list(edges), "policies": results,
            "promotion": "NONE. This report is evidence only; promotion is MAJOR 4, a separate human-authorised decision."}


def _verdict(m: dict, bar: dict) -> dict:
    if m["trades"] < bar["min_trades"] or m["independent_episodes"] < bar["min_independent_episodes"] or m["delta_ci"][0] is None:
        return {"verdict": "INSUFFICIENT_EVIDENCE", "checks": {},
                "reason": f"{m['trades']} trades / {m['independent_episodes']} independent episodes; the bar needs at least "
                          f"{bar['min_trades']} / {bar['min_independent_episodes']}. Re-run after more forward data accumulates."}
    base = m["baseline"]
    harmed = [f"{dim}={k}" for dim, groups in m["breakdown"].items() for k, g in groups.items()
              if g["trades"] >= bar["bucket_min_trades"] and g["mean_delta_R"] < -bar["bucket_harm_R"]]
    checks = {
        "primary_ci_excludes_zero": m["delta_ci"][0] > bar["ci_lower_must_exceed"],
        "tail_not_worse": m["p05_R"] >= base["p05_R"] - bar["tail_tolerance_R"],
        "drawdown_not_worse": m["max_drawdown_R"] <= base["max_drawdown_R"] + bar["drawdown_tolerance_R"],
        "premature_exit_rate_ok": (m["premature_exit_rate"] or 0.0) <= bar["max_premature_exit_rate"],
        "no_bucket_materially_harmed": not harmed,
    }
    failed = [k for k, v in checks.items() if not v]
    return {"verdict": "PASS" if not failed else "FAIL", "checks": checks, "failed_checks": failed, "harmed_buckets": harmed}


def render_markdown(result: dict) -> str:
    bar = result["evidence_bar"]
    lines = ["# Exit policy evaluation (generated)", "",
             f"Evidence bar `{bar['version']}`. Primary metric: {bar['primary_metric']}.", "",
             f"Trades with a finalized CURRENT_POLICY baseline: **{result['trades_with_baseline']}** in "
             f"**{result['independent_episodes']}** independent {bar['cluster_hours']}h episodes "
             f"(the bar needs at least {bar['min_trades']} trades and {bar['min_independent_episodes']} episodes).", "",
             "| policy | verdict | trades | episodes | mean R | ΔR vs CURRENT | 95% cluster CI | p05 R | premature |",
             "|---|---|---|---|---|---|---|---|---|"]
    fmt = lambda v: "n/a" if v is None else f"{v:.3f}"
    for name, m in result["policies"].items():
        ci = f"[{fmt(m['delta_ci'][0])}, {fmt(m['delta_ci'][1])}]"
        lines.append(f"| {name} | {m['verdict']} | {m['trades']} | {m['independent_episodes']} | {fmt(m['mean_R'])} | "
                     f"{fmt(m['delta_mean_R'])} | {ci} | {fmt(m['p05_R'])} | {fmt(m['premature_exit_rate'])} |")
    if not result["policies"]:
        lines.append("| (no finalized counterfactuals yet) | INSUFFICIENT_EVIDENCE | 0 | 0 | | | | | |")
    lines += ["", f"**Promotion:** {result['promotion']}"]
    return "\n".join(lines) + "\n"
