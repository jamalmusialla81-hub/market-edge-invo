"""DATA 20 (#69), backend half: the read-only research status. Empty is empty; sections are never merged; nothing is written."""
import hashlib
import os

from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.dashboard import status as S
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.lifecycle import policy as LP
from tests.test_shadow import HEADERS, candidate, decision, scan_payload
from tests.test_policy_lifecycle import CRITERIA

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")


def make(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"), sizing_mode="SHADOW")
    return app, TestClient(app)


def test_an_empty_pipeline_reports_empty_not_placeholders(tmp_path):
    app, client = make(tmp_path)
    r = client.get("/research/status", headers=HEADERS).json()
    assert r["read_only"] is True and set(r["labels"]) == {"PRODUCTION", "SHADOW", "POST_OUTCOME_RESEARCH"}
    assert r["shadow"]["experiments"] == {"total": 0, "by_status": {}, "recent": []}
    assert r["shadow"]["challengers_deployed"] == [] and r["shadow"]["placebo_gates"] == [] and r["shadow"]["lifecycle"] == [] and r["shadow"]["drift_alerts"] == []
    assert r["post_outcome_research"]["walk_forward_evaluations"] == [] and r["post_outcome_research"]["forward_validations"] == []
    c = r["shadow"]["counts"]
    assert c["scans"] == 0 and c["independent_episodes"] == 0 and c["choice_scans"] == 0 and c["dataset_versions"] == []


def test_production_is_stated_as_untouched_and_the_three_labels_differ(tmp_path):
    _, client = make(tmp_path)
    r = client.get("/research/status", headers=HEADERS).json()
    assert r["production"]["risk_sizing_mode"] == "SHADOW" and r["production"]["live"] == "DISABLED" and r["production"]["controlled_by_research"] is False
    labels = list(r["labels"].values())
    assert len(set(labels)) == 3 and labels[0].startswith("PRODUCTION") and labels[1].startswith("SHADOW") and labels[2].startswith("POST-OUTCOME RESEARCH")
    assert r["production"]["label"] == labels[0] and r["shadow"]["label"] == labels[1] and r["post_outcome_research"]["label"] == labels[2]


def test_it_reflects_real_state_from_the_pipeline_and_writes_nothing(tmp_path):
    app, client = make(tmp_path)
    obs = [{"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate(strategy="A", rank=1))}, {"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate(direction="short", strategy="B", stop=102.0, tp1=98.0, tp2=96.0, rank=2, pick=False, scan_rank=2))}]
    app.state.shadow.record_scan(scan_payload(observations=obs))
    reg = ExperimentRegistry(app.state.shadow)
    eid = reg.create({"research_question": "q", "dataset_version": "d", "feature_set_version": "f", "model_type": "WALK_FORWARD_EVALUATION", "random_seed": 1, "baseline": "b"}, now_ms=1)["experiment_id"]
    reg.transition(eid, "RUNNING", now_ms=1)
    reg.transition(eid, "NO_EVIDENCE", results={"n_folds": 4, "challengers": {"ridge": {"evidence": "NO_EVIDENCE", "vs": {"random": {"mean_delta_R": 0.01, "ci95": [-0.1, 0.1], "stability": {"verdict": "MIXED"}}}}}}, now_ms=1)
    LP.register(app.state.shadow, policy_id="p1", policy_type="RANKING_MODEL", criteria=CRITERIA, now_ms=1)
    before = hashlib.sha256(open(app.state.shadow.path, "rb").read()).hexdigest()
    r = client.get("/research/status", headers=HEADERS).json()
    assert hashlib.sha256(open(app.state.shadow.path, "rb").read()).hexdigest() == before
    assert r["shadow"]["counts"]["independent_episodes"] >= 1 and r["shadow"]["counts"]["choice_scans"] == 1 and r["shadow"]["counts"]["candidate_observations"] == 2
    assert r["shadow"]["experiments"]["by_status"] == {"NO_EVIDENCE": 1}
    assert r["shadow"]["lifecycle"] == [{"policy_id": "p1", "policy_type": "RANKING_MODEL", "state": "RESEARCH", "subject_ref": None}]
    ev = r["post_outcome_research"]["walk_forward_evaluations"][0]
    assert ev["challengers"]["ridge"]["evidence"] == "NO_EVIDENCE" and ev["challengers"]["ridge"]["ci95_vs_random"] == [-0.1, 0.1] and ev["challengers"]["ridge"]["stability_vs_random"] == "MIXED"


def test_no_route_offers_a_control(tmp_path):
    app, _ = make(tmp_path)
    routes = [r for r in app.routes if getattr(r, "path", "") == "/research/status"]
    assert routes and all(getattr(r, "methods", set()) == {"GET"} for r in routes)
    import inspect
    src = inspect.getsource(S)
    for banned in ("INSERT", "UPDATE ", "DELETE ", ".transition(", ".register(", "deploy("):
        assert banned not in src, banned
