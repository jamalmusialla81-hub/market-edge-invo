"""Deploying a challenger to shadow: the hard precondition, and what gets recorded per scan.

Zero influence, by construction:
  - this package never imports the paper engine, ledger, router, risk, Nautilus, Hummingbot or the network
    (a test walks its imports), and it writes only to the two append-only shadow tables
  - it runs AFTER the scan was recorded, on a copy of the payload; the scan response is untouched
  - a failure while predicting is swallowed and counted, never raised into the scan path
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from collections import defaultdict
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.evaluation import placebo as P
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore, _blob, _unblob
from market_edge_exec.shadow_models import SHADOW_MODELS_VERSION

EXIT_NOTE = "NOT_APPLICABLE: exit-policy counterfactuals exist only for real paper trades, and a shadow challenger opens none"


class DeploymentError(ValueError):
    pass


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _get(decision: dict, path: str) -> Any:
    value: Any = decision
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


# ---- scoring from a stored artifact -------------------------------------------------------
def score(artifact: dict, feature_paths: list[str], decision: dict) -> float:
    """The challenger's score for one candidate decision snapshot, from its frozen artifact only."""
    medians = artifact.get("medians") or {}

    def value(path: str) -> float:
        v = _get(decision, path)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else float(medians.get(path, 0.0))
    kind = artifact["model"]
    if kind == "ridge":
        total = artifact["intercept"]
        for p, coef in artifact["coefficients"].items():
            mean, sd = artifact["standardisation"][p]
            total += coef * (value(p) - mean) / sd
        return total
    if kind == "gbm_stumps":
        return artifact["base"] + sum((s["left"] if value(s["feature"]) <= s["threshold"] else s["right"]) for s in artifact["stumps"])
    raise DeploymentError(f"UNSUPPORTED_MODEL_FOR_SHADOW: {kind}")


def _artifact_hash(artifact: dict) -> str:
    return hashlib.sha256(json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# ---- deployments ------------------------------------------------------------------------------
def active(shadow: ShadowStore) -> list[dict]:
    with closing(shadow._connect()) as c:
        rows = c.execute("SELECT * FROM shadow_model_deployments ORDER BY deployment_id").fetchall()
    state: dict[str, dict] = {}
    for r in rows:
        if r["event"] == "DEPLOYED":
            state[r["model_key"]] = {"model_key": r["model_key"], "model_name": r["model_name"], "artifact": _unblob(r["artifact"]), "artifact_hash": r["artifact_hash"],
                                     "feature_paths": _unblob(r["detail"]).get("feature_paths", []), "evaluation_experiment_id": r["evaluation_experiment_id"],
                                     "deployed_at_ms": r["at_ms"]}
        elif r["event"] == "RETIRED":
            state.pop(r["model_key"], None)
    return list(state.values())


def deploy(registry, shadow: ShadowStore, *, evaluation_experiment_id: str, training_experiment_id: str, model_name: str,
           actor: str = "UNSPECIFIED", now_ms: Optional[int] = None) -> dict:
    """Refuses unless the placebo gate has PASSED for exactly this evaluation and model (real check, no override),
    the evaluation itself was PROMISING for this model, and the artifact is the one the training run recorded, intact."""
    now_ms = now_ms or int(time.time() * 1000)
    try:
        P.assert_placebo_passed(registry, evaluation_experiment_id, model_name)   # DATA 8's hard check
    except P.PlaceboGateError as error:
        raise DeploymentError(f"PLACEBO_GATE_REQUIRED: {error}") from error
    ev = registry.history(evaluation_experiment_id)
    entry = ((ev or {}).get("latest_results") or {}).get("challengers", {}).get(model_name)
    if not ev or ev["status"] != "PROMISING" or not entry or entry.get("evidence") != "PROMISING_PENDING_PLACEBO_GATE":
        raise DeploymentError("EVALUATION_NOT_PROMISING_FOR_THIS_MODEL")
    tr = registry.history(training_experiment_id)
    res = (tr or {}).get("latest_results") or {}
    if not res.get("artifact_dir") or model_name not in (res.get("artifact_hashes") or {}):
        raise DeploymentError("NO_TRAINED_ARTIFACT_RECORDED")
    if res.get("snapshot_content_hash") != ev["latest_results"]["snapshot_content_hash"]:
        raise DeploymentError("ARTIFACT_WAS_TRAINED_ON_A_DIFFERENT_SNAPSHOT_THAN_THE_EVALUATION")
    path = os.path.join(res["artifact_dir"], f"{model_name}.json")
    artifact = json.load(open(path))
    if _artifact_hash(artifact) != res["artifact_hashes"][model_name]:
        raise DeploymentError("ARTIFACT_HASH_MISMATCH: the file no longer matches what training recorded")
    if artifact["model"] not in ("ridge", "gbm_stumps"):
        raise DeploymentError(f"UNSUPPORTED_MODEL_FOR_SHADOW: {artifact['model']}")
    paths = sorted(set(artifact.get("coefficients", {})) | {s["feature"] for s in artifact.get("stumps", [])})
    C.assert_decision_features(paths)
    key = f"shadow-{model_name}-{res['artifact_hashes'][model_name][:12]}"
    if any(a["model_key"] == key for a in active(shadow)):
        raise DeploymentError(f"ALREADY_DEPLOYED: {key}")
    with closing(shadow._connect()) as c:
        c.execute("INSERT INTO shadow_model_deployments (model_key, event, model_name, evaluation_experiment_id, training_experiment_id, artifact_hash, artifact, "
                  "snapshot_content_hash, actor, at_ms, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (key, "DEPLOYED", model_name, evaluation_experiment_id, training_experiment_id, res["artifact_hashes"][model_name], _blob(artifact),
                   res["snapshot_content_hash"], actor, now_ms, _blob({"feature_paths": paths, "version": SHADOW_MODELS_VERSION, "mode": "SHADOW_OBSERVATION_ONLY"})))
        c.commit()
    return {"model_key": key, "status": "DEPLOYED_SHADOW_OBSERVATION_ONLY", "artifact_hash": res["artifact_hashes"][model_name]}


def retire(shadow: ShadowStore, model_key: str, actor: str = "UNSPECIFIED", note: str = "", now_ms: Optional[int] = None) -> dict:
    live = next((a for a in active(shadow) if a["model_key"] == model_key), None)
    if live is None:
        raise DeploymentError("NOT_DEPLOYED")
    with closing(shadow._connect()) as c:
        c.execute("INSERT INTO shadow_model_deployments (model_key, event, model_name, artifact_hash, actor, at_ms, detail) VALUES (?,?,?,?,?,?,?)",
                  (model_key, "RETIRED", live["model_name"], live["artifact_hash"], actor, now_ms or int(time.time() * 1000), _blob({"note": note})))
        c.commit()
    return {"model_key": model_key, "status": "RETIRED"}


# ---- per-scan recording --------------------------------------------------------------------------
def record_scan_predictions(shadow: ShadowStore, payload: dict, now_ms: Optional[int] = None) -> dict:
    """For every active challenger: rank this scan's candidates, note what it would have chosen versus production, and freeze the
    decision snapshot. Runs after the scan itself was stored. Never raises: failures are counted and returned."""
    stats = {"recorded": 0, "failed": 0, "models": 0}
    try:
        models = active(shadow)
    except Exception:  # noqa: BLE001
        return {**stats, "failed": 1}
    if not models:
        return stats
    now_ms = now_ms or int(time.time() * 1000)
    scan = payload.get("scan") or {}
    scan_id, ts = scan.get("scan_id"), scan.get("decision_ts")
    cands = []
    for obs in payload.get("observations") or []:
        d = obs.get("decision") if isinstance(obs, dict) else None
        cand = (d or {}).get("candidate") or {}
        if obs.get("kind") == C.KIND_CANDIDATE and cand.get("direction") in ("long", "short"):
            cands.append({"oid": C.observation_id(scan_id, obs["kind"], str(obs.get("asset")), cand.get("direction"), cand.get("strategy")),
                          "asset": obs.get("asset"), "decision": d, "cand": cand})
    stats["models"] = len(models)
    if not cands or scan_id is None or ts is None:
        return stats
    production = sorted(cands, key=lambda c: (c["cand"].get("scan_candidate_rank") or 10 ** 9, c["oid"]))
    production_choice = next((c["oid"] for c in production if c["cand"].get("is_production_pick")), None)
    for m in models:
        try:
            scored = sorted(({"oid": c["oid"], "asset": c["asset"], "score": score(m["artifact"], m["feature_paths"], c["decision"])} for c in cands),
                            key=lambda x: (-x["score"], x["oid"]))
            pick = scored[0]
            chosen = next(c for c in cands if c["oid"] == pick["oid"])
            cf = (chosen["decision"] or {}).get("counterfactual_sizing")
            record = {
                "version": SHADOW_MODELS_VERSION, "mode": "SHADOW_OBSERVATION_ONLY", "model_key": m["model_key"], "artifact_hash": m["artifact_hash"],
                "production_ranking": [{"oid": c["oid"], "asset": c["asset"], "scan_candidate_rank": c["cand"].get("scan_candidate_rank"),
                                        "quant_score": c["cand"].get("quant_score")} for c in production],
                "production_choice": production_choice, "challenger_ranking": scored, "challenger_choice": pick["oid"],
                "agrees_with_production": pick["oid"] == production_choice,
                "hypothetical_entry": {"asset": chosen["asset"], "direction": chosen["cand"].get("direction"), "entry": chosen["cand"].get("entry"),
                                       "stop": chosen["cand"].get("stop"), "tp1": chosen["cand"].get("tp1"), "tp2": chosen["cand"].get("tp2"), "hypothetical": True},
                "hypothetical_sizing": cf if cf else "UNAVAILABLE: no counterfactual sizing was attached to this candidate",
                "hypothetical_exit_policy": EXIT_NOTE,
                "decision_snapshot_hash": C.content_hash(chosen["decision"]),
                "consumes_capital": False, "used_for_execution": False, "alters_production_ranking": False,
            }
            pid = "smp-" + C.content_hash([m["model_key"], scan_id])[:24]
            with closing(shadow._connect()) as c:
                cur = c.execute("INSERT OR IGNORE INTO shadow_model_predictions VALUES (?,?,?,?,?,?,?,?,?,?)",
                                (pid, m["model_key"], m["artifact_hash"], scan_id, int(ts), production_choice, pick["oid"], _blob(record), C.content_hash(record), now_ms))
                c.commit()
            stats["recorded"] += cur.rowcount
        except Exception:  # noqa: BLE001 -- research must never break the scan path
            stats["failed"] += 1
    return stats


# ---- reading: the later real outcome, joined once resolved -----------------------------------------
def predictions(shadow: ShadowStore, model_key: str, limit: int = 500) -> list[dict]:
    out = []
    with closing(shadow._connect()) as c:
        rows = c.execute("SELECT * FROM shadow_model_predictions WHERE model_key=? ORDER BY decision_ts DESC LIMIT ?", (model_key, limit)).fetchall()
        for r in rows:
            def outcome(oid: Optional[str]):
                if not oid:
                    return None
                lab = c.execute("SELECT labels FROM shadow_labels WHERE observation_id=? AND batch=?", (oid, C.FINAL_BATCH)).fetchone()
                if not lab:
                    return {"status": "PENDING"}
                l = (_unblob(lab["labels"]).get("72h") or {})
                return {"status": "RESOLVED" if l.get("label_status") == "OK" else "UNRESOLVED", "policy_r_72h": l.get("policy_r")}
            record = _unblob(r["record"])
            out.append({"prediction_id": r["prediction_id"], "scan_id": r["scan_id"], "decision_ts": r["decision_ts"], "hash_ok": C.content_hash(record) == r["record_hash"],
                        "record": record, "challenger_outcome": outcome(r["challenger_choice"]), "production_outcome": outcome(r["production_choice"])})
    return out
