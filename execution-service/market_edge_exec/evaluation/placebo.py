"""DATA 8: the mandatory placebo / noise gate.

A challenger that survived walk-forward evaluation (DATA 7) must also be unlikely to have done as well
by chance. The gate re-runs the SAME walk-forward evaluation, same folds and model type, on placebo
variants that destroy any real signal, and asks where the challenger's result falls in that null
distribution (an empirical one-sided p-value, seeded and reproducible):

  shuffled_outcomes  the TRAIN labels are permuted before fitting
  shuffled_features  every TRAIN feature column is permuted independently before fitting
  noise_features     the real features are replaced by random columns (train and test)
  null_simulation    a model that ranks candidates at random
  (random ranking is also the comparator inside the evaluation itself)

The statistic is the mean per-scan R advantage over random. The gate passes only if the evaluation
already showed stable, cluster-CI-backed improvement (PROMISING_PENDING_PLACEBO_GATE) AND the p-value
is at or below ALPHA against EVERY variant. Calibration (`calibrate`) measures the placebo layer's own
false-positive rate on null data; the number lives in the docs and in a regression test.

There is no override here. `assert_placebo_passed` is the hard check DATA 9's deployment path calls.
"""
from __future__ import annotations

import copy
import hashlib
import json
import random
from typing import Callable, Optional

from market_edge_exec.evaluation import walkforward as W
from market_edge_exec.training import challengers as CH

GATE_VERSION = "PLACEBO-GATE-V1"
GATE_NAME = "PLACEBO_GATE_V1"
ALPHA = 0.05
DEFAULT_RUNS = 40
VARIANTS = ("shuffled_outcomes", "shuffled_features", "noise_features", "null_simulation")


class PlaceboGateError(RuntimeError):
    pass


class _RandomScorer:
    """Ranks candidates at random (seeded): the null simulation."""
    name = "null_simulation"

    def __init__(self, seed: int):
        self.seed = seed

    def fit(self, rows, paths):
        return self

    def predict(self, rows):
        rng = random.Random(self.seed)
        return [rng.random() for _ in rows]


def _factory(model_name: str) -> Callable[[int], list]:
    return lambda seed: [m for m in CH.family(seed) if m.name == model_name]


def _shuffle_outcomes(seed: int):
    def apply(train, fold):
        rng = random.Random(f"{seed}:{fold}:y")
        ys = [r["target"] for r in train]
        rng.shuffle(ys)
        return [{**r, "target": y} for r, y in zip(train, ys)]
    return apply


def _shuffle_features(seed: int):
    def apply(train, fold):
        rng = random.Random(f"{seed}:{fold}:x")
        feats = [json.loads(r["features"]) for r in train]
        for p in feats[0]:
            col = [f[p] for f in feats]
            rng.shuffle(col)
            for f, v in zip(feats, col):
                f[p] = v
        return [{**r, "features": json.dumps(f, sort_keys=True)} for r, f in zip(train, feats)]
    return apply


def _noise_snapshot(snapshot: dict, seed: int) -> dict:
    rng = random.Random(f"{seed}:noise")
    paths = [f"noise.{i}" for i in range(len(snapshot["paths"]))]
    rows = [{**r, "features": json.dumps({p: rng.gauss(0, 1) for p in paths}, sort_keys=True)} for r in snapshot["rows"]]
    return {**snapshot, "paths": paths, "rows": rows}


def _statistic(result: dict, name: str) -> Optional[float]:
    e = result["challengers"].get(name)
    return e["vs"]["random"]["mean_delta_R"] if e else None


def placebo_distribution(snapshot: dict, model_name: str, variant: str, runs: int, seed: int, *, n_folds: int, initial_train_fraction: float) -> list[float]:
    out = []
    for i in range(runs):
        s = seed + 1000 * (VARIANTS.index(variant) + 1) + i
        kw = dict(n_folds=n_folds, initial_train_fraction=initial_train_fraction, seed=s, bootstrap_n=0)
        if variant == "shuffled_outcomes":
            res = W.evaluate_walk_forward(snapshot, model_factory=_factory(model_name), row_transform=_shuffle_outcomes(s), **kw)
            v = _statistic(res, model_name)
        elif variant == "shuffled_features":
            res = W.evaluate_walk_forward(snapshot, model_factory=_factory(model_name), row_transform=_shuffle_features(s), **kw)
            v = _statistic(res, model_name)
        elif variant == "noise_features":
            res = W.evaluate_walk_forward(_noise_snapshot(snapshot, s), model_factory=_factory(model_name), **kw)
            v = _statistic(res, model_name)
        else:
            res = W.evaluate_walk_forward(snapshot, model_factory=lambda sd: [_RandomScorer(sd)], **kw)
            v = _statistic(res, "null_simulation")
        if v is not None:
            out.append(v)
    return out


def run_gate(snapshot: dict, evaluation: dict, model_name: str, *, runs: int = DEFAULT_RUNS, seed: int = 20260929, alpha: float = ALPHA,
             placebo_only: bool = False) -> dict:
    """Judges one challenger of one recorded evaluation. `placebo_only=True` skips the evaluation-evidence precondition
    (used only to calibrate the placebo layer on its own)."""
    if runs < int(1 / alpha) - 1:
        raise PlaceboGateError(f"TOO_FEW_RUNS: p <= {alpha} is unreachable with {runs} placebo runs (need {int(1 / alpha) - 1})")
    entry = evaluation["challengers"].get(model_name)
    if entry is None:
        raise PlaceboGateError(f"UNKNOWN_CHALLENGER: {model_name}")
    observed = entry["vs"]["random"]["mean_delta_R"]
    evidence_ok = entry["evidence"] == "PROMISING_PENDING_PLACEBO_GATE"
    result = {"gate": GATE_NAME, "gate_version": GATE_VERSION, "model": model_name, "evaluation_result_hash": evaluation["result_hash"],
              "snapshot_content_hash": evaluation["snapshot_content_hash"], "alpha": alpha, "runs": runs, "seed": seed, "observed_delta_R": observed,
              "evaluation_evidence": entry["evidence"], "variants": {}}
    if not evidence_ok and not placebo_only:
        result.update(passed=False, reasons=["EVALUATION_HAS_NO_EVIDENCE: the walk-forward result did not show stable, cluster-CI-backed improvement, so the placebo gate is not run"])
        return result
    failed = []
    for v in VARIANTS:
        dist = placebo_distribution(snapshot, model_name, v, runs, seed, n_folds=evaluation["n_folds"], initial_train_fraction=evaluation["initial_train_fraction"])
        ge = sum(1 for x in dist if x >= observed)
        p = (1 + ge) / (1 + len(dist))
        ok = p <= alpha
        result["variants"][v] = {"placebo_runs": len(dist), "placebo_mean_delta_R": sum(dist) / len(dist) if dist else None,
                                 "placebo_p95_delta_R": sorted(dist)[int(0.95 * len(dist))] if dist else None, "p_value": p, "passed": ok}
        if not ok:
            failed.append(v)
    result["passed"] = not failed and (evidence_ok or placebo_only)
    result["reasons"] = [f"NOT_BETTER_THAN_PLACEBO: {v} (p={result['variants'][v]['p_value']:.3f})" for v in failed]
    result["result_hash"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return result


def calibrate(make_null_snapshot: Callable[[int], dict], model_name: str = "ridge", datasets: int = 40, runs: int = 20, seed: int = 1, n_folds: int = 4) -> dict:
    """False-positive rate of the PLACEBO LAYER alone: on pure-noise data, how often does a challenger's result clear
    every placebo variant? (Its real evaluation stage would reject most of those first, so the full gate is stricter still.)"""
    passes, observed = 0, []
    for d in range(datasets):
        snap = make_null_snapshot(seed + d)
        ev = W.evaluate_walk_forward(snap, n_folds=n_folds, model_factory=_factory(model_name), seed=seed + d, bootstrap_n=0)
        g = run_gate(snap, ev, model_name, runs=runs, seed=seed + d, placebo_only=True)
        passes += bool(g["passed"])
        observed.append(g["observed_delta_R"])
    return {"model": model_name, "null_datasets": datasets, "placebo_runs_each": runs, "alpha": ALPHA, "false_pass": passes,
            "false_positive_rate": passes / datasets, "mean_observed_delta_R": sum(observed) / len(observed)}


# ---- the hard check -----------------------------------------------------------------
def log_gate(registry, gate_result: dict, evaluation_experiment_id: str, *, source_commit: Optional[str] = None, now_ms: Optional[int] = None) -> dict:
    exp = registry.create({"research_question": f"Placebo gate for {gate_result['model']} on evaluation {evaluation_experiment_id}",
                           "dataset_version": "PLACEBO-GATE", "feature_set_version": "n/a", "model_type": "PLACEBO_GATE",
                           "hyperparameters": {"evaluation_experiment_id": evaluation_experiment_id, "model": gate_result["model"], "alpha": gate_result["alpha"],
                                               "runs": gate_result["runs"]},
                           "random_seed": gate_result["seed"], "baseline": "RANDOM_RANKING", "source_commit": source_commit}, actor="PLACEBO_GATE", now_ms=now_ms)
    registry.transition(exp["experiment_id"], "RUNNING", actor="PLACEBO_GATE", now_ms=now_ms)
    status = "PROMISING" if gate_result["passed"] else "NO_EVIDENCE"
    registry.transition(exp["experiment_id"], status, results={**gate_result, "evaluation_experiment_id": evaluation_experiment_id}, actor="PLACEBO_GATE", now_ms=now_ms,
                        note="PASSED every placebo variant" if gate_result["passed"] else "DID NOT PASS: " + "; ".join(gate_result.get("reasons", [])))
    return {"experiment_id": exp["experiment_id"], "passed": gate_result["passed"]}


def assert_placebo_passed(registry, evaluation_experiment_id: str, model_name: str) -> dict:
    """Raises PlaceboGateError unless the registry holds a PASSED gate for exactly this evaluation and model.
    The gate's recorded evaluation hash must equal the recorded evaluation's own result hash, so a gate for one
    evaluation can never stand in for another. No override parameter exists."""
    evaluation = registry.history(evaluation_experiment_id)
    if evaluation is None or not evaluation.get("latest_results") or "result_hash" not in evaluation["latest_results"]:
        raise PlaceboGateError("NO_RECORDED_EVALUATION")
    want = evaluation["latest_results"]["result_hash"]
    newest = None
    for row in registry.list(limit=500):   # newest first
        if row["model_type"] != "PLACEBO_GATE":
            continue
        h = registry.history(row["experiment_id"])
        res = (h or {}).get("latest_results") or {}
        if res.get("gate") == GATE_NAME and res.get("evaluation_experiment_id") == evaluation_experiment_id and res.get("model") == model_name:
            newest = res
            break
    if newest is None:
        raise PlaceboGateError("PLACEBO_GATE_NOT_RUN")
    if newest.get("gate_version") != GATE_VERSION:
        raise PlaceboGateError("PLACEBO_GATE_VERSION_MISMATCH")
    if newest.get("evaluation_result_hash") != want:
        raise PlaceboGateError("PLACEBO_GATE_IS_FOR_A_DIFFERENT_EVALUATION_RESULT")
    if newest.get("passed") is not True:
        raise PlaceboGateError("PLACEBO_GATE_FAILED: " + "; ".join(newest.get("reasons") or []))
    return newest
