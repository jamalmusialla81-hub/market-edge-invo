"""Every experiment is a CREATED event followed by STATUS events; nothing is
overwritten, so the whole path (PLANNED -> RUNNING -> PROMISING -> ...) can be
audited. The lifecycle `status` is deliberately not the vocabulary of
promotion-readiness.js: that gate's output is recorded, whole, as the
`promotion_status` of the experiment it judged."""
from __future__ import annotations

import time
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore, _blob, _unblob

STATUSES = ("PLANNED", "RUNNING", "FAILED", "NO_EVIDENCE", "PROMISING", "SHADOW_CANDIDATE", "REJECTED", "SUPERSEDED")
TRANSITIONS = {
    None: {"PLANNED"},
    "PLANNED": {"RUNNING", "FAILED", "SUPERSEDED"},
    "RUNNING": {"FAILED", "NO_EVIDENCE", "PROMISING", "REJECTED"},
    "NO_EVIDENCE": {"SUPERSEDED"},
    "PROMISING": {"SHADOW_CANDIDATE", "REJECTED", "NO_EVIDENCE", "SUPERSEDED"},
    "SHADOW_CANDIDATE": {"REJECTED", "SUPERSEDED"},
    "FAILED": {"SUPERSEDED"},
    "REJECTED": {"SUPERSEDED"},
    "SUPERSEDED": set(),
}
CONFIG_FIELDS = ("research_question", "dataset_version", "feature_set_version", "model_type", "hyperparameters", "random_seed", "folds",
                 "cost_assumptions", "evaluation_horizon", "cluster_resampling", "baseline", "placebo", "source_commit")
REQUIRED = ("research_question", "dataset_version", "feature_set_version", "model_type", "random_seed", "baseline")
# promotion-readiness.js decision vocabulary (its own; recorded as-is, never mapped onto the lifecycle statuses)
PROMOTION_DECISIONS = ("INSUFFICIENT_EVIDENCE", "REJECTED", "KEEP_CHALLENGER", "PROMOTION_READY")
# The gates that can justify SHADOW_CANDIDATE, each checked against the recorded output rather than a caller's claim.
GATE_PROMOTION_READINESS = "PROMOTION_READINESS_V1"
HARD_GATES = ("noLookahead", "datasetIntegrity", "featureSchemaCompatible", "modelArtifactValid", "predictionsFrozenPreOutcome", "dataQuality")


class RegistryError(ValueError):
    pass


def _gate_passes_promotion_readiness(ps: dict) -> Optional[str]:
    """None if it passes, else the reason. Reads the recorded evaluate() output itself."""
    ev = ps.get("evaluation")
    if not isinstance(ev, dict):
        return "PROMOTION_STATUS_HAS_NO_EVALUATION_OUTPUT"
    decision = ev.get("decision") or ev.get("status")
    if decision not in ("PROMOTION_READY", "KEEP_CHALLENGER"):
        return f"GATE_NOT_PASSED: promotion-readiness decision is {decision}"
    integrity = ev.get("integrity") if isinstance(ev.get("integrity"), dict) else {}
    failed = [g for g in HARD_GATES if g in integrity and integrity[g] is False]
    if failed:
        return f"GATE_NOT_PASSED: hard integrity gate failed: {failed}"
    return None


KNOWN_GATES = {GATE_PROMOTION_READINESS: _gate_passes_promotion_readiness}


class ExperimentRegistry:
    def __init__(self, shadow: ShadowStore):
        self.shadow = shadow

    # ---- writes ---------------------------------------------------------------
    def create(self, config: dict, experiment_id: Optional[str] = None, actor: str = "UNSPECIFIED", now_ms: Optional[int] = None) -> dict:
        missing = [k for k in REQUIRED if config.get(k) in (None, "")]
        if missing:
            raise RegistryError(f"MISSING_REQUIRED_FIELDS: {missing}")
        unknown = sorted(set(config) - set(CONFIG_FIELDS))
        if unknown:
            raise RegistryError(f"UNKNOWN_FIELDS: {unknown}")
        now_ms = now_ms or int(time.time() * 1000)
        # Same experiment (everything except the free-text question) tried before? Recorded, never hidden.
        identity = {k: v for k, v in config.items() if k != "research_question"}
        config_hash = C.content_hash(identity)
        with closing(self.shadow._connect()) as conn:
            repeats = [r["experiment_id"] for r in conn.execute(
                "SELECT experiment_id FROM experiment_events WHERE event_type='CREATED' AND config_hash=? ORDER BY event_id", (config_hash,))]
            experiment_id = experiment_id or f"exp-{config_hash[:12]}-{len(repeats) + 1}"
            if conn.execute("SELECT 1 FROM experiment_events WHERE experiment_id=?", (experiment_id,)).fetchone():
                raise RegistryError(f"EXPERIMENT_EXISTS: {experiment_id}")
            payload = {"config": config, "config_hash": config_hash, "repeat_of": repeats or None, "attempt": len(repeats) + 1}
            conn.execute("INSERT INTO experiment_events (experiment_id, event_type, status, config_hash, actor, at_ms, payload) VALUES (?,?,?,?,?,?,?)",
                         (experiment_id, "CREATED", "PLANNED", config_hash, actor, now_ms, _blob(payload)))
            conn.commit()
        return {"experiment_id": experiment_id, "status": "PLANNED", "config_hash": config_hash, "repeat_of": repeats or None, "attempt": len(repeats) + 1}

    def transition(self, experiment_id: str, status: str, results: Optional[dict] = None, confidence_intervals: Optional[dict] = None,
                   promotion_status: Optional[dict] = None, note: Optional[str] = None, actor: str = "UNSPECIFIED", now_ms: Optional[int] = None) -> dict:
        if status not in STATUSES:
            raise RegistryError(f"UNKNOWN_STATUS: {status}")
        now_ms = now_ms or int(time.time() * 1000)
        current = self.status_of(experiment_id)
        if current is None:
            raise RegistryError(f"UNKNOWN_EXPERIMENT: {experiment_id}")
        if status not in TRANSITIONS[current]:
            raise RegistryError(f"ILLEGAL_TRANSITION: {current} -> {status}")
        if promotion_status is not None:
            self._check_promotion_status(promotion_status)
        if status == "SHADOW_CANDIDATE":
            if promotion_status is None:
                raise RegistryError("SHADOW_CANDIDATE_REQUIRES_PROMOTION_STATUS")
            reason = KNOWN_GATES[promotion_status["gate"]](promotion_status)
            if reason:
                raise RegistryError(f"SHADOW_CANDIDATE_REFUSED: {reason}")
        if status in ("PROMISING", "NO_EVIDENCE", "REJECTED", "SHADOW_CANDIDATE") and results is None and promotion_status is None:
            raise RegistryError(f"{status}_REQUIRES_RESULTS")
        payload = {"results": results, "confidence_intervals": confidence_intervals, "promotion_status": promotion_status, "note": note}
        with closing(self.shadow._connect()) as conn:
            conn.execute("INSERT INTO experiment_events (experiment_id, event_type, status, config_hash, actor, at_ms, payload) VALUES (?,?,?,?,?,?,?)",
                         (experiment_id, "STATUS", status, None, actor, now_ms, _blob(payload)))
            conn.commit()
        return {"experiment_id": experiment_id, "from": current, "status": status}

    @staticmethod
    def _check_promotion_status(ps: Any) -> None:
        if not isinstance(ps, dict) or ps.get("gate") not in KNOWN_GATES:
            raise RegistryError(f"UNKNOWN_GATE: {ps.get('gate') if isinstance(ps, dict) else ps!r} (known: {sorted(KNOWN_GATES)})")
        ev = ps.get("evaluation")
        if isinstance(ev, dict):
            decision = ev.get("decision") or ev.get("status")
            if decision not in PROMOTION_DECISIONS:
                raise RegistryError(f"UNKNOWN_PROMOTION_DECISION: {decision}")

    # ---- reads ----------------------------------------------------------------
    def status_of(self, experiment_id: str) -> Optional[str]:
        with closing(self.shadow._connect()) as conn:
            row = conn.execute("SELECT status FROM experiment_events WHERE experiment_id=? ORDER BY event_id DESC LIMIT 1", (experiment_id,)).fetchone()
        return row["status"] if row else None

    def history(self, experiment_id: str) -> Optional[dict]:
        with closing(self.shadow._connect()) as conn:
            rows = conn.execute("SELECT * FROM experiment_events WHERE experiment_id=? ORDER BY event_id", (experiment_id,)).fetchall()
        if not rows:
            return None
        events = [{"event_id": r["event_id"], "event_type": r["event_type"], "status": r["status"], "actor": r["actor"], "at_ms": r["at_ms"],
                   **_unblob(r["payload"])} for r in rows]
        created = events[0]
        latest = next((e for e in reversed(events) if e["event_type"] == "STATUS"), None)
        return {"experiment_id": experiment_id, "status": events[-1]["status"], "config": created["config"], "config_hash": created["config_hash"],
                "repeat_of": created["repeat_of"], "attempt": created["attempt"],
                "latest_results": next((e["results"] for e in reversed(events) if e.get("results") is not None), None),
                "latest_promotion_status": next((e["promotion_status"] for e in reversed(events) if e.get("promotion_status") is not None), None),
                "events": events, "last_status_event": latest}

    def list(self, status: Optional[str] = None, limit: int = 100) -> list[dict]:
        with closing(self.shadow._connect()) as conn:
            ids = [r[0] for r in conn.execute("SELECT experiment_id FROM experiment_events WHERE event_type='CREATED' ORDER BY event_id DESC LIMIT ?", (limit,))]
        out = []
        for i in ids:
            h = self.history(i)
            if h and (status is None or h["status"] == status):
                out.append({k: h[k] for k in ("experiment_id", "status", "config_hash", "attempt", "repeat_of")}
                            | {"research_question": h["config"]["research_question"], "model_type": h["config"]["model_type"],
                               "dataset_version": h["config"]["dataset_version"], "feature_set_version": h["config"]["feature_set_version"]})
        return out
