"""DATA 11: RESEARCH -> SHADOW -> PAPER, with DEMOTED as the way out. Shared by ranking models, risk sizing, adaptive exits and strategy variants.

Hard rules (each has a test):
  - there is no LIVE state anywhere in this module: it is absent from STATES and from TRANSITIONS, so no code path can reach one
  - no skipping: RESEARCH -> PAPER does not exist
  - every forward move (RESEARCH -> SHADOW, SHADOW -> PAPER, and re-entry from DEMOTED) needs a logged human authorization, even when all the
    evidence passed; nothing promotes automatically under any threshold
  - criteria are preregistered when the policy is registered, hashed, and immutable. At decision time the evidence is compared with
    THOSE criteria (re-read from the registration event, hash re-verified). Evidence that was created before the criteria is refused.
  - preregistered criteria may not be weaker than the framework floors of the forward validation they rely on
  - state is the fold of an append-only event log; nothing is edited in place
  - any doubt refuses the transition (fails safe). Demotion is the safe direction and needs no authorization.
"""
from __future__ import annotations

import re
import time
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.evaluation import forward as F
from market_edge_exec.lifecycle import LIFECYCLE_VERSION
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore, _blob, _unblob

STATES = ("RESEARCH", "SHADOW", "PAPER", "DEMOTED")          # deliberately no LIVE
POLICY_TYPES = ("RANKING_MODEL", "RISK_SIZING", "ADAPTIVE_EXIT", "STRATEGY_VARIANT")
TRANSITIONS = {None: {"RESEARCH"}, "RESEARCH": {"SHADOW", "DEMOTED"}, "SHADOW": {"PAPER", "DEMOTED"}, "PAPER": {"DEMOTED"}, "DEMOTED": {"RESEARCH"}}
NEEDS_AUTHORIZATION = {("RESEARCH", "SHADOW"), ("SHADOW", "PAPER"), ("DEMOTED", "RESEARCH")}
NEEDS_EVIDENCE = {("RESEARCH", "SHADOW"), ("SHADOW", "PAPER")}
_AUTOMATED = re.compile(r"^(system|auto|automatic|ci|bot|cron|scheduler|claude|placebo|walk|forward|orchestrat)", re.I)
FORWARD_KEYS = (("min_resolved_scans", F.MIN_RESOLVED_SCANS, "resolved_scans"), ("min_independent_episodes", F.MIN_EPISODES, "independent_episodes"),
                ("min_choice_scans", F.MIN_CHOICE_SCANS, "choice_scans"), ("min_forward_days", F.MIN_DAYS, "forward_days"),
                ("min_assets", F.MIN_ASSETS, "assets"), ("min_regimes", F.MIN_REGIMES, "regimes"))


class LifecycleError(ValueError):
    pass


def _now(now_ms: Optional[int]) -> int:
    return now_ms or int(time.time() * 1000)


# ---- criteria (preregistered) ---------------------------------------------------------------------
def validate_criteria(criteria: Any) -> dict:
    if not isinstance(criteria, dict) or not isinstance(criteria.get("shadow_entry"), dict) or not isinstance(criteria.get("paper_entry"), dict):
        raise LifecycleError("CRITERIA_REQUIRED: preregister both shadow_entry and paper_entry before any evidence exists")
    if criteria["shadow_entry"].get("evidence_experiment_status") != "PROMISING":
        raise LifecycleError("CRITERIA_INVALID: shadow_entry.evidence_experiment_status must be PROMISING")
    paper = criteria["paper_entry"]
    kind = paper.get("evidence_kind")
    if kind not in ("FORWARD_VALIDATION", "PROMISING_EXPERIMENT"):
        raise LifecycleError("CRITERIA_INVALID: paper_entry.evidence_kind must be FORWARD_VALIDATION or PROMISING_EXPERIMENT")
    if kind == "FORWARD_VALIDATION":
        for key, floor, _ in FORWARD_KEYS:
            value = paper.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise LifecycleError(f"CRITERIA_INVALID: paper_entry.{key} must be a number")
            if value < floor:
                raise LifecycleError(f"CRITERIA_TOO_WEAK: paper_entry.{key}={value} is below the framework floor {floor}")
    return criteria


# ---- reads ---------------------------------------------------------------------------------------------
def _events(shadow: ShadowStore, policy_id: str) -> list[dict]:
    with closing(shadow._connect()) as c:
        rows = c.execute("SELECT * FROM policy_lifecycle_events WHERE policy_id=? ORDER BY event_id", (policy_id,)).fetchall()
    return [{"event_id": r["event_id"], "event_type": r["event_type"], "from_state": r["from_state"], "to_state": r["to_state"], "actor": r["actor"],
             "authorization": _unblob(r["authorization"]) if r["authorization"] else None, "evidence_experiment_id": r["evidence_experiment_id"],
             "criteria_hash": r["criteria_hash"], "at_ms": r["at_ms"], **_unblob(r["payload"])} for r in rows]


def state_of(shadow: ShadowStore, policy_id: str) -> Optional[str]:
    state = None
    for e in _events(shadow, policy_id):
        if e["to_state"]:
            state = e["to_state"]
    return state


def history(shadow: ShadowStore, policy_id: str) -> Optional[dict]:
    ev = _events(shadow, policy_id)
    if not ev:
        return None
    reg = ev[0]
    return {"policy_id": policy_id, "lifecycle_version": LIFECYCLE_VERSION, "state": state_of(shadow, policy_id), "policy_type": reg["policy_type"], "subject_ref": reg.get("subject_ref"),
            "criteria": reg["criteria"], "criteria_hash": reg["criteria_hash"], "registered_at_ms": reg["at_ms"], "events": ev,
            "live_reachable": False}


def list_policies(shadow: ShadowStore) -> list[dict]:
    with closing(shadow._connect()) as c:
        ids = [r[0] for r in c.execute("SELECT policy_id FROM policy_lifecycle_events WHERE event_type='REGISTERED' ORDER BY event_id")]
    return [{k: h[k] for k in ("policy_id", "policy_type", "state", "subject_ref", "criteria_hash", "registered_at_ms")} for h in (history(shadow, i) for i in ids) if h]


# ---- writes -----------------------------------------------------------------------------------------------
def _insert(shadow: ShadowStore, policy_id: str, event_type: str, from_state, to_state, actor: str, authorization, evidence_id, criteria_hash, payload: dict, at_ms: int) -> None:
    with closing(shadow._connect()) as c:
        c.execute("INSERT INTO policy_lifecycle_events (policy_id, event_type, from_state, to_state, actor, authorization, evidence_experiment_id, criteria_hash, payload, at_ms) "
                  "VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (policy_id, event_type, from_state, to_state, actor, _blob(authorization) if authorization else None, evidence_id, criteria_hash, _blob(payload), at_ms))
        c.commit()


def register(shadow: ShadowStore, *, policy_id: str, policy_type: str, criteria: dict, subject_ref: Optional[str] = None, description: str = "",
             actor: str = "UNSPECIFIED", now_ms: Optional[int] = None) -> dict:
    """Creates the policy in RESEARCH and freezes its promotion criteria. This is the only moment criteria can be set."""
    if policy_type not in POLICY_TYPES:
        raise LifecycleError(f"UNKNOWN_POLICY_TYPE: {policy_type} (known: {list(POLICY_TYPES)})")
    if not policy_id or not re.fullmatch(r"[A-Za-z0-9._:@-]{1,80}", policy_id):
        raise LifecycleError("INVALID_POLICY_ID")
    if _events(shadow, policy_id):
        raise LifecycleError(f"POLICY_EXISTS: {policy_id} (criteria are immutable; register a new version id to change them)")
    validate_criteria(criteria)
    chash = C.content_hash(criteria)
    _insert(shadow, policy_id, "REGISTERED", None, "RESEARCH", actor, None, None, chash,
            {"policy_type": policy_type, "criteria": criteria, "subject_ref": subject_ref, "description": description, "lifecycle_version": LIFECYCLE_VERSION}, _now(now_ms))
    return {"policy_id": policy_id, "state": "RESEARCH", "criteria_hash": chash}


def _check_authorization(auth: Any) -> dict:
    if not isinstance(auth, dict):
        raise LifecycleError("AUTHORIZATION_REQUIRED: every forward move needs a logged human authorization")
    for key in ("authorized_by", "authorization_ref", "statement"):
        if not isinstance(auth.get(key), str) or not auth[key].strip():
            raise LifecycleError(f"AUTHORIZATION_REQUIRED: '{key}' is missing")
    if _AUTOMATED.match(auth["authorized_by"].strip()):
        raise LifecycleError("AUTHORIZATION_MUST_BE_A_PERSON: an automated actor cannot authorize a promotion")
    return {k: auth[k] for k in ("authorized_by", "authorization_ref", "statement")}


def _check_evidence(registry, policy: dict, frm: str, to: str, evidence_id: Optional[str]) -> list[dict]:
    """Compares the recorded evidence with the PREREGISTERED criteria. Returns the itemized comparison; raises on any failure."""
    if not evidence_id:
        raise LifecycleError("EVIDENCE_REQUIRED: name the experiment that justifies this move")
    if C.content_hash(policy["criteria"]) != policy["criteria_hash"]:
        raise LifecycleError("CRITERIA_TAMPERED: the stored criteria no longer match their preregistered hash")
    exp = registry.history(evidence_id)
    if exp is None:
        raise LifecycleError(f"UNKNOWN_EVIDENCE_EXPERIMENT: {evidence_id}")
    if exp["events"][0]["at_ms"] < policy["registered_at_ms"]:
        raise LifecycleError("EVIDENCE_PREDATES_PREREGISTRATION: the experiment was created before the criteria were frozen, so the criteria cannot have gated it")
    checks: list[dict] = []
    def check(name, required, actual, ok):
        checks.append({"check": name, "required": required, "actual": actual, "ok": bool(ok)})
    if (frm, to) == ("RESEARCH", "SHADOW"):
        want = policy["criteria"]["shadow_entry"]["evidence_experiment_status"]
        check("evidence_experiment_status", want, exp["status"], exp["status"] == want)
    else:
        paper = policy["criteria"]["paper_entry"]
        check("evidence_experiment_status", "PROMISING", exp["status"], exp["status"] == "PROMISING")
        if paper["evidence_kind"] == "FORWARD_VALIDATION":
            res = exp.get("latest_results") or {}
            check("evidence_is_forward_validation", "FORWARD_VALIDATION", exp["config"].get("model_type"), exp["config"].get("model_type") == "FORWARD_VALIDATION")
            if policy.get("subject_ref"):
                check("evidence_is_for_this_subject", policy["subject_ref"], exp["config"].get("hyperparameters", {}).get("model_key"),
                      exp["config"].get("hyperparameters", {}).get("model_key") == policy["subject_ref"])
            check("verdict", "FORWARD_PROMISING", res.get("verdict"), res.get("verdict") == "FORWARD_PROMISING")
            counts = res.get("evidence") or {}
            for key, _, field in FORWARD_KEYS:
                actual = counts.get(field)
                check(key, paper[key], actual, isinstance(actual, (int, float)) and actual >= paper[key])
            check("no_evidence_missing", [], res.get("evidence_missing"), res.get("evidence_missing") == [])
    failed = [c for c in checks if not c["ok"]]
    if failed:
        raise LifecycleError("CRITERIA_NOT_MET: " + "; ".join(f"{c['check']} required {c['required']}, actual {c['actual']}" for c in failed))
    return checks


def transition(shadow: ShadowStore, registry, policy_id: str, to_state: str, *, actor: str = "UNSPECIFIED", authorization: Optional[dict] = None,
               evidence_experiment_id: Optional[str] = None, note: str = "", now_ms: Optional[int] = None) -> dict:
    if to_state not in STATES:
        raise LifecycleError(f"UNKNOWN_STATE: {to_state} (states: {list(STATES)})")
    policy = history(shadow, policy_id)
    if policy is None:
        raise LifecycleError(f"UNKNOWN_POLICY: {policy_id}")
    frm = policy["state"]
    if to_state not in TRANSITIONS.get(frm, set()):
        raise LifecycleError(f"ILLEGAL_TRANSITION: {frm} -> {to_state}")
    auth, checks = None, None
    if (frm, to_state) in NEEDS_AUTHORIZATION:
        auth = _check_authorization(authorization)
    if (frm, to_state) in NEEDS_EVIDENCE:
        checks = _check_evidence(registry, policy, frm, to_state, evidence_experiment_id)
    _insert(shadow, policy_id, "TRANSITION", frm, to_state, actor, auth, evidence_experiment_id, policy["criteria_hash"],
            {"note": note, "criteria_check": checks, "mode": "PAPER_OR_SHADOW_ONLY"}, _now(now_ms))
    return {"policy_id": policy_id, "from": frm, "state": to_state, "criteria_hash": policy["criteria_hash"], "criteria_check": checks}


def review(shadow: ShadowStore, registry, policy_id: str, *, evidence_experiment_id: str, drift_alert_level: Optional[str] = None,
           actor: str = "UNSPECIFIED", now_ms: Optional[int] = None) -> dict:
    """Ongoing forward evidence for a policy in SHADOW or PAPER. Real negative evidence (evidence floors met, verdict NO_EVIDENCE) demotes,
    because demotion is the safe direction. Thin evidence never demotes and never counts as support. A drift/health ALERT only recommends."""
    policy = history(shadow, policy_id)
    if policy is None:
        raise LifecycleError(f"UNKNOWN_POLICY: {policy_id}")
    if policy["state"] not in ("SHADOW", "PAPER"):
        raise LifecycleError(f"NOT_UNDER_REVIEW: state is {policy['state']}")
    exp = registry.history(evidence_experiment_id)
    res = (exp or {}).get("latest_results") or {}
    if exp is None or "verdict" not in res:
        raise LifecycleError("EVIDENCE_IS_NOT_A_FORWARD_VALIDATION_RESULT")
    verdict = res["verdict"]
    decision = {"NO_EVIDENCE": "DEMOTE", "FORWARD_PROMISING": "RETAIN", "INSUFFICIENT_EVIDENCE": "RETAIN_PENDING_EVIDENCE"}.get(verdict, "RETAIN_PENDING_EVIDENCE")
    recommend = drift_alert_level == "ALERT"
    at = _now(now_ms)
    payload = {"decision": decision, "verdict": verdict, "evidence": res.get("evidence"), "evidence_missing": res.get("evidence_missing"),
               "drift_alert_level": drift_alert_level, "demotion_recommended_by_alert": recommend}
    _insert(shadow, policy_id, "REVIEW", policy["state"], None, actor, None, evidence_experiment_id, policy["criteria_hash"], payload, at)
    if decision == "DEMOTE":
        _insert(shadow, policy_id, "TRANSITION", policy["state"], "DEMOTED", actor, None, evidence_experiment_id, policy["criteria_hash"],
                {"note": "Forward evidence met its floors and showed no stable improvement: demoted.", "criteria_check": None}, at)
    return {"policy_id": policy_id, "decision": decision, "state": "DEMOTED" if decision == "DEMOTE" else policy["state"], "demotion_recommended_by_alert": recommend}


check_authorization = _check_authorization      # public name: other modules may VALIDATE an authorization, never grant one
