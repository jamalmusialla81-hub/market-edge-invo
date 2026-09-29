"""DATA 11 (#61): one shared, evidence-gated lifecycle. Illegal skips, LIVE, unauthorized and unmet-criteria moves are all refused."""
import ast
import os
import pathlib
import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.evaluation import forward as F
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.lifecycle import policy as L
from tests.test_shadow import HEADERS

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
HUMAN = {"authorized_by": "Jakob", "authorization_ref": "thread message 'promote it to paper'", "statement": "I authorize SHADOW to PAPER for this policy"}
PAPER = {"evidence_kind": "FORWARD_VALIDATION", "min_resolved_scans": 60, "min_independent_episodes": 30, "min_choice_scans": 20, "min_forward_days": 14, "min_assets": 4, "min_regimes": 2}
CRITERIA = {"shadow_entry": {"evidence_experiment_status": "PROMISING"}, "paper_entry": PAPER}


@pytest.fixture()
def env(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"))
    return app.state.shadow, ExperimentRegistry(app.state.shadow), app


def experiment(reg, *, status="PROMISING", model_type="CHALLENGER_EVALUATION", results=None, model_key="m1", at=5_000):
    cfg = {"research_question": "q", "dataset_version": "d", "feature_set_version": "f", "model_type": model_type, "random_seed": 1, "baseline": "b",
           "hyperparameters": {"model_key": model_key}}
    eid = reg.create(cfg, actor="t", now_ms=at, experiment_id=f"e-{model_type}-{status}-{at}-{model_key}")["experiment_id"]
    reg.transition(eid, "RUNNING", now_ms=at)
    reg.transition(eid, status, results=results if results is not None else {"ok": True}, now_ms=at)
    return eid


def forward_result(**over):
    ev = {"resolved_scans": 200, "independent_episodes": 150, "choice_scans": 90, "forward_days": 40, "assets": 6, "regimes": 3}
    ev.update(over)
    return {"verdict": "FORWARD_PROMISING", "evidence": ev, "evidence_missing": []}


def registered(shadow, pid="rank-1", at=1_000, subject="m1"):
    L.register(shadow, policy_id=pid, policy_type="RANKING_MODEL", criteria=CRITERIA, subject_ref=subject, actor="t", now_ms=at)
    return pid


def to_shadow(shadow, reg, pid="rank-1"):
    ev = experiment(reg, at=5_500)
    L.transition(shadow, reg, pid, "SHADOW", authorization=HUMAN, evidence_experiment_id=ev, now_ms=6_000)
    return ev


# ---- state machine -------------------------------------------------------------------------------------------
def test_a_direct_research_to_paper_transition_is_rejected(env):
    shadow, reg, _ = env
    pid = registered(shadow)
    ev = experiment(reg, model_type="FORWARD_VALIDATION", results=forward_result())
    with pytest.raises(L.LifecycleError, match="ILLEGAL_TRANSITION: RESEARCH -> PAPER"):
        L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN, evidence_experiment_id=ev)
    assert L.state_of(shadow, pid) == "RESEARCH"


def test_no_live_state_exists_anywhere_in_the_framework():
    assert "LIVE" not in L.STATES
    names = set(L.TRANSITIONS) | {t for v in L.TRANSITIONS.values() for t in v}
    assert not any("LIVE" in str(n).upper() for n in names if n)
    tree = ast.parse(pathlib.Path(L.__file__).read_text())
    strings = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    assert not {s for s in strings if s.upper() in ("LIVE", "MAINNET", "PRODUCTION_LIVE")}
    for state in L.STATES:
        for target in L.TRANSITIONS.get(state, ()):
            assert target in L.STATES


def test_live_cannot_be_requested_through_the_api_or_the_function(env):
    shadow, reg, app = env
    pid = registered(shadow)
    with pytest.raises(L.LifecycleError, match="UNKNOWN_STATE: LIVE"):
        L.transition(shadow, reg, pid, "LIVE", authorization=HUMAN)
    r = TestClient(app).post(f"/research/lifecycle/policies/{pid}/transition", headers=HEADERS, json={"to_state": "LIVE", "authorization": HUMAN})
    assert r.status_code == 422 and "UNKNOWN_STATE" in r.json()["detail"]


def test_a_full_walk_through_the_lifecycle_including_an_attempted_skip(env):
    shadow, reg, _ = env
    pid = registered(shadow)
    with pytest.raises(L.LifecycleError, match="ILLEGAL"):
        L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN)
    to_shadow(shadow, reg)
    fv = experiment(reg, model_type="FORWARD_VALIDATION", results=forward_result(), at=7_000)
    out = L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN, evidence_experiment_id=fv, now_ms=8_000)
    assert out["state"] == "PAPER" and all(c["ok"] for c in out["criteria_check"])
    assert [(e["event_type"], e["to_state"]) for e in L.history(shadow, pid)["events"]] == [("REGISTERED", "RESEARCH"), ("TRANSITION", "SHADOW"), ("TRANSITION", "PAPER")]
    assert L.transition(shadow, reg, pid, "DEMOTED", note="test", now_ms=9_000)["state"] == "DEMOTED"      # demotion needs no authorization
    with pytest.raises(L.LifecycleError, match="ILLEGAL"):
        L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN)                                       # no way back except through RESEARCH


# ---- authorization ------------------------------------------------------------------------------------------------
def test_a_transition_without_a_logged_authorization_is_rejected_even_if_every_gate_passed(env):
    shadow, reg, _ = env
    pid = registered(shadow)
    ev = experiment(reg)
    for bad in (None, {}, {"authorized_by": "Jakob"}, {**HUMAN, "statement": "  "}):
        with pytest.raises(L.LifecycleError, match="AUTHORIZATION_REQUIRED"):
            L.transition(shadow, reg, pid, "SHADOW", authorization=bad, evidence_experiment_id=ev)
    assert L.state_of(shadow, pid) == "RESEARCH"
    to_shadow(shadow, reg)
    fv = experiment(reg, model_type="FORWARD_VALIDATION", results=forward_result(), at=7_000)
    with pytest.raises(L.LifecycleError, match="AUTHORIZATION_REQUIRED"):
        L.transition(shadow, reg, pid, "PAPER", evidence_experiment_id=fv)


@pytest.mark.parametrize("who", ["system", "CI", "auto-promoter", "Claude", "bot", "scheduler", "cron"])
def test_an_automated_actor_cannot_authorize(env, who):
    shadow, reg, _ = env
    pid = registered(shadow)
    with pytest.raises(L.LifecycleError, match="AUTHORIZATION_MUST_BE_A_PERSON"):
        L.transition(shadow, reg, pid, "SHADOW", authorization={**HUMAN, "authorized_by": who}, evidence_experiment_id=experiment(reg))


def test_the_authorization_is_recorded_on_the_event(env):
    shadow, reg, _ = env
    pid = registered(shadow)
    to_shadow(shadow, reg)
    e = L.history(shadow, pid)["events"][-1]
    assert e["authorization"]["authorized_by"] == "Jakob" and e["authorization"]["authorization_ref"]


# ---- preregistered criteria -----------------------------------------------------------------------------------------
def test_criteria_must_exist_before_anything_and_cannot_be_weaker_than_the_floors(env):
    shadow, _, _ = env
    with pytest.raises(L.LifecycleError, match="CRITERIA_REQUIRED"):
        L.register(shadow, policy_id="p", policy_type="RANKING_MODEL", criteria=None)
    with pytest.raises(L.LifecycleError, match="CRITERIA_TOO_WEAK: paper_entry.min_resolved_scans=5"):
        L.register(shadow, policy_id="p", policy_type="RANKING_MODEL", criteria={**CRITERIA, "paper_entry": {**PAPER, "min_resolved_scans": 5}})
    with pytest.raises(L.LifecycleError, match="UNKNOWN_POLICY_TYPE"):
        L.register(shadow, policy_id="p", policy_type="LIVE_TRADER", criteria=CRITERIA)


def test_criteria_are_frozen_and_compared_not_replaced(env):
    shadow, reg, _ = env
    pid = registered(shadow)
    with pytest.raises(L.LifecycleError, match="POLICY_EXISTS"):
        L.register(shadow, policy_id=pid, policy_type="RANKING_MODEL", criteria={**CRITERIA, "paper_entry": {**PAPER, "min_resolved_scans": 61}})
    to_shadow(shadow, reg)
    weak = experiment(reg, model_type="FORWARD_VALIDATION", results=forward_result(resolved_scans=59), at=7_000)   # one below the preregistered bar
    with pytest.raises(L.LifecycleError, match="CRITERIA_NOT_MET: min_resolved_scans required 60, actual 59"):
        L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN, evidence_experiment_id=weak)
    assert L.state_of(shadow, pid) == "SHADOW"


def test_stored_criteria_that_no_longer_match_their_hash_fail_closed(env):
    shadow, reg, _ = env
    pid = registered(shadow)
    ev = experiment(reg)
    # the immutability triggers stop an in-place edit, so simulate tampering by dropping the guard first
    with closing(sqlite3.connect(shadow.path)) as c:
        c.execute("DROP TRIGGER policy_lifecycle_events_no_update")
        import zlib, json
        row = c.execute("SELECT event_id, payload FROM policy_lifecycle_events WHERE policy_id=?", (pid,)).fetchone()
        data = json.loads(zlib.decompress(row[1]))
        data["criteria"]["paper_entry"]["min_resolved_scans"] = 1
        c.execute("UPDATE policy_lifecycle_events SET payload=? WHERE event_id=?", (zlib.compress(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()), row[0]))
        c.commit()
    with pytest.raises(L.LifecycleError, match="CRITERIA_TAMPERED"):
        L.transition(shadow, reg, pid, "SHADOW", authorization=HUMAN, evidence_experiment_id=ev)


def test_evidence_that_predates_the_preregistration_is_refused(env):
    shadow, reg, _ = env
    pid = registered(shadow, at=10_000)
    old = experiment(reg, at=5_000)          # created before the criteria were frozen
    with pytest.raises(L.LifecycleError, match="EVIDENCE_PREDATES_PREREGISTRATION"):
        L.transition(shadow, reg, pid, "SHADOW", authorization=HUMAN, evidence_experiment_id=old)


def test_evidence_must_be_the_right_kind_for_the_right_subject_and_promising(env):
    shadow, reg, _ = env
    pid = registered(shadow)
    to_shadow(shadow, reg)
    cases = [(experiment(reg, model_type="WALK_FORWARD_EVALUATION", results=forward_result(), at=7_001), "evidence_is_forward_validation"),
             (experiment(reg, model_type="FORWARD_VALIDATION", results=forward_result(), model_key="other", at=7_002), "evidence_is_for_this_subject"),
             (experiment(reg, model_type="FORWARD_VALIDATION", status="NO_EVIDENCE", results={**forward_result(), "verdict": "INSUFFICIENT_EVIDENCE"}, at=7_003), "evidence_experiment_status"),
             (experiment(reg, model_type="FORWARD_VALIDATION", results={**forward_result(), "evidence_missing": ["x"]}, at=7_004), "no_evidence_missing")]
    for ev, expect in cases:
        with pytest.raises(L.LifecycleError, match=expect):
            L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN, evidence_experiment_id=ev)
    with pytest.raises(L.LifecycleError, match="EVIDENCE_REQUIRED"):
        L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN)
    with pytest.raises(L.LifecycleError, match="UNKNOWN_EVIDENCE_EXPERIMENT"):
        L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN, evidence_experiment_id="nope")
    assert L.state_of(shadow, pid) == "SHADOW"


def test_a_real_forward_validation_result_can_satisfy_the_criteria(env):
    """End to end with DATA 10's own output, not a hand-written dict."""
    from tests.test_forward_validation import make_scans
    shadow, reg, _ = env
    pid = registered(shadow)
    to_shadow(shadow, reg)
    res = F.validate(make_scans(200, edge=1.0), bootstrap_n=200)
    assert res["verdict"] == "FORWARD_PROMISING"
    ev = reg.create({"research_question": "fv", "dataset_version": "d", "feature_set_version": "n/a", "model_type": "FORWARD_VALIDATION", "random_seed": 1, "baseline": "b",
                     "hyperparameters": {"model_key": "m1"}}, now_ms=9_000)["experiment_id"]
    reg.transition(ev, "RUNNING", now_ms=9_000)
    reg.transition(ev, "PROMISING", results=res, now_ms=9_000)
    assert L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN, evidence_experiment_id=ev, now_ms=9_500)["state"] == "PAPER"


# ---- demotion --------------------------------------------------------------------------------------------------------
def promoted_to_paper(shadow, reg):
    pid = registered(shadow)
    to_shadow(shadow, reg)
    fv = experiment(reg, model_type="FORWARD_VALIDATION", results=forward_result(), at=7_000)
    L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN, evidence_experiment_id=fv, now_ms=8_000)
    return pid


def test_real_negative_forward_evidence_demotes_but_thin_evidence_does_not(env):
    shadow, reg, _ = env
    pid = promoted_to_paper(shadow, reg)
    thin = experiment(reg, model_type="FORWARD_VALIDATION", status="NO_EVIDENCE", results={"verdict": "INSUFFICIENT_EVIDENCE", "evidence": {}, "evidence_missing": ["x"]}, at=9_000)
    assert L.review(shadow, reg, pid, evidence_experiment_id=thin, now_ms=9_100)["decision"] == "RETAIN_PENDING_EVIDENCE" and L.state_of(shadow, pid) == "PAPER"
    bad = experiment(reg, model_type="FORWARD_VALIDATION", status="NO_EVIDENCE", results={"verdict": "NO_EVIDENCE", "evidence": forward_result()["evidence"], "evidence_missing": []}, at=9_200)
    out = L.review(shadow, reg, pid, evidence_experiment_id=bad, now_ms=9_300)
    assert out["decision"] == "DEMOTE" and out["state"] == "DEMOTED" and L.state_of(shadow, pid) == "DEMOTED"


def test_a_drift_alert_only_recommends_and_never_moves_state(env):
    shadow, reg, _ = env
    pid = promoted_to_paper(shadow, reg)
    ok = experiment(reg, model_type="FORWARD_VALIDATION", results=forward_result(), at=9_000)
    out = L.review(shadow, reg, pid, evidence_experiment_id=ok, drift_alert_level="ALERT", now_ms=9_100)
    assert out["decision"] == "RETAIN" and out["demotion_recommended_by_alert"] is True and L.state_of(shadow, pid) == "PAPER"


def test_re_entry_after_demotion_needs_authorization_and_then_fresh_evidence(env):
    shadow, reg, _ = env
    pid = promoted_to_paper(shadow, reg)
    L.transition(shadow, reg, pid, "DEMOTED", now_ms=9_000)
    with pytest.raises(L.LifecycleError, match="AUTHORIZATION_REQUIRED"):
        L.transition(shadow, reg, pid, "RESEARCH")
    assert L.transition(shadow, reg, pid, "RESEARCH", authorization=HUMAN, now_ms=9_100)["state"] == "RESEARCH"
    with pytest.raises(L.LifecycleError, match="ILLEGAL"):
        L.transition(shadow, reg, pid, "PAPER", authorization=HUMAN)


# ---- append-only, shared vocabulary, API --------------------------------------------------------------------------------
def test_lifecycle_events_cannot_be_edited_or_deleted(env):
    shadow, _, _ = env
    registered(shadow)
    with closing(sqlite3.connect(shadow.path)) as c:
        for sql in ("UPDATE policy_lifecycle_events SET to_state='PAPER'", "DELETE FROM policy_lifecycle_events"):
            with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
                c.execute(sql)


def test_every_policy_type_uses_the_same_lifecycle(env):
    shadow, reg, _ = env
    for i, t in enumerate(L.POLICY_TYPES):
        L.register(shadow, policy_id=f"p{i}", policy_type=t, criteria={"shadow_entry": {"evidence_experiment_status": "PROMISING"},
                                                                       "paper_entry": {"evidence_kind": "PROMISING_EXPERIMENT"}}, now_ms=1_000)
        L.transition(shadow, reg, f"p{i}", "SHADOW", authorization=HUMAN, evidence_experiment_id=experiment(reg, at=5_000 + i), now_ms=6_000)
        with pytest.raises(L.LifecycleError, match="ILLEGAL"):
            L.transition(shadow, reg, f"p{i}", "RESEARCH", authorization=HUMAN)
    assert {p["state"] for p in L.list_policies(shadow)} == {"SHADOW"}


def test_the_api_walks_the_lifecycle_and_refuses_illegal_moves(env):
    shadow, reg, app = env
    client = TestClient(app)
    assert client.post("/research/lifecycle/policies", headers=HEADERS, json={"policy_id": "r1", "policy_type": "RANKING_MODEL", "criteria": CRITERIA, "subject_ref": "m1"}).status_code == 200
    ev = experiment(reg, at=int(4_000_000_000_000))
    r = client.post("/research/lifecycle/policies/r1/transition", headers=HEADERS, json={"to_state": "PAPER", "authorization": HUMAN, "evidence_experiment_id": ev})
    assert r.status_code == 409 and "ILLEGAL_TRANSITION" in r.json()["detail"]
    r = client.post("/research/lifecycle/policies/r1/transition", headers=HEADERS, json={"to_state": "SHADOW", "evidence_experiment_id": ev})
    assert r.status_code == 422 and "AUTHORIZATION_REQUIRED" in r.json()["detail"]
    r = client.post("/research/lifecycle/policies/r1/transition", headers=HEADERS, json={"to_state": "SHADOW", "authorization": HUMAN, "evidence_experiment_id": ev})
    assert r.status_code == 200 and r.json()["state"] == "SHADOW"
    got = client.get("/research/lifecycle/policies/r1", headers=HEADERS).json()
    assert got["state"] == "SHADOW" and got["live_reachable"] is False and "LIVE" not in got["label"].split("NO LIVE")[0]
    assert client.get("/research/lifecycle/policies/none", headers=HEADERS).status_code == 404
    assert client.get("/research/lifecycle/policies", headers=HEADERS).json()["states"] == ["RESEARCH", "SHADOW", "PAPER", "DEMOTED"]


def test_the_module_touches_no_execution_paper_or_production_code():
    src = pathlib.Path(L.__file__).read_text()
    for banned in ("execution_router", "market_edge_exec.paper", "import paper", "place_order", "submit", "risk_sizing", "exit_manager"):
        assert banned not in src, banned
