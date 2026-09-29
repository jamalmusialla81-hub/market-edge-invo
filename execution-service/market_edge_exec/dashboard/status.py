"""DATA 20: one read-only snapshot of where the research pipeline stands.

Three sections that are never merged, mirroring Trade Detail's hindsight labelling:
  PRODUCTION            what actually trades (paper) and the statement that research controls none of it
  SHADOW                decision-time forward observation counts and pipeline state (experiments, challengers, gates, lifecycle, drift)
  POST-OUTCOME RESEARCH figures computed from RESOLVED outcomes (walk-forward and forward-validation evidence); never decision-time values

Nothing is invented: if no experiment has run, the sections say so with empty lists and zero counts, not placeholder rows.
Writes nothing.
"""
from __future__ import annotations

import time
from collections import Counter
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.dashboard import STATUS_VERSION
from market_edge_exec.lifecycle import policy as lifecycle
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore
from market_edge_exec.shadow_models import deploy as D

LABELS = {"PRODUCTION": "PRODUCTION · PAPER TRADING · NOT CONTROLLED BY RESEARCH",
          "SHADOW": "SHADOW · DECISION-TIME OBSERVATION · NO CAPITAL · NO ORDERS",
          "POST_OUTCOME_RESEARCH": "POST-OUTCOME RESEARCH · COMPUTED FROM RESOLVED OUTCOMES · NEVER A DECISION-TIME VALUE"}


def _latest(rows: list[dict], model_type: str, n: int = 1) -> list[dict]:
    return [r for r in rows if r["model_type"] == model_type][:n]


def _shadow_counts(shadow: ShadowStore) -> dict:
    s = shadow.summary(since_ms=0)
    with closing(shadow._connect()) as c:
        episodes = c.execute("SELECT COUNT(DISTINCT market_episode_id) FROM shadow_observations WHERE kind=? AND research_candidate_valid=1", (C.KIND_CANDIDATE,)).fetchone()[0]
        choice = c.execute("SELECT COUNT(*) FROM (SELECT scan_id FROM shadow_observations WHERE kind=? AND research_candidate_valid=1 GROUP BY scan_id HAVING COUNT(*) >= 2)", (C.KIND_CANDIDATE,)).fetchone()[0]
        datasets = [r[0] for r in c.execute("SELECT DISTINCT dataset_version FROM shadow_observations ORDER BY 1")]
    return {"scans": s["scans"], "observations": s["observations"], "candidate_observations": s["candidate_observations"], "resolved": s["resolved"],
            "unresolved": s["unresolved"], "paper_executed": s["paper_executed"], "independent_episodes": episodes, "choice_scans": choice, "dataset_versions": datasets}


def _validation_for(registry, rows: list[dict], model_key: str) -> Optional[dict]:
    for r in rows:
        if r["model_type"] != "FORWARD_VALIDATION":
            continue
        h = registry.history(r["experiment_id"])
        if h and h["config"].get("hyperparameters", {}).get("model_key") == model_key:
            res = h.get("latest_results") or {}
            perf = res.get("performance") or {}
            vs = perf.get("vs_production") or {}
            return {"experiment_id": r["experiment_id"], "status": h["status"], "verdict": res.get("verdict"), "evidence": res.get("evidence"), "evidence_missing": res.get("evidence_missing"),
                    "vs_production": {"mean_delta_R": vs.get("mean_delta_R"), "ci95": vs.get("ci"), "stability": (vs.get("stability") or {}).get("verdict")} if vs else None,
                    "promotable": False}
    return None


def build_status(shadow: ShadowStore, registry, *, sizing_mode: Optional[str] = None, now_ms: Optional[int] = None) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    rows = registry.list(limit=200)
    by_status = Counter(r["status"] for r in rows)

    deployed = []
    for m in D.active(shadow):
        deployed.append({"model_key": m["model_key"], "model_name": m["model_name"], "deployed_at_ms": m["deployed_at_ms"], "mode": "SHADOW_OBSERVATION_ONLY",
                         "forward_validation": _validation_for(registry, rows, m["model_key"])})
    gates = []
    for r in _latest(rows, "PLACEBO_GATE", 5):
        h = registry.history(r["experiment_id"]) or {}
        res = h.get("latest_results") or {}
        gates.append({"experiment_id": r["experiment_id"], "model": res.get("model"), "status": r["status"], "passed": res.get("passed"), "alpha": res.get("alpha"), "runs": res.get("runs"),
                      "variants": {v: {"p_value": x.get("p_value"), "passed": x.get("passed")} for v, x in (res.get("variants") or {}).items()}, "reasons": res.get("reasons")})
    policies = [{k: p[k] for k in ("policy_id", "policy_type", "state", "subject_ref")} for p in lifecycle.list_policies(shadow)]
    alerts = shadow.drift_alert_history(limit=10)

    evaluations = []
    for r in _latest(rows, "WALK_FORWARD_EVALUATION", 3):
        h = registry.history(r["experiment_id"]) or {}
        res = h.get("latest_results") or {}
        evaluations.append({"experiment_id": r["experiment_id"], "status": r["status"], "dataset_version": r["dataset_version"], "n_folds": res.get("n_folds"),
                            "challengers": {m: {"evidence": e.get("evidence"), "mean_delta_vs_random_R": ((e.get("vs") or {}).get("random") or {}).get("mean_delta_R"),
                                                "ci95_vs_random": ((e.get("vs") or {}).get("random") or {}).get("ci95"),
                                                "stability_vs_random": (((e.get("vs") or {}).get("random") or {}).get("stability") or {}).get("verdict")}
                                            for m, e in (res.get("challengers") or {}).items()}})
    return {
        "status_version": STATUS_VERSION, "generated_at_ms": now_ms, "read_only": True, "labels": LABELS,
        "production": {"label": LABELS["PRODUCTION"], "risk_sizing_mode": sizing_mode, "live": "DISABLED", "controlled_by_research": False,
                       "statement": "Quant scoring, risk policy and exits are not changed by anything on this screen."},
        "shadow": {"label": LABELS["SHADOW"], "counts": _shadow_counts(shadow),
                   "experiments": {"total": len(rows), "by_status": dict(by_status),
                                   "recent": [{k: r[k] for k in ("experiment_id", "model_type", "status", "dataset_version", "attempt")} for r in rows[:12]]},
                   "challengers_deployed": deployed, "placebo_gates": gates, "lifecycle": policies, "drift_alerts": alerts},
        "post_outcome_research": {"label": LABELS["POST_OUTCOME_RESEARCH"], "walk_forward_evaluations": evaluations,
                                  "forward_validations": [d["forward_validation"] for d in deployed if d["forward_validation"]]},
    }
