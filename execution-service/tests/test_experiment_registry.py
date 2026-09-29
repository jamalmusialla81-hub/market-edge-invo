"""DATA 5 (#55): the experiment registry."""
import os
import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.experiments.registry import ExperimentRegistry, RegistryError, STATUSES
from market_edge_exec.shadow.store import ShadowStore

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
HEADERS = {"X-API-Key": "test-key"}
CONFIG = {"research_question": "does a logistic challenger beat Quant rank on forward candidates?", "dataset_version": "DATASET-SNAPSHOT-TEST",
          "feature_set_version": "FEATURE-SET-V1", "model_type": "logistic", "hyperparameters": {"l2": 1.0}, "random_seed": 7,
          "folds": {"kind": "walk_forward", "n": 5}, "cost_assumptions": {"fee_pct": 0.045}, "evaluation_horizon": "72h",
          "cluster_resampling": {"unit": "episode", "draws": 2000}, "baseline": "QUANT_RANK", "placebo": {"shuffles": 200}, "source_commit": "abc123"}
PASS = {"gate": "PROMOTION_READINESS_V1", "evaluation": {"decision": "PROMOTION_READY", "modelId": "m", "integrity": {"noLookahead": True, "datasetIntegrity": True}}}


@pytest.fixture
def reg(tmp_path):
    return ExperimentRegistry(ShadowStore(str(tmp_path / "s.sqlite3")))


def test_full_lifecycle_history_is_preserved_and_queryable(reg):
    exp = reg.create(CONFIG, now_ms=1000)["experiment_id"]
    reg.transition(exp, "RUNNING", now_ms=2000)
    reg.transition(exp, "PROMISING", results={"mean_r": 0.1}, confidence_intervals={"mean_r": [0.02, 0.18]}, now_ms=3000)
    reg.transition(exp, "SHADOW_CANDIDATE", promotion_status=PASS, now_ms=4000)
    h = reg.history(exp)
    assert [e["status"] for e in h["events"]] == ["PLANNED", "RUNNING", "PROMISING", "SHADOW_CANDIDATE"]
    assert [e["at_ms"] for e in h["events"]] == [1000, 2000, 3000, 4000]
    assert h["status"] == "SHADOW_CANDIDATE" and h["latest_results"] == {"mean_r": 0.1} and h["latest_promotion_status"] == PASS
    assert h["config"]["dataset_version"] == "DATASET-SNAPSHOT-TEST" and h["config"]["source_commit"] == "abc123"
    assert [x["experiment_id"] for x in reg.list(status="SHADOW_CANDIDATE")] == [exp] and reg.list(status="RUNNING") == []


def test_every_status_is_from_the_enumerated_set_and_illegal_moves_are_refused(reg):
    assert set(STATUSES) == {"PLANNED", "RUNNING", "FAILED", "NO_EVIDENCE", "PROMISING", "SHADOW_CANDIDATE", "REJECTED", "SUPERSEDED"}
    exp = reg.create(CONFIG)["experiment_id"]
    for bad in ("PROFITABLE", "SUCCESS", "planned"):
        with pytest.raises(RegistryError, match="UNKNOWN_STATUS"):
            reg.transition(exp, bad)
    with pytest.raises(RegistryError, match="ILLEGAL_TRANSITION: PLANNED -> PROMISING"):
        reg.transition(exp, "PROMISING", results={"x": 1})
    reg.transition(exp, "RUNNING")
    reg.transition(exp, "FAILED", note="out of memory")
    with pytest.raises(RegistryError, match="ILLEGAL_TRANSITION: FAILED -> RUNNING"):
        reg.transition(exp, "RUNNING")
    reg.transition(exp, "SUPERSEDED")
    with pytest.raises(RegistryError, match="ILLEGAL_TRANSITION"):
        reg.transition(exp, "RUNNING")
    with pytest.raises(RegistryError, match="UNKNOWN_EXPERIMENT"):
        reg.transition("exp-nope", "RUNNING")


def test_shadow_candidate_needs_a_recorded_gate_that_actually_passed(reg):
    exp = reg.create(CONFIG)["experiment_id"]
    reg.transition(exp, "RUNNING")
    reg.transition(exp, "PROMISING", results={"mean_r": 0.1})
    with pytest.raises(RegistryError, match="SHADOW_CANDIDATE_REQUIRES_PROMOTION_STATUS"):
        reg.transition(exp, "SHADOW_CANDIDATE")
    with pytest.raises(RegistryError, match="UNKNOWN_GATE"):
        reg.transition(exp, "SHADOW_CANDIDATE", promotion_status={"gate": "TRUST_ME", "evaluation": {"decision": "PROMOTION_READY"}})
    for decision in ("INSUFFICIENT_EVIDENCE", "REJECTED"):
        with pytest.raises(RegistryError, match="GATE_NOT_PASSED"):
            reg.transition(exp, "SHADOW_CANDIDATE", promotion_status={"gate": "PROMOTION_READINESS_V1", "evaluation": {"decision": decision}})
    failed_integrity = {"gate": "PROMOTION_READINESS_V1", "evaluation": {"decision": "PROMOTION_READY", "integrity": {"noLookahead": False}}}
    with pytest.raises(RegistryError, match="hard integrity gate failed"):
        reg.transition(exp, "SHADOW_CANDIDATE", promotion_status=failed_integrity)
    with pytest.raises(RegistryError, match="UNKNOWN_PROMOTION_DECISION"):
        reg.transition(exp, "SHADOW_CANDIDATE", promotion_status={"gate": "PROMOTION_READINESS_V1", "evaluation": {"decision": "LOOKS_GREAT"}})
    assert reg.status_of(exp) == "PROMISING"        # every refusal left the experiment where it was
    reg.transition(exp, "SHADOW_CANDIDATE", promotion_status={"gate": "PROMOTION_READINESS_V1", "evaluation": {"decision": "KEEP_CHALLENGER"}})
    assert reg.status_of(exp) == "SHADOW_CANDIDATE"


def test_results_are_required_for_outcome_statuses(reg):
    exp = reg.create(CONFIG)["experiment_id"]
    reg.transition(exp, "RUNNING")
    for status in ("PROMISING", "NO_EVIDENCE", "REJECTED"):
        with pytest.raises(RegistryError, match="REQUIRES_RESULTS"):
            reg.transition(exp, status)


def test_required_config_and_unknown_fields_and_repeated_trials(reg):
    with pytest.raises(RegistryError, match="MISSING_REQUIRED_FIELDS"):
        reg.create({"research_question": "q"})
    with pytest.raises(RegistryError, match="UNKNOWN_FIELDS"):
        reg.create({**CONFIG, "verdict": "profitable"})
    a = reg.create(CONFIG)
    b = reg.create({**CONFIG, "research_question": "same experiment, reworded"})     # identical trial, different words
    c = reg.create({**CONFIG, "random_seed": 8})                                     # a different seed is a different trial
    assert a["attempt"] == 1 and a["repeat_of"] is None
    assert b["attempt"] == 2 and b["repeat_of"] == [a["experiment_id"]] and b["config_hash"] == a["config_hash"]
    assert c["attempt"] == 1 and c["config_hash"] != a["config_hash"]
    assert reg.history(b["experiment_id"])["repeat_of"] == [a["experiment_id"]]      # visible, not hidden
    with pytest.raises(RegistryError, match="EXPERIMENT_EXISTS"):
        reg.create(CONFIG, experiment_id=a["experiment_id"])


def test_events_are_immutable(reg):
    exp = reg.create(CONFIG)["experiment_id"]
    with closing(sqlite3.connect(reg.shadow.path)) as conn:
        for sql in ("UPDATE experiment_events SET status='SHADOW_CANDIDATE'", "DELETE FROM experiment_events"):
            with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
                conn.execute(sql)
    assert reg.status_of(exp) == "PLANNED"


def test_api_lifecycle_and_errors(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"))
    c = TestClient(app)
    made = c.post("/research/experiments", json={"config": CONFIG, "actor": "test"}, headers=HEADERS).json()
    exp = made["experiment_id"]
    assert c.post(f"/research/experiments/{exp}/status", json={"status": "RUNNING"}, headers=HEADERS).status_code == 200
    assert c.post(f"/research/experiments/{exp}/status", json={"status": "SHADOW_CANDIDATE"}, headers=HEADERS).status_code == 409
    assert c.post(f"/research/experiments/{exp}/status", json={"status": "AMAZING"}, headers=HEADERS).status_code == 422
    assert c.post("/research/experiments", json={"config": {}}, headers=HEADERS).status_code == 422
    got = c.get(f"/research/experiments/{exp}", headers=HEADERS).json()
    assert got["status"] == "RUNNING" and [e["status"] for e in got["events"]] == ["PLANNED", "RUNNING"]
    listing = c.get("/research/experiments", headers=HEADERS).json()
    assert listing["experiments"][0]["experiment_id"] == exp and "SHADOW_CANDIDATE" in listing["statuses"]
    assert c.get("/research/experiments/nope", headers=HEADERS).status_code == 404
    assert c.get("/research/experiments").status_code in (401, 403)
