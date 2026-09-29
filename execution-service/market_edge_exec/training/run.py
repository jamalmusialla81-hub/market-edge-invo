"""One training cycle: check the trigger against the experiment registry, then (only if it fires) train
the challenger family on the frozen snapshot and log the run. Trains nothing on the live database and
deploys nothing; a finished run is NO_EVIDENCE at best, because evaluation is DATA 7/8, not this task."""
from __future__ import annotations

import json
import os
from typing import Optional

from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.training import TRAINING_VERSION, challengers as CH, trigger as T

MODEL_TYPE = "CHALLENGER_FAMILY:random_baseline,quant_baseline,ridge,gbm_stumps"
CHECK_TYPE = "TRIGGER_CHECK"
ACTOR = "TRAINING_TRIGGER"


def last_trained(registry: ExperimentRegistry) -> Optional[T.Stats]:
    """Stats of the newest snapshot a training run actually completed on, read from that run's recorded results."""
    for row in registry.list(limit=500):
        if row["model_type"] != MODEL_TYPE or row["status"] not in ("NO_EVIDENCE", "PROMISING", "REJECTED", "SHADOW_CANDIDATE", "SUPERSEDED"):
            continue
        h = registry.history(row["experiment_id"])
        res = h and h.get("latest_results")
        if res and res.get("snapshot_path") and os.path.isdir(res["snapshot_path"]):
            return T.stats_from_snapshot(res["snapshot_path"], trained_at_ms=res.get("trained_at_ms"))
    return None


def run_cycle(registry: ExperimentRegistry, snapshot_folder: str, artifact_dir: str, policy: T.TriggerPolicy, now_ms: int,
              source_commit: Optional[str] = None, seed: int = 20260929, feature_set_version: str = "FEATURE-SET-V2") -> dict:
    snap = CH.load_snapshot(snapshot_folder)   # refuses a snapshot that no longer matches its manifest
    current = T.stats_from_snapshot(snapshot_folder)
    decision = T.decide(policy, current, last_trained(registry), now_ms)
    base_cfg = {"dataset_version": current.snapshot_version, "feature_set_version": feature_set_version, "random_seed": seed,
                "baseline": "QUANT_BASELINE", "source_commit": source_commit, "evaluation_horizon": "72h", "cluster_resampling": "cluster"}
    if not decision["fire"]:
        # Logged, so a non-run is visible too. PLANNED -> SUPERSEDED with the reason; it is not a training run.
        check = registry.create({**base_cfg, "research_question": "Trigger check (no training run)", "model_type": CHECK_TYPE,
                                 "hyperparameters": {"policy": decision["policy"], "now_ms": now_ms}}, actor=ACTOR, now_ms=now_ms)
        registry.transition(check["experiment_id"], "SUPERSEDED", note="NOT_RUN: " + "; ".join(decision["blocked_by"] or ["NO_THRESHOLD_MET"]), actor=ACTOR, now_ms=now_ms)
        return {"ran": False, "decision": decision, "check_id": check["experiment_id"]}
    exp = registry.create({**base_cfg, "research_question": "Do simple challengers trained on the frozen forward snapshot carry any signal? (training only; evaluation is DATA 7/8)",
                           "model_type": MODEL_TYPE, "hyperparameters": {"ridge_alpha": 10.0, "gbm_rounds": 40, "gbm_learning_rate": 0.1, "trigger": decision}},
                          actor=ACTOR, now_ms=now_ms)
    eid = exp["experiment_id"]
    registry.transition(eid, "RUNNING", actor=ACTOR, now_ms=now_ms)
    try:
        trained = CH.train_family(snap, seed)
    except Exception as error:  # noqa: BLE001 -- every failure is recorded, never swallowed
        registry.transition(eid, "FAILED", note=f"{type(error).__name__}: {error}", actor=ACTOR, now_ms=now_ms)
        return {"ran": True, "experiment_id": eid, "status": "FAILED", "error": str(error), "decision": decision}
    out = os.path.join(artifact_dir, eid)
    os.makedirs(out, exist_ok=True)
    for name, m in trained["models"].items():
        with open(os.path.join(out, f"{name}.json"), "w") as f:
            json.dump(m["artifact"], f, sort_keys=True)
    results = {"training_version": TRAINING_VERSION, "snapshot_version": current.snapshot_version, "snapshot_content_hash": current.content_hash,
               "snapshot_path": os.path.abspath(snapshot_folder), "trained_at_ms": now_ms, "train_rows": trained["train_rows"],
               "validation_rows_untouched": trained["validation_rows_untouched"], "oos_rows_untouched": trained["oos_rows_untouched"],
               "artifact_hashes": {n: m["artifact_hash"] for n, m in trained["models"].items()}, "artifact_dir": os.path.abspath(out),
               "evaluated": False}
    registry.transition(eid, "NO_EVIDENCE", results=results, actor=ACTOR, now_ms=now_ms,
                        note="Trained on the TRAIN split only. Nothing evaluated: walk-forward (DATA 7) and the placebo gate (DATA 8) come next. Not deployed.")
    return {"ran": True, "experiment_id": eid, "status": "NO_EVIDENCE", "decision": decision, "results": results}
