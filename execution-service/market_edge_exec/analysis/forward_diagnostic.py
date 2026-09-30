"""MAJOR 5-pre (#72): forward data diagnostic harness, the code MAJOR 5 (#26) runs on the owner's backup.

EVIDENCE AND UNCERTAINTY ONLY. No promotion recommendation, no threshold, ranking or generator change; a finding that looks
actionable is filed as a new task, never acted on here.

Every number carries its sample size, its independent-cluster count and a cluster-bootstrap interval. Rows are never the unit
of evidence: nearby shadow observations share most of their future window, so whole clusters are resampled (shadow.stats).

Inputs, all opened read-only:
  - the shadow research DB: candidates via DATA 18's `portfolio.load` (research-valid at decision time, data-quality VALID and
    final outcome resolved OK, with the resolver's after-cost 72h `policy_r`; nothing is re-costed here), and MARKET_STATE
    observations with their hindsight classification for the no-trade question;
  - optionally the paper ledger, for MAJOR 3G/3H exit-policy counterfactuals (`exits.evaluation`, unchanged).

Placebo: each two-group comparison gets a cluster-level permutation test (group labels shuffled between whole clusters, so the
null keeps the correlation structure). The method itself is calibrated on the same data: the share of label-permuted datasets
on which the comparison's interval excludes zero is its false-positive rate, and it is reported, not assumed.
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
from collections import Counter, defaultdict
from contextlib import closing
from typing import Any, Callable, Optional

from market_edge_exec.analysis import portfolio as P
from market_edge_exec.shadow import contracts as C, stats as S

DIAGNOSTIC_VERSION = "FORWARD-DIAGNOSTIC-V1"
LABEL = "RESEARCH ONLY · EVIDENCE + UNCERTAINTY · NO PROMOTION RECOMMENDATION · CHANGES NOTHING"
ALPHA = 0.05
BOOTSTRAP_N = 2000
PERMUTATIONS = 500
CALIBRATION_RUNS = 100
SEED = 20260929
MS_DAY = 86_400_000
# Evidence floors for the batch as a whole. Every one must clear; elapsed time alone never does.
FLOORS = {"resolved_candidates": 100, "independent_clusters": 30, "market_episodes": 30, "days": 14, "assets": 4, "strategies": 2}
MAX_SINGLE_ASSET_SHARE = 0.5
MIN_GROUP_CLUSTERS = 10          # a group with fewer independent clusters gets NOT_ENOUGH, never a direction


# ---- loading --------------------------------------------------------------------------------------------------------
def _ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_market_states(shadow_db_path: str) -> list[dict]:
    """MARKET_STATE observations the scan judged NO_TRADE, with the resolver's diagnostic hindsight classification."""
    with closing(_ro(shadow_db_path)) as conn:
        rows = conn.execute(
            "SELECT o.observation_id, o.asset, o.decision_ts, o.observation_cluster_id, o.market_episode_id, o.production_state, "
            "h.classification FROM shadow_observations o LEFT JOIN shadow_hindsight h USING (observation_id) "
            "WHERE o.kind=? ORDER BY o.decision_ts, o.observation_id", (C.KIND_MARKET_STATE,)).fetchall()
    return [{"observation_id": r["observation_id"], "asset": r["asset"], "decision_ts": r["decision_ts"], "cluster": r["observation_cluster_id"],
             "episode": r["market_episode_id"], "production_state": r["production_state"], "classification": r["classification"]} for r in rows]


# ---- statistics -----------------------------------------------------------------------------------------------------
def _mean(xs: list[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def describe(rows: list[dict], value: Callable[[dict], Optional[float]] = lambda r: r["r"], seed: int = SEED) -> dict:
    """n, independent clusters, mean and the cluster-bootstrap CI of the cluster-weighted mean."""
    vals = [value(r) for r in rows if value(r) is not None]
    boot = S.grouped_bootstrap([r for r in rows if value(r) is not None], value, "cluster", n=BOOTSTRAP_N, seed=seed, alpha=ALPHA)
    return {"n": len(vals), "clusters": boot["groups"], "mean": _mean(vals), "cluster_mean": boot["mean"], "ci95": boot["ci"]}


def _delta(a: list[dict], b: list[dict]) -> Optional[float]:
    if not a or not b:
        return None
    return _mean([r["r"] for r in a]) - _mean([r["r"] for r in b])


def _cluster_bootstrap_delta(rows: list[dict], in_a: Callable[[dict], bool], rng: random.Random, n: int) -> Optional[list[float]]:
    """Percentile CI of mean(A) - mean(B), resampling whole clusters (per-cluster sums, so it scales with clusters, not rows)."""
    sums: dict = defaultdict(lambda: [0.0, 0, 0.0, 0])
    for r in rows:
        s = sums[r["cluster"]]
        if in_a(r):
            s[0] += r["r"]; s[1] += 1
        else:
            s[2] += r["r"]; s[3] += 1
    cl = list(sums.values())
    if len(cl) < 2:
        return None
    stats = []
    k = len(cl)
    for _ in range(n):
        sa = na = sb = nb = 0
        for _ in range(k):
            c = cl[rng.randrange(k)]
            sa += c[0]; na += c[1]; sb += c[2]; nb += c[3]
        if na and nb:
            stats.append(sa / na - sb / nb)
    if len(stats) < n // 2:
        return None
    stats.sort()
    return [stats[int(ALPHA / 2 * len(stats))], stats[int((1 - ALPHA / 2) * len(stats)) - 1]]


def _permute_labels(rows: list[dict], in_a: Callable[[dict], bool], rng: random.Random) -> list[dict]:
    """Shuffle group membership between whole clusters: a cluster's rows keep their outcomes and move together."""
    by_cluster: dict = defaultdict(list)
    for r in rows:
        by_cluster[r["cluster"]].append(r)
    keys = list(by_cluster)
    labels = [[in_a(r) for r in by_cluster[k]] for k in keys]
    rng.shuffle(labels)
    out = []
    for k, lab in zip(keys, labels):
        members = by_cluster[k]
        for i, r in enumerate(members):
            out.append({**r, "_a": lab[i % len(lab)]})
    return out


def compare(a: list[dict], b: list[dict], name_a: str, name_b: str, *, seed: int = SEED, permutations: int = PERMUTATIONS) -> dict:
    """Two groups of resolved rows. Direction only when both sides clear MIN_GROUP_CLUSTERS and the CI excludes zero."""
    da, db = describe(a, seed=seed), describe(b, seed=seed + 1)
    out: dict[str, Any] = {"groups": {name_a: da, name_b: db}, "delta_mean_R": _delta(a, b), "delta_ci95": None,
                           "placebo_permutation_p": None, "placebo_permutations": 0}
    if min(da["clusters"], db["clusters"]) < MIN_GROUP_CLUSTERS:
        out["verdict"] = f"NOT_ENOUGH: {da['clusters']} / {db['clusters']} independent clusters, need {MIN_GROUP_CLUSTERS} per side"
        return out
    rows = [{**r, "_a": True} for r in a] + [{**r, "_a": False} for r in b]
    in_a = lambda r: r["_a"]
    rng = random.Random(seed)
    ci = _cluster_bootstrap_delta(rows, in_a, rng, BOOTSTRAP_N)
    observed = abs(out["delta_mean_R"])
    extreme = 0
    for _ in range(permutations):
        p = _permute_labels(rows, in_a, rng)
        d = _delta([r for r in p if r["_a"]], [r for r in p if not r["_a"]])
        if d is not None and abs(d) >= observed - 1e-12:
            extreme += 1
    out.update({"delta_ci95": ci, "placebo_permutation_p": (extreme + 1) / (permutations + 1), "placebo_permutations": permutations})
    if ci is None:
        out["verdict"] = "NO_INTERVAL"
    elif ci[0] > 0 and out["placebo_permutation_p"] < ALPHA:
        out["verdict"] = f"{name_a}_HIGHER"
    elif ci[1] < 0 and out["placebo_permutation_p"] < ALPHA:
        out["verdict"] = f"{name_b}_HIGHER"
    else:
        out["verdict"] = "NO_CLEAR_DIFFERENCE"
    return out


def calibrate(rows: list[dict], in_a: Callable[[dict], bool], *, runs: int = CALIBRATION_RUNS, seed: int = SEED) -> dict:
    """False-positive rate of the CI rule on label-permuted versions of these very rows (the null holds by construction)."""
    clusters = len({r["cluster"] for r in rows})
    if clusters < 2 * MIN_GROUP_CLUSTERS:
        return {"status": "NOT_RUN", "reason": f"{clusters} independent clusters; calibration needs at least {2 * MIN_GROUP_CLUSTERS}", "runs": 0}
    rng = random.Random(seed)
    base = [{**r, "_a": in_a(r)} for r in rows]
    hits = done = 0
    for _ in range(runs):
        p = _permute_labels(base, lambda r: r["_a"], rng)
        ci = _cluster_bootstrap_delta(p, lambda r: r["_a"], rng, 400)
        if ci is None:
            continue
        done += 1
        hits += ci[0] > 0 or ci[1] < 0
    rate = hits / done if done else None
    return {"status": "CHECKED", "runs": done, "false_positive_rate": rate, "nominal_alpha": ALPHA,
            "reading": ("The interval rule is roughly calibrated on this data." if rate is not None and rate <= 2 * ALPHA else
                        "The interval rule fires too often on permuted data; treat every CI-only finding here as unreliable.")}


def by_group(rows: list[dict], key: str) -> dict:
    groups: dict = defaultdict(list)
    for r in rows:
        groups[str(r[key])].append(r)
    out = {}
    for k in sorted(groups):
        d = describe(groups[k])
        d["enough"] = d["clusters"] >= MIN_GROUP_CLUSTERS
        out[k] = d
    return out


# ---- sections ---------------------------------------------------------------------------------------------------------
def evidence(rows: list[dict], states: list[dict]) -> dict:
    ts = [r["decision_ts"] for r in rows]
    assets = Counter(r["asset"] for r in rows)
    counts = {"resolved_candidates": len(rows), "scans": len({r["scan_id"] for r in rows}),
              "independent_clusters": len({r["cluster"] for r in rows}), "market_episodes": len({r["episode"] for r in rows}),
              "days": (max(ts) - min(ts)) / MS_DAY if ts else 0.0, "assets": len(assets),
              "strategies": len({r["strategy"] for r in rows}), "directions": dict(Counter(str(r["direction"]) for r in rows)),
              "max_single_asset_share": max(assets.values()) / len(rows) if rows else None,
              "executed_candidates": sum(1 for r in rows if r["executed"]), "no_trade_states": sum(1 for s in states if s["production_state"] == "NO_TRADE")}
    missing = [f"{k}: have {round(counts[k], 2)}, need {v}" for k, v in FLOORS.items() if counts[k] < v]
    if counts["max_single_asset_share"] is not None and counts["max_single_asset_share"] > MAX_SINGLE_ASSET_SHARE:
        missing.append(f"max_single_asset_share: {counts['max_single_asset_share']:.2f} > {MAX_SINGLE_ASSET_SHARE}")
    return {"counts": counts, "floors": FLOORS, "missing": missing, "sufficient": not missing,
            "judged_by": "resolved independent clusters/episodes and diversity, not row count or elapsed time"}


def no_trade(states: list[dict]) -> dict:
    judged = [s for s in states if s["production_state"] == "NO_TRADE" and s["classification"] in ("MISSED_OPPORTUNITY", "NO_TRADE_CORRECT")]
    for s in judged:
        s["missed"] = 1.0 if s["classification"] == "MISSED_OPPORTUNITY" else 0.0
    d = describe(judged, lambda s: s["missed"])
    return {"resolved_no_trade_states": len(judged), "clusters": d["clusters"], "missed_opportunity_share": d["mean"], "ci95": d["ci95"],
            "unresolved": sum(1 for s in states if s["production_state"] == "NO_TRADE" and s["classification"] is None),
            "enough": d["clusters"] >= MIN_GROUP_CLUSTERS,
            "caveat": "The classification is the resolver's DIAGNOSTIC_UNVALIDATED label (an opportunity existed in hindsight), not a tradeable edge."}


def exit_counterfactuals(paper_db_path: Optional[str]) -> dict:
    if not paper_db_path:
        return {"status": "NOT_PROVIDED", "reason": "no paper ledger given"}
    from market_edge_exec.exits.completeness import evaluate_eligible
    with closing(_ro(paper_db_path)) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='exit_policy_counterfactuals'").fetchone():
            return {"status": "NOT_AVAILABLE", "reason": "ledger predates MAJOR 3G (no exit counterfactual table)"}
    result = evaluate_eligible(lambda: _ro(paper_db_path))
    verdicts = Counter(p["verdict"] for p in result["policies"].values())
    return {"status": "EVALUATED", "trades_with_baseline": result["trades_with_baseline"], "independent_episodes": result["independent_episodes"],
            "verdicts": dict(verdicts), "policies": {k: {f: v[f] for f in ("verdict", "trades", "independent_episodes", "delta_mean_R", "delta_ci")}
                                                     for k, v in result["policies"].items()}, "evidence_bar": result["evidence_bar"]["version"],
            "evidence_integrity": result["evidence_integrity"]}


def diagnose(shadow_db_path: str, paper_db_path: Optional[str] = None, *, seed: int = SEED) -> dict:
    data = P.load(shadow_db_path)
    rows, states = data["rows"], load_market_states(shadow_db_path)
    executed = [r for r in rows if r["executed"]]
    rejected = [r for r in rows if r["exec_status"] == "REJECTED"]
    skipped = [r for r in rows if r["exec_status"] == "NOT_SUBMITTED"]
    long_, short = [r for r in rows if r["direction"] == "long"], [r for r in rows if r["direction"] == "short"]
    return {
        "diagnostic_version": DIAGNOSTIC_VERSION, "label": LABEL, "cost_model": data["cost_model"], "excluded": data["excluded"],
        "evidence": evidence(rows, states),
        "placebo_calibration": calibrate(long_ + short, lambda r: r["direction"] == "long", seed=seed),
        "rank": P.rank_comparison(rows, BOOTSTRAP_N, seed),
        "chosen_vs_rejected_alternatives": P.chosen_vs_rejected(rows, BOOTSTRAP_N, seed),
        "rejected_vs_accepted": compare(executed, rejected, "ACCEPTED", "REJECTED", seed=seed),
        "rejection_reasons": dict(Counter(str(r["reject_reason"]) for r in rejected)),
        "skipped_vs_taken": compare(executed, skipped, "TAKEN", "SKIPPED", seed=seed),
        "long_vs_short": compare(long_, short, "LONG", "SHORT", seed=seed),
        "by_asset": by_group(rows, "asset"),
        "by_strategy": by_group(rows, "strategy"),
        "no_trade_states": no_trade(states),
        "exit_counterfactuals": exit_counterfactuals(paper_db_path),
        "risk_sizing_counterfactuals": {"status": "SEPARATE", "reason": "evaluation.sizing_review (#70) on the same paper ledger"},
        "promotion": "NONE. This batch reports evidence and uncertainty; it recommends nothing.",
    }


# ---- rendering ------------------------------------------------------------------------------------------------------
def _f(v: Any, d: int = 3) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_f(x, d) for x in v) + "]"
    return f"{v:.{d}f}" if isinstance(v, float) else str(v)


def _cmp_lines(title: str, c: dict) -> list[str]:
    lines = [f"## {title}", "", "| group | n | clusters | mean R | 95% cluster CI |", "|---|---|---|---|---|"]
    for g, d in c["groups"].items():
        lines.append(f"| {g} | {d['n']} | {d['clusters']} | {_f(d['mean'])} | {_f(d['ci95'])} |")
    lines += ["", f"Δ mean R {_f(c['delta_mean_R'])}, 95% cluster CI {_f(c['delta_ci95'])}, "
                  f"placebo permutation p {_f(c['placebo_permutation_p'])} ({c['placebo_permutations']} cluster-level permutations). "
                  f"**{c['verdict']}**", ""]
    return lines


def _group_lines(title: str, g: dict) -> list[str]:
    lines = [f"## {title}", "", "| group | n | clusters | mean R | 95% cluster CI | enough |", "|---|---|---|---|---|---|"]
    lines += [f"| {k} | {d['n']} | {d['clusters']} | {_f(d['mean'])} | {_f(d['ci95'])} | {'yes' if d['enough'] else 'no'} |" for k, d in g.items()]
    return lines + [""]


def render_markdown(r: dict) -> str:
    ev, cal, nt, ex = r["evidence"], r["placebo_calibration"], r["no_trade_states"], r["exit_counterfactuals"]
    c = ev["counts"]
    lines = [f"# Forward data diagnostic batch ({r['diagnostic_version']})", "", f"_{r['label']}_", "",
             "## Evidence sufficiency", "",
             f"{c['resolved_candidates']} resolved candidates in {c['scans']} scans, {c['independent_clusters']} independent clusters, "
             f"{c['market_episodes']} market episodes over {c['days']:.1f} days; {c['assets']} assets, {c['strategies']} strategies, "
             f"directions {c['directions']}, max single-asset share {_f(c['max_single_asset_share'], 2)}. Excluded: {r['excluded'] or 'none'}.", "",
             f"**{'SUFFICIENT' if ev['sufficient'] else 'INSUFFICIENT'}** ({ev['judged_by']})."]
    lines += [f"- missing {m}" for m in ev["missing"]] + [""]
    lines += ["## Placebo calibration", "",
              (f"CHECKED on {cal['runs']} label-permuted datasets: false-positive rate {_f(cal['false_positive_rate'])} "
               f"(nominal {cal['nominal_alpha']}). {cal['reading']}" if cal["status"] == "CHECKED" else f"NOT RUN: {cal['reason']}."), "",
              "## Rank #1 vs #2/#3 and chosen vs other candidates (DATA 18)", ""]
    for k in ("rank1_vs_rank2", "rank1_vs_rank3"):
        s = r["rank"][k]
        lines.append(f"- {k.replace('_', ' ')}: {s['scans']} scans, Δ {_f(s['mean_delta_R'])}, CI {_f(s['ci95'])}, {s['verdict']}")
    cv = r["chosen_vs_rejected_alternatives"]
    lines += [f"- chosen vs mean of other candidates: {cv['chosen_vs_mean_of_rejected']['scans']} scans, "
              f"CI {_f(cv['chosen_vs_mean_of_rejected']['ci95'])}, {cv['chosen_vs_mean_of_rejected']['verdict']}", ""]
    lines += _cmp_lines("Rejected vs accepted", r["rejected_vs_accepted"])
    lines += [f"Rejection reasons: {r['rejection_reasons'] or 'none'}", ""]
    lines += _cmp_lines("Skipped vs taken", r["skipped_vs_taken"])
    lines += _cmp_lines("Long vs short", r["long_vs_short"])
    lines += _group_lines("Asset effects", r["by_asset"])
    lines += _group_lines("Strategy effects", r["by_strategy"])
    lines += ["## No-trade states", "",
              f"{nt['resolved_no_trade_states']} resolved NO_TRADE states in {nt['clusters']} clusters ({nt['unresolved']} unresolved): "
              f"missed-opportunity share {_f(nt['missed_opportunity_share'])}, 95% cluster CI {_f(nt['ci95'])}"
              f"{'' if nt['enough'] else ' (NOT_ENOUGH clusters)'}. {nt['caveat']}", "",
              "## Exit-policy counterfactuals", ""]
    if ex["status"] == "EVALUATED":
        lines.append(f"{ex['trades_with_baseline']} trades in {ex['independent_episodes']} episodes; verdicts {ex['verdicts']} (bar {ex['evidence_bar']}).")
    else:
        lines.append(f"{ex['status']}: {ex['reason']}.")
    lines += ["", "## Risk Sizing V2 counterfactuals", "", f"{r['risk_sizing_counterfactuals']['reason']}.", "", f"**Promotion:** {r['promotion']}"]
    return "\n".join(lines) + "\n"


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Forward data diagnostic batch (read-only). " + LABEL)
    ap.add_argument("shadow", help="market_edge_shadow_research.sqlite3")
    ap.add_argument("--paper", help="market_edge_paper.sqlite3 (for exit counterfactuals)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    result = diagnose(args.shadow, args.paper)
    sys.stdout.write(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n" if args.json else render_markdown(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
