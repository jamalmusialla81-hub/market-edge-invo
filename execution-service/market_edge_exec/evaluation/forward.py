"""DATA 10: forward validation of Shadow-deployed challengers on evidence they could not have seen.

Input is only DATA 9's frozen `shadow_model_predictions` joined to the outcomes that resolved later. Never training data,
never the sealed OOS split. Every output carries the evidence counts (scans, independent episodes, clusters, days, assets,
regimes, choice scans) and an explicit `evidence_missing` list, so "N weeks" can never stand in for evidence: elapsed days is
one of several counts that must each clear a floor, and there is no code path that skips the check.

Judged per scan (a scan is one decision): the challenger's pick versus production's actual pick and versus random (the mean R of
the scan's candidates). R is the shadow resolver's after-cost 72h policy R; nothing is recomputed or re-costed here.

The verdict is FORWARD_PROMISING at best. That is not a promotion: only DATA 11 can change any state.

Thresholds are this task's own, deliberately documented, not a copy of promotion-readiness.js's numbers.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.datasets import builder as B
from market_edge_exec.evaluation import walkforward as W
from market_edge_exec.shadow import contracts as C, stats as S
from market_edge_exec.shadow.store import ShadowStore, _unblob

FORWARD_VERSION = "FORWARD-VALIDATION-V1"
LABEL = "RESEARCH ONLY · FORWARD SHADOW EVIDENCE · NOT A PROMOTION · NO ORDERS · NEVER CHANGES PRODUCTION"
MS_DAY = 86_400_000
# evidence floors: every one must clear, elapsed time alone never does
MIN_RESOLVED_SCANS = 60
MIN_EPISODES = 30            # distinct independent market episodes among the challenger's picks
MIN_CHOICE_SCANS = 20        # scans where the challenger disagreed with production: agreement carries no information
MIN_DAYS = 14
MIN_ASSETS = 4
MIN_REGIMES = 2
MAX_SINGLE_ASSET_SHARE = 0.5
N_BLOCKS = 4                 # chronological blocks for stability
COST_SENSITIVITY_R = (0.05, 0.10)   # pessimistic haircut applied to the challenger's picks only
BASE_ALPHA = 0.05


def _mean(xs: list[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


# ---- collecting: predictions joined to what happened afterwards ---------------------------------
def collect(shadow: ShadowStore, model_key: str, since_ms: Optional[int] = None) -> dict:
    """{'scans': [...resolved forward scans...], 'excluded': {reason: n}, 'pending': n, 'predictions': n}"""
    excluded: dict[str, int] = defaultdict(int)
    scans, pending, total = [], 0, 0
    with closing(shadow._connect()) as c:
        rows = c.execute("SELECT * FROM shadow_model_predictions WHERE model_key=? ORDER BY decision_ts, prediction_id", (model_key,)).fetchall()
        obs_cache: dict[str, Any] = {}

        def obs(oid: str):
            if oid not in obs_cache:
                r = c.execute("SELECT * FROM shadow_observations WHERE observation_id=?", (oid,)).fetchone()
                lab = c.execute("SELECT labels, window_end_ts FROM shadow_labels WHERE observation_id=? AND batch=?", (oid, C.FINAL_BATCH)).fetchone()
                if r is None:
                    obs_cache[oid] = None
                else:
                    l = (_unblob(lab["labels"]).get("72h") or {}) if lab else None
                    status = "PENDING" if lab is None else ("OK" if l.get("label_status") == "OK" and l.get("policy_r") is not None else "UNRESOLVED")
                    obs_cache[oid] = {"status": status, "r": l.get("policy_r") if status == "OK" else None, "window_end_ts": lab["window_end_ts"] if lab else None,
                                      "asset": r["asset"], "direction": r["direction"], "cluster": r["observation_cluster_id"], "episode": r["market_episode_id"],
                                      "regime": B._regime(_unblob(r["decision"]))}
            return obs_cache[oid]

        for p in rows:
            if since_ms is not None and p["decision_ts"] < since_ms:
                continue
            total += 1
            record = _unblob(p["record"])
            if C.content_hash(record) != p["record_hash"]:
                excluded["RECORD_HASH_MISMATCH"] += 1
                continue
            ranking = record.get("challenger_ranking") or []
            cands = [obs(x["oid"]) for x in ranking]
            if not ranking or any(x is None for x in cands):
                excluded["CANDIDATE_OBSERVATION_MISSING"] += 1
                continue
            if any(x["status"] == "PENDING" for x in cands):
                pending += 1
                continue
            if any(x["status"] != "OK" for x in cands):
                excluded["UNRESOLVED_CANDIDATE_LABEL"] += 1
                continue
            pick = obs(p["challenger_choice"])
            if pick["window_end_ts"] is not None and p["created_at_ms"] >= pick["window_end_ts"]:
                excluded["PREDICTION_NOT_PRE_OUTCOME"] += 1     # frozen after its own outcome window closed: unusable
                continue
            prod = obs(p["production_choice"]) if p["production_choice"] else None
            scores = {x["oid"]: x["score"] for x in ranking}
            scans.append({"scan_id": p["scan_id"], "decision_ts": p["decision_ts"], "cluster": pick["cluster"], "episode": pick["episode"], "asset": pick["asset"],
                          "direction": pick["direction"], "regime": pick["regime"], "challenger_r": pick["r"],
                          "production_r": prod["r"] if prod and prod["status"] == "OK" else None,
                          "random_r": _mean([x["r"] for x in cands]), "agrees": bool(record.get("agrees_with_production")),
                          "pairs": [(scores[x["oid"]], obs(x["oid"])["r"]) for x in ranking]})
    return {"scans": scans, "excluded": dict(excluded), "pending": pending, "predictions": total}


# ---- evidence sufficiency: counts first, then (only then) performance ------------------------------
def evidence_counts(scans: list[dict]) -> dict:
    assets = defaultdict(int)
    for s in scans:
        assets[s["asset"]] += 1
    days = (max(s["decision_ts"] for s in scans) - min(s["decision_ts"] for s in scans)) / MS_DAY if scans else 0.0
    return {"resolved_scans": len(scans), "independent_episodes": len({s["episode"] for s in scans}), "clusters": len({s["cluster"] for s in scans}),
            "choice_scans": sum(1 for s in scans if not s["agrees"]), "forward_days": round(days, 2), "assets": len(assets),
            "regimes": len({s["regime"] for s in scans if s["regime"]}),
            "max_single_asset_share": round(max(assets.values()) / len(scans), 4) if scans else None,
            "scans_with_production_pick": sum(1 for s in scans if s["production_r"] is not None)}


def evidence_missing(counts: dict) -> list[str]:
    """Every shortfall, as a sentence carrying the actual numbers (same style as promotion-readiness.js's evidenceMissing)."""
    need = [("resolved_scans", MIN_RESOLVED_SCANS, "resolved forward scans"), ("independent_episodes", MIN_EPISODES, "independent market episodes"),
            ("choice_scans", MIN_CHOICE_SCANS, "scans where it chose differently from production"), ("forward_days", MIN_DAYS, "forward days"),
            ("assets", MIN_ASSETS, "distinct assets"), ("regimes", MIN_REGIMES, "distinct regimes")]
    out = [f"{label}: have {counts[key]}, need {floor}" for key, floor, label in need if counts[key] < floor]
    if counts["max_single_asset_share"] is not None and counts["max_single_asset_share"] > MAX_SINGLE_ASSET_SHARE:
        out.append(f"asset concentration: one asset is {counts['max_single_asset_share']:.0%} of picks, limit {MAX_SINGLE_ASSET_SHARE:.0%}")
    if counts["scans_with_production_pick"] < MIN_RESOLVED_SCANS:
        out.append(f"scans with a comparable production pick: have {counts['scans_with_production_pick']}, need {MIN_RESOLVED_SCANS}")
    return out


# ---- performance --------------------------------------------------------------------------------
def _drawdown(rs: list[float]) -> float:
    return W._drawdown(rs)


def _paired(scans: list[dict], against: str, haircut: float = 0.0) -> list[dict]:
    return [{"cluster": s["cluster"], "d": s["challenger_r"] - haircut - s[against]} for s in scans if s[against] is not None]


def _compare(scans: list[dict], against: str, alpha: float, bootstrap_n: int, seed: int) -> dict:
    paired = _paired(scans, against)
    if not paired:
        return {"n": 0, "mean_delta_R": None, "ci": None}
    ci = S.grouped_bootstrap(paired, lambda r: r["d"], "cluster", n=bootstrap_n, seed=seed, alpha=alpha) if bootstrap_n > 0 else None
    # chronological blocks (scans are already in time order): does one block carry it?
    ordered = [s for s in scans if s[against] is not None]
    size = max(1, len(ordered) // N_BLOCKS)
    blocks = [ordered[i * size:(i + 1) * size if i < N_BLOCKS - 1 else None] for i in range(N_BLOCKS)]
    deltas = [_mean([s["challenger_r"] - s[against] for s in b]) for b in blocks if b]
    deltas = [d for d in deltas if d is not None]
    agg = _mean([p["d"] for p in paired])
    # leave-the-best-block-out: the interval must still exclude zero once the strongest chronological block is removed
    best = max(range(len(blocks)), key=lambda i: _mean([s["challenger_r"] - s[against] for s in blocks[i]]) if blocks[i] else float("-inf"))
    rest = [{"cluster": s["cluster"], "d": s["challenger_r"] - s[against]} for i, b in enumerate(blocks) if i != best for s in b]
    lo = S.grouped_bootstrap(rest, lambda r: r["d"], "cluster", n=bootstrap_n, seed=seed, alpha=alpha) if (rest and bootstrap_n > 0) else None
    without_best = {"best_block": best, "mean_delta_R": _mean([p["d"] for p in rest]), "ci": lo and lo.get("ci"), "ci_low_positive": bool(lo and lo.get("ci") and lo["ci"][0] > 0)}
    sensitivity = {}
    for h in COST_SENSITIVITY_R:
        cs = S.grouped_bootstrap(_paired(scans, against, h), lambda r: r["d"], "cluster", n=bootstrap_n, seed=seed, alpha=alpha) if bootstrap_n > 0 else None
        sensitivity[f"haircut_{h}R"] = {"mean_delta_R": agg - h if agg is not None else None, "ci": cs and cs.get("ci"),
                                        "still_positive_at_ci_low": bool(cs and cs.get("ci") and cs["ci"][0] > 0)}
    return {"n": len(paired), "mean_delta_R": agg, "ci": ci and ci.get("ci"), "cluster_groups": ci and ci.get("groups"), "block_delta_R": deltas, "without_best_block": without_best,
            "stability": W.stability(deltas, agg), "execution_sensitivity": sensitivity}


def _rank_monotonicity(scans: list[dict]) -> dict:
    pairs = [p for s in scans for p in s["pairs"]]
    rho = W._spearman([a for a, _ in pairs], [b for _, b in pairs])
    ordered = sorted(pairs, key=lambda p: p[0])
    third = len(ordered) // 3
    if third < 5:
        return {"spearman": rho, "terciles_mean_R": None, "monotone": None}
    t = [_mean([b for _, b in ordered[:third]]), _mean([b for _, b in ordered[third:2 * third]]), _mean([b for _, b in ordered[2 * third:]])]
    return {"spearman": rho, "terciles_mean_R": t, "monotone": bool(t[0] <= t[1] <= t[2])}


def _group(scans: list[dict], key: str) -> dict:
    g: dict[str, list[float]] = defaultdict(list)
    for s in scans:
        g[str(s[key])].append(s["challenger_r"])
    return {k: {"n": len(v), "mean_R": _mean(v)} for k, v in sorted(g.items())}


def skepticism_alpha(placebo_false_positive_rate: Optional[float]) -> float:
    """DATA 8 calibration informs how skeptical to be: if the placebo layer let noise through at rate f > 0.05 on null data, the
    interval is tightened by the same factor (alpha 0.05 * 0.05 / f, floor 0.005). Unknown calibration keeps 0.05."""
    if not placebo_false_positive_rate or placebo_false_positive_rate <= BASE_ALPHA:
        return BASE_ALPHA
    return max(0.005, BASE_ALPHA * BASE_ALPHA / placebo_false_positive_rate)


def validate(scans: list[dict], *, placebo_false_positive_rate: Optional[float] = None, bootstrap_n: int = 1000, seed: int = 20260929) -> dict:
    scans = sorted(scans, key=lambda s: (s["decision_ts"], s["scan_id"]))
    counts = evidence_counts(scans)
    missing = evidence_missing(counts)
    alpha = skepticism_alpha(placebo_false_positive_rate)
    result: dict[str, Any] = {"forward_version": FORWARD_VERSION, "label": LABEL, "evidence": counts, "evidence_missing": missing, "alpha": alpha,
                              "floors": {"resolved_scans": MIN_RESOLVED_SCANS, "independent_episodes": MIN_EPISODES, "choice_scans": MIN_CHOICE_SCANS, "days": MIN_DAYS,
                                         "assets": MIN_ASSETS, "regimes": MIN_REGIMES, "max_single_asset_share": MAX_SINGLE_ASSET_SHARE},
                              "elapsed_time_note": "forward_days is one count among several; elapsed time alone is never sufficient"}
    if not scans:
        result.update(verdict="INSUFFICIENT_EVIDENCE", performance=None)
    else:
        rs = [s["challenger_r"] for s in scans]
        switches = sum(1 for a, b in zip(scans, scans[1:]) if (a["asset"], a["direction"]) != (b["asset"], b["direction"]))
        perf = {"challenger": {"scans": len(rs), "mean_R": _mean(rs), "cumulative_R": sum(rs), "max_drawdown_R": _drawdown(rs)},
                "production": ({"scans": counts["scans_with_production_pick"], "mean_R": _mean([s["production_r"] for s in scans if s["production_r"] is not None])}),
                "random": {"scans": len(scans), "mean_R": _mean([s["random_r"] for s in scans])},
                "vs_production": _compare(scans, "production_r", alpha, bootstrap_n, seed), "vs_random": _compare(scans, "random_r", alpha, bootstrap_n, seed),
                "turnover": {"pick_changes": switches, "share_of_scans": switches / max(1, len(scans) - 1)},
                "rank": _rank_monotonicity(scans), "by_asset": _group(scans, "asset"), "by_regime": _group(scans, "regime")}
        result["performance"] = perf
        if missing:
            result["verdict"] = "INSUFFICIENT_EVIDENCE"      # performance is reported, never rounded up into a verdict
        else:
            ok = all(perf[k]["stability"]["verdict"] == "STABLE_POSITIVE" and perf[k]["ci"] and perf[k]["ci"][0] > 0
                     and perf[k]["without_best_block"]["ci_low_positive"]
                     and perf[k]["execution_sensitivity"][f"haircut_{COST_SENSITIVITY_R[0]}R"]["still_positive_at_ci_low"]
                     for k in ("vs_production", "vs_random")) and perf["rank"]["monotone"] is not False
            result["verdict"] = "FORWARD_PROMISING" if ok else "NO_EVIDENCE"
    result["promotable"] = False       # by construction; DATA 11 is the only place a state can change
    result["result_hash"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
    return result


def run(shadow: ShadowStore, registry, model_key: str, *, log: bool = True, placebo_false_positive_rate: Optional[float] = None,
        now_ms: Optional[int] = None, bootstrap_n: int = 1000) -> dict:
    data = collect(shadow, model_key)
    result = validate(data["scans"], placebo_false_positive_rate=placebo_false_positive_rate, bootstrap_n=bootstrap_n)
    result.update(model_key=model_key, predictions_total=data["predictions"], predictions_pending=data["pending"], predictions_excluded=data["excluded"])
    if log:
        exp = registry.create({"research_question": f"Forward validation of {model_key} on resolved shadow predictions",
                               "dataset_version": "FORWARD-SHADOW-PREDICTIONS", "feature_set_version": "n/a", "model_type": "FORWARD_VALIDATION",
                               "hyperparameters": {"model_key": model_key, "floors": result["floors"], "alpha": result["alpha"], "as_of_resolved_scans": result["evidence"]["resolved_scans"]},
                               "random_seed": 20260929, "baseline": "PRODUCTION_PICK_AND_RANDOM", "evaluation_horizon": "72h", "cluster_resampling": "cluster"},
                              actor="FORWARD_VALIDATION", now_ms=now_ms)
        registry.transition(exp["experiment_id"], "RUNNING", actor="FORWARD_VALIDATION", now_ms=now_ms)
        status = "PROMISING" if result["verdict"] == "FORWARD_PROMISING" else "NO_EVIDENCE"
        note = ("Forward evidence passed every floor and stability check. Not a promotion: only DATA 11 can change state." if status == "PROMISING"
                else ("INSUFFICIENT EVIDENCE: " + "; ".join(result["evidence_missing"])) if result["verdict"] == "INSUFFICIENT_EVIDENCE"
                else "Evidence floors met but no stable, cluster-CI-backed improvement over both production and random.")
        registry.transition(exp["experiment_id"], status, results=result, actor="FORWARD_VALIDATION", now_ms=now_ms, note=note)
        result["experiment_id"] = exp["experiment_id"]
    return result


def run_all(shadow: ShadowStore, registry, **kw) -> list[dict]:
    from market_edge_exec.shadow_models import deploy as D
    return [run(shadow, registry, m["model_key"], **kw) for m in D.active(shadow)]
