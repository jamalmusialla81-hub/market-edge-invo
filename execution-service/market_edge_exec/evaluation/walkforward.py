"""DATA 7: chronological, scan-grouped, cluster-aware walk-forward evaluation on a frozen snapshot.

Design (each point has a test):
  - folds are chronological over the snapshot's TRAIN + VALIDATION rows; the OOS split is never touched here
  - the unit is a connected component of scans sharing a cluster or episode (the DATA 3 rule), so a scan
    and its correlated neighbours are always on one side; training data for a fold is only components that
    started AND whose outcome windows closed before the fold begins (purge)
  - a scan's candidates are judged together: each policy picks one candidate per scan and the pick's
    label R is the result. Policies: each challenger (argmax prediction), the current Quant score
    (argmax quant_score), and random (the exact expectation: the mean R of the scan's candidates)
  - R is the snapshot label (`72h.policy_r`), produced by the shadow resolver with the same fee and
    slippage model production uses; nothing is recomputed or re-costed here
  - confidence intervals resample whole clusters (shadow.stats.grouped_bootstrap)
  - the result always carries per-fold numbers and a stability verdict, so no consumer can read a
    rolled-up mean without seeing whether one fold carries it

Not a promotion decision. The placebo gate (DATA 8) and forward validation (DATA 10) still stand between
this and any deployment.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from collections import defaultdict
from typing import Any, Callable, Optional

from market_edge_exec.datasets import builder as B
from market_edge_exec.evaluation import EVALUATION_VERSION
from market_edge_exec.shadow import stats as S
from market_edge_exec.training import challengers as CH

MIN_SCANS_FOR_PROMISING = 60
MIN_FOLDS_FOR_PROMISING = 3
POSITIVE_FOLD_SHARE = 0.75
COMPARATORS = ("quant", "random")


class EvaluationError(ValueError):
    pass


def _by_scan(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[r["scan_id"]].append(r)
    return out


def make_folds(rows: list[dict], n_folds: int = 4, initial_train_fraction: float = 0.4) -> list[dict]:
    """[{index, train_scans, test_scans, test_start_ts, skipped?}] over component-aligned chronological blocks."""
    if n_folds < 2:
        raise EvaluationError("NEED_AT_LEAST_TWO_FOLDS")
    scans = _by_scan(rows)
    units = {s: {"n": len(v), "start_ts": min(r["decision_ts"] for r in v), "window_end_ts": max(r["window_end_ts"] for r in v),
                 "clusters": {r["cluster_id"] for r in v}, "episodes": {r["episode_id"] for r in v}} for s, v in scans.items()}
    comps = sorted(({"scans": c, "start": min(units[s]["start_ts"] for s in c), "end": max(units[s]["window_end_ts"] for s in c),
                     "n": sum(units[s]["n"] for s in c)} for c in B._components(units)), key=lambda c: (c["start"], c["scans"][0]))
    total = sum(c["n"] for c in comps)
    first_test_at = initial_train_fraction * total
    per_fold = (total - first_test_at) / n_folds
    blocks: list[list[dict]] = [[] for _ in range(n_folds)]
    seen = 0.0
    for c in comps:
        if seen >= first_test_at:
            blocks[min(n_folds - 1, int((seen - first_test_at) // per_fold))].append(c)
        seen += c["n"]
    folds = []
    for i, block in enumerate(blocks):
        if not block:
            folds.append({"index": i, "skipped": "EMPTY_FOLD", "train_scans": [], "test_scans": [], "test_start_ts": None})
            continue
        start = min(c["start"] for c in block)
        train = sorted(s for c in comps if c["end"] < start for s in c["scans"])    # started earlier AND outcome windows closed
        folds.append({"index": i, "train_scans": train, "test_scans": sorted(s for c in block for s in c["scans"]), "test_start_ts": start})
    return folds


def _drawdown(rs: list[float]) -> float:
    peak = eq = worst = 0.0
    for r in rs:
        eq += r
        peak = max(peak, eq)
        worst = max(worst, peak - eq)
    return worst


def _pick(cands: list[dict], score: Callable[[dict], float]) -> dict:
    return max(sorted(cands, key=lambda r: r["observation_id"]), key=score)   # ties: lowest observation_id, deterministic


def _spearman(a: list[float], b: list[float]) -> Optional[float]:
    def ranks(x):
        order = sorted(range(len(x)), key=lambda i: x[i])
        r = [0.0] * len(x)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and x[order[j + 1]] == x[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2 + 1
            i = j + 1
        return r
    if len(a) < 5:
        return None
    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    va, vb = sum((x - ma) ** 2 for x in ra), sum((x - mb) ** 2 for x in rb)
    return sum((x - ma) * (y - mb) for x, y in zip(ra, rb)) / math.sqrt(va * vb) if va > 0 and vb > 0 else None


def score_fold(test_rows: list[dict], predictions: dict[str, dict[str, float]]) -> dict:
    """Per-policy results on one fold. predictions[model][observation_id] = score."""
    scans = _by_scan(test_rows)
    order = sorted(scans, key=lambda s: (min(r["decision_ts"] for r in scans[s]), s))
    policies: dict[str, dict] = {}
    picks: dict[str, list[dict]] = {}
    names = list(predictions) + list(COMPARATORS)
    for name in names:
        chosen = []
        for s in order:
            cands = scans[s]
            if name == "random":
                r = sum(c["target"] for c in cands) / len(cands)
                chosen.append({"scan_id": s, "observation_id": None, "r": r, "best_r": max(c["target"] for c in cands), "asset": cands[0]["asset"], "strategy": None,
                               "direction": None, "regime": None, "cluster": cands[0]["cluster_id"], "n": len(cands)})
                continue
            key = (lambda c: c["quant_score"] if c["quant_score"] is not None else float("-inf")) if name == "quant" else (lambda c, m=name: predictions[m][c["observation_id"]])
            c = _pick(cands, key)
            chosen.append({"scan_id": s, "observation_id": c["observation_id"], "r": c["target"], "best_r": max(x["target"] for x in cands), "asset": c["asset"],
                           "strategy": c["strategy"], "direction": c["direction"], "regime": c["regime"], "cluster": c["cluster_id"], "n": len(cands)})
        picks[name] = chosen
        rs = [p["r"] for p in chosen]
        policies[name] = {"scans": len(rs), "mean_R": sum(rs) / len(rs), "cumulative_R": sum(rs), "max_drawdown_R": _drawdown(rs),
                          "hit_best_share": (sum(1 for p in chosen if p["observation_id"] and abs(p["r"] - p["best_r"]) < 1e-12) / len(chosen)) if name != "random" else None,
                          "mean_regret_R": sum(p["best_r"] - p["r"] for p in chosen) / len(chosen)}
    rank = {}
    for m, pred in predictions.items():
        ids = [r["observation_id"] for r in test_rows]
        rank[m] = {"spearman_all_rows": _spearman([pred[i] for i in ids], [r["target"] for r in test_rows])}
    return {"scans": len(order), "rows": len(test_rows), "policies": policies, "rank": rank, "picks": picks}


def breakdown(picks: list[dict]) -> dict:
    out = {}
    for key in ("asset", "strategy", "direction", "regime"):
        groups: dict[str, list[float]] = defaultdict(list)
        for p in picks:
            groups[str(p[key])].append(p["r"])
        out[key] = {g: {"n": len(v), "mean_R": sum(v) / len(v)} for g, v in sorted(groups.items())}
    return out


def stability(fold_deltas: list[float], aggregate_delta: Optional[float]) -> dict:
    """Per-fold delta of a challenger vs a comparator. Flags a result that one fold carries."""
    n = len(fold_deltas)
    if n < MIN_FOLDS_FOR_PROMISING:
        return {"verdict": "INSUFFICIENT_FOLDS", "folds": n, "positive_folds": sum(d > 0 for d in fold_deltas), "carried_by_single_fold": None}
    positive = sum(d > 0 for d in fold_deltas)
    best = max(range(n), key=lambda i: fold_deltas[i])
    without = [d for i, d in enumerate(fold_deltas) if i != best]
    carried = aggregate_delta is not None and aggregate_delta > 0 and sum(without) / len(without) <= 0
    sd = math.sqrt(sum((d - sum(fold_deltas) / n) ** 2 for d in fold_deltas) / (n - 1))
    verdict = "UNSTABLE_ONE_FOLD_CARRIES" if carried else "STABLE_POSITIVE" if positive / n >= POSITIVE_FOLD_SHARE and (aggregate_delta or 0) > 0 else "MIXED"
    return {"verdict": verdict, "folds": n, "positive_folds": positive, "best_fold": best, "mean_without_best_fold": sum(without) / len(without),
            "fold_delta_sd": sd, "carried_by_single_fold": carried}


def evaluate_walk_forward(snapshot: dict, *, n_folds: int = 4, seed: int = 20260929, initial_train_fraction: float = 0.4,
                          model_factory: Optional[Callable[[int], list]] = None,
                          row_transform: Optional[Callable[[list[dict], int], list[dict]]] = None, bootstrap_n: int = 1000) -> dict:
    """Runs the challengers through the folds. `row_transform(rows, fold_index)` (DATA 8's placebo hook) may alter the
    TRAIN rows a challenger is fitted on (shuffled features or outcomes); test rows and comparators are never transformed."""
    rows = [r for r in snapshot["rows"] if r["split"] in ("TRAIN", "VALIDATION")]
    if not rows:
        raise EvaluationError("NO_ROWS_TO_EVALUATE")
    scans = _by_scan(rows)
    folds = make_folds(rows, n_folds, initial_train_fraction)
    make = model_factory or (lambda sd: [m for m in CH.family(sd) if m.name in ("ridge", "gbm_stumps")])
    fold_results, all_picks = [], defaultdict(list)
    for f in folds:
        if f.get("skipped"):
            fold_results.append({"index": f["index"], "skipped": f["skipped"]})
            continue
        train = [r for s in f["train_scans"] for r in scans[s]]
        test = [r for s in f["test_scans"] for r in scans[s]]
        if len(train) < 10:
            fold_results.append({"index": f["index"], "skipped": f"TOO_FEW_TRAIN_ROWS:{len(train)}"})
            continue
        fit_rows = row_transform(train, f["index"]) if row_transform else train
        preds = {}
        for m in make(seed + f["index"]):
            m.fit(fit_rows, snapshot["paths"])
            preds[m.name] = dict(zip((r["observation_id"] for r in test), m.predict(test)))
        res = score_fold(test, preds)
        res.update({"index": f["index"], "train_rows": len(train), "test_start_ts": f["test_start_ts"],
                    "train_max_window_end_ts": max(r["window_end_ts"] for r in train), "test_min_decision_ts": min(r["decision_ts"] for r in test)})
        for name, p in res.pop("picks").items():
            all_picks[name].extend(p)
        fold_results.append(res)
    ran = [f for f in fold_results if "skipped" not in f]
    challengers = sorted({m for f in ran for m in f["rank"]})
    summary: dict[str, Any] = {}
    for m in challengers:
        entry: dict[str, Any] = {"overall": {"scans": len(all_picks[m]), "mean_R": sum(p["r"] for p in all_picks[m]) / len(all_picks[m])} if all_picks[m] else None,
                                 "breakdown": breakdown(all_picks[m]), "vs": {}}
        for comp in COMPARATORS:
            deltas = [f["policies"][m]["mean_R"] - f["policies"][comp]["mean_R"] for f in ran]
            paired = [{"cluster": a["cluster"], "d": a["r"] - b["r"]} for a, b in zip(all_picks[m], all_picks[comp])]
            agg = sum(p["d"] for p in paired) / len(paired) if paired else None
            ci = S.grouped_bootstrap(paired, lambda r: r["d"], group_key="cluster", n=bootstrap_n, seed=seed) if paired else None
            entry["vs"][comp] = {"mean_delta_R": agg, "ci95": ci and ci.get("ci"), "cluster_groups": ci and ci.get("groups"), "per_fold_delta_R": deltas,
                                 "stability": stability(deltas, agg)}
        d = entry["vs"]
        n_scans = entry["overall"]["scans"] if entry["overall"] else 0
        good = all(d[c]["stability"]["verdict"] == "STABLE_POSITIVE" and d[c]["ci95"] and d[c]["ci95"][0] > 0 for c in COMPARATORS) and n_scans >= MIN_SCANS_FOR_PROMISING
        entry["evidence"] = "PROMISING_PENDING_PLACEBO_GATE" if good else "NO_EVIDENCE"
        summary[m] = entry
    result = {"evaluation_version": EVALUATION_VERSION, "snapshot_version": snapshot["manifest"]["version"], "snapshot_content_hash": snapshot["manifest"]["content_hash"],
              "seed": seed, "n_folds": n_folds, "initial_train_fraction": initial_train_fraction,
              "oos_rows_untouched": sum(r["split"] == "OOS" for r in snapshot["rows"]), "folds": fold_results, "challengers": summary,
              "comparators": {c: [f["policies"][c] for f in ran] for c in COMPARATORS},
              "rules": {"min_scans_for_promising": MIN_SCANS_FOR_PROMISING, "min_folds": MIN_FOLDS_FOR_PROMISING, "positive_fold_share": POSITIVE_FOLD_SHARE,
                        "note": "PROMISING_PENDING_PLACEBO_GATE is not a promotion: DATA 8 and DATA 10 still apply."}}
    result["result_hash"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
    return result


def log_evaluation(registry, result: dict, *, source_commit: Optional[str] = None, now_ms: Optional[int] = None,
                   feature_set_version: str = "FEATURE-SET-V2") -> dict:
    """Records an evaluation in the experiment registry. PROMISING only when a challenger's per-fold, cluster-CI evidence
    passes (and even then it is not promotable until the placebo gate); otherwise NO_EVIDENCE. Never SHADOW_CANDIDATE."""
    exp = registry.create({"research_question": "Walk-forward evaluation of forward-shadow challengers vs current Quant and random",
                           "dataset_version": result["snapshot_version"], "feature_set_version": feature_set_version, "model_type": "WALK_FORWARD_EVALUATION",
                           "hyperparameters": {"n_folds": result["n_folds"], "initial_train_fraction": result["initial_train_fraction"], "rules": result["rules"]},
                           "random_seed": result["seed"], "baseline": "QUANT_BASELINE", "evaluation_horizon": "72h", "cluster_resampling": "cluster",
                           "source_commit": source_commit}, actor="WALK_FORWARD", now_ms=now_ms)
    registry.transition(exp["experiment_id"], "RUNNING", actor="WALK_FORWARD", now_ms=now_ms)
    promising = [m for m, e in result["challengers"].items() if e["evidence"] == "PROMISING_PENDING_PLACEBO_GATE"]
    status = "PROMISING" if promising else "NO_EVIDENCE"
    registry.transition(exp["experiment_id"], status, results=result, actor="WALK_FORWARD", now_ms=now_ms,
                        note=("Per-fold and cluster-CI evidence passed for: " + ", ".join(promising) + ". Not promotable: the placebo gate (DATA 8) has not run.") if promising
                        else "No challenger showed stable, cluster-CI-backed improvement over both Quant and random.")
    return {"experiment_id": exp["experiment_id"], "status": status}
