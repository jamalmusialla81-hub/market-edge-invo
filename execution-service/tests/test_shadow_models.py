"""DATA 9 (#59): forward-shadow challenger deployment. Observation only; placebo gate is a real precondition."""
import ast
import json
import os
import pathlib
import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.evaluation import placebo as P, walkforward as W
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.shadow import contracts as C, resolve as R
from market_edge_exec.shadow_models import deploy as D
from market_edge_exec.training import challengers as CH
from tests.test_placebo_gate import evaluate, signal_snapshot, noise_snapshot
from tests.test_shadow import BAR, HEADERS, T0, bars_path, candidate, decision, scan_payload

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")


def trained_and_gated(tmp_path, reg, snap, ev, *, gate=True, snapshot_hash=None):
    """Registry rows exactly as DATA 6/7/8 would leave them, with a real artifact on disk."""
    trained = CH.train_family(snap, 1, [m for m in CH.family(1) if m.name == "ridge"])
    out = tmp_path / "artifacts"
    out.mkdir(exist_ok=True)
    art = trained["models"]["ridge"]
    (out / "ridge.json").write_text(json.dumps(art["artifact"], sort_keys=True))
    tr = reg.create({"research_question": "t", "dataset_version": "d", "feature_set_version": "f", "model_type": "CHALLENGER_FAMILY:x", "random_seed": 1, "baseline": "Q"}, now_ms=1)["experiment_id"]
    reg.transition(tr, "RUNNING", now_ms=1)
    reg.transition(tr, "NO_EVIDENCE", results={"artifact_dir": str(out), "artifact_hashes": {"ridge": art["artifact_hash"]},
                                               "snapshot_content_hash": snapshot_hash or snap["manifest"]["content_hash"]}, now_ms=1)
    eval_id = W.log_evaluation(reg, ev, now_ms=2)["experiment_id"]
    if gate:
        P.log_gate(reg, P.run_gate(snap, ev, "ridge", runs=20), eval_id, now_ms=3)
    return tr, eval_id, art["artifact_hash"], out


@pytest.fixture(scope="module")
def signal():
    snap = signal_snapshot()
    return snap, evaluate(snap)


def app_and_registry(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"))
    return app, ExperimentRegistry(app.state.shadow), TestClient(app)


def scan(scan_id, ts, xs):
    obs = []
    for k, x in enumerate(xs):
        d = decision(cand=candidate(direction="long", strategy=f"S{k}", rank=k + 1, pick=(k == 0), scan_rank=k + 1))
        d["features"].update({"f": x, "g": 0.0})
        obs.append({"kind": "CANDIDATE", "asset": "BTC", "decision": d})
    return scan_payload(scan_id=scan_id, ts=ts, observations=obs)


# ---- the placebo precondition is real, checked code ------------------------------------------------
def test_deploy_refuses_without_a_placebo_pass_and_the_check_really_runs(tmp_path, signal, monkeypatch):
    snap, ev = signal
    app, reg, client = app_and_registry(tmp_path)
    tr, eval_id, _, _ = trained_and_gated(tmp_path, reg, snap, ev, gate=False)
    calls = []
    real = P.assert_placebo_passed
    monkeypatch.setattr(P, "assert_placebo_passed", lambda *a, **k: (calls.append(a), real(*a, **k))[1])
    with pytest.raises(D.DeploymentError, match="PLACEBO_GATE_REQUIRED"):
        D.deploy(reg, app.state.shadow, evaluation_experiment_id=eval_id, training_experiment_id=tr, model_name="ridge")
    assert calls, "deploy() never consulted the placebo gate"
    r = client.post("/research/shadow-models/deploy", headers=HEADERS, json={"evaluation_experiment_id": eval_id, "training_experiment_id": tr, "model_name": "ridge"})
    assert r.status_code == 409 and "PLACEBO_GATE_REQUIRED" in r.json()["detail"]
    assert client.get("/research/shadow-models", headers=HEADERS).json()["deployed"] == []


def test_deploy_needs_a_promising_evaluation_and_an_intact_matching_artifact(tmp_path, signal):
    snap, ev = signal
    app, reg, _ = app_and_registry(tmp_path)
    tr, eval_id, _, out = trained_and_gated(tmp_path, reg, snap, ev)
    (out / "ridge.json").write_text(json.dumps({"model": "ridge", "tampered": True}))
    with pytest.raises(D.DeploymentError, match="ARTIFACT_HASH_MISMATCH"):
        D.deploy(reg, app.state.shadow, evaluation_experiment_id=eval_id, training_experiment_id=tr, model_name="ridge")
    app2, reg2, _ = app_and_registry(tmp_path / "b") if (tmp_path / "b").mkdir() is None else None
    tr2, eval2, _, _ = trained_and_gated(tmp_path / "b", reg2, snap, ev, snapshot_hash="f" * 64)
    with pytest.raises(D.DeploymentError, match="DIFFERENT_SNAPSHOT"):
        D.deploy(reg2, app2.state.shadow, evaluation_experiment_id=eval2, training_experiment_id=tr2, model_name="ridge")


def test_a_deployment_records_once_and_can_be_retired(tmp_path, signal):
    snap, ev = signal
    app, reg, client = app_and_registry(tmp_path)
    tr, eval_id, art_hash, _ = trained_and_gated(tmp_path, reg, snap, ev)
    out = client.post("/research/shadow-models/deploy", headers=HEADERS, json={"evaluation_experiment_id": eval_id, "training_experiment_id": tr, "model_name": "ridge"}).json()
    assert out["status"] == "DEPLOYED_SHADOW_OBSERVATION_ONLY" and out["artifact_hash"] == art_hash
    assert client.post("/research/shadow-models/deploy", headers=HEADERS, json={"evaluation_experiment_id": eval_id, "training_experiment_id": tr, "model_name": "ridge"}).status_code == 409
    assert [d["model_key"] for d in client.get("/research/shadow-models", headers=HEADERS).json()["deployed"]] == [out["model_key"]]
    assert client.post(f"/research/shadow-models/{out['model_key']}/retire", headers=HEADERS, json={"note": "test"}).json()["status"] == "RETIRED"
    assert client.get("/research/shadow-models", headers=HEADERS).json()["deployed"] == []


# ---- zero influence, zero capital -------------------------------------------------------------------
def deployed_app(tmp_path, signal):
    snap, ev = signal
    app, reg, client = app_and_registry(tmp_path)
    tr, eval_id, _, _ = trained_and_gated(tmp_path, reg, snap, ev)
    key = client.post("/research/shadow-models/deploy", headers=HEADERS, json={"evaluation_experiment_id": eval_id, "training_experiment_id": tr, "model_name": "ridge"}).json()["model_key"]
    return app, client, key


def observations(app):
    with closing(sqlite3.connect(app.state.shadow.path)) as c:
        return c.execute("SELECT observation_id, decision_hash, production_rank, is_production_pick, execution_status FROM shadow_observations ORDER BY observation_id").fetchall()


def test_a_deployed_challenger_never_changes_the_scan_response_or_the_stored_production_observations(tmp_path, signal):
    plain = tmp_path / "plain"
    plain.mkdir()
    a_plain, _, c_plain = app_and_registry(plain)
    a_dep, c_dep, key = deployed_app(tmp_path / "dep" if (tmp_path / "dep").mkdir() is None else None, signal)
    payload = scan("scan-1", T0, [0.1, 2.0, -1.0])
    r_plain = c_plain.post("/shadow/scan", headers=HEADERS, json=json.loads(json.dumps(payload)))
    r_dep = c_dep.post("/shadow/scan", headers=HEADERS, json=json.loads(json.dumps(payload)))
    assert r_plain.status_code == r_dep.status_code == 200 and r_plain.json() == r_dep.json()
    assert observations(a_plain) == observations(a_dep), "production observations differ when a challenger is deployed"
    rows = c_dep.get(f"/research/shadow-models/{key}/predictions", headers=HEADERS).json()["predictions"]
    assert len(rows) == 1 and rows[0]["hash_ok"]
    rec = rows[0]["record"]
    assert rec["consumes_capital"] is False and rec["used_for_execution"] is False and rec["alters_production_ranking"] is False
    assert rec["mode"] == "SHADOW_OBSERVATION_ONLY" and rec["hypothetical_entry"]["hypothetical"] is True
    assert rec["hypothetical_exit_policy"].startswith("NOT_APPLICABLE")
    assert rec["production_choice"] is not None and len(rec["challenger_ranking"]) == 3 and len(rec["production_ranking"]) == 3
    assert isinstance(rec["hypothetical_sizing"], (dict, str))
    with closing(sqlite3.connect(a_plain.state.shadow.path)) as c:
        assert c.execute("SELECT count(*) FROM shadow_model_predictions").fetchone()[0] == 0     # the plain app recorded nothing extra


def test_a_challenger_touches_no_capital_orders_positions_or_intents(tmp_path, signal):
    (tmp_path / "d").mkdir()
    app, client, key = deployed_app(tmp_path / "d", signal)
    before = client.get("/paper/account", headers=HEADERS).json()
    with closing(sqlite3.connect(str(tmp_path / "d" / "p.sqlite3"))) as c:
        counts = [c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("intents", "orders", "fills", "positions", "paper_trades")]
    for i in range(3):
        client.post("/shadow/scan", headers=HEADERS, json=scan(f"scan-{i}", T0 + i * 6 * C.HOUR, [0.5, 1.5, -0.5]))
    after = client.get("/paper/account", headers=HEADERS).json()
    for k in ("equity", "balance", "open_positions", "open_notional", "realized_pnl", "unrealized_pnl", "fees"):
        assert after[k] == before[k], k
    with closing(sqlite3.connect(str(tmp_path / "d" / "p.sqlite3"))) as c:
        assert [c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("intents", "orders", "fills", "positions", "paper_trades")] == counts
    assert client.get("/paper/positions", headers=HEADERS).json()["positions"] == []
    assert len(client.get(f"/research/shadow-models/{key}/predictions", headers=HEADERS).json()["predictions"]) == 3


def test_a_failure_while_predicting_never_breaks_the_scan_path(tmp_path, signal, monkeypatch):
    (tmp_path / "f").mkdir()
    app, client, key = deployed_app(tmp_path / "f", signal)
    monkeypatch.setattr(D, "score", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    r = client.post("/shadow/scan", headers=HEADERS, json=scan("scan-x", T0, [1.0, 2.0]))
    assert r.status_code == 200 and r.json()["inserted"] == 2
    assert client.get(f"/research/shadow-models/{key}/predictions", headers=HEADERS).json()["predictions"] == []
    assert D.record_scan_predictions(app.state.shadow, scan("scan-y", T0, [1.0]))["failed"] == 1


def test_the_same_scan_posted_twice_records_one_prediction(tmp_path, signal):
    (tmp_path / "t").mkdir()
    app, client, key = deployed_app(tmp_path / "t", signal)
    for _ in range(2):
        client.post("/shadow/scan", headers=HEADERS, json=scan("scan-1", T0, [0.1, 2.0]))
    assert len(client.get(f"/research/shadow-models/{key}/predictions", headers=HEADERS).json()["predictions"]) == 1


def test_the_challenger_prefers_the_higher_scored_candidate_and_outcomes_join_once_resolved(tmp_path, signal):
    (tmp_path / "o").mkdir()
    app, client, key = deployed_app(tmp_path / "o", signal)
    client.post("/shadow/scan", headers=HEADERS, json=scan("scan-1", T0, [-2.0, 3.0]))     # the signal is monotonic in features.f
    pred = client.get(f"/research/shadow-models/{key}/predictions", headers=HEADERS).json()["predictions"][0]
    ranking = pred["record"]["challenger_ranking"]
    assert ranking[0]["score"] > ranking[1]["score"] and pred["challenger_outcome"] == {"status": "PENDING"}
    path = bars_path(R.first_bar_open(T0), [100 + i * .05 for i in range(C.FULL_WINDOW_MS // BAR + 2)])
    client.post("/shadow/resolve", headers=HEADERS, json={"coin": "BTC", "venue": "HYPERLIQUID", "interval": "5m", "candles": path, "now_ms": T0 + C.FULL_WINDOW_MS + C.HOUR})
    pred = client.get(f"/research/shadow-models/{key}/predictions", headers=HEADERS).json()["predictions"][0]
    assert pred["challenger_outcome"]["status"] == "RESOLVED" and pred["production_outcome"]["status"] == "RESOLVED"


FORBIDDEN = ("market_edge_exec.routing", "market_edge_exec.risk", "market_edge_exec.nautilus", "market_edge_exec.hummingbot", "market_edge_exec.persistence",
             "market_edge_exec.paper", "market_edge_exec.api", "market_edge_exec.control", "market_edge_exec.signal_bridge", "httpx", "requests", "urllib", "socket")


def test_the_shadow_models_package_cannot_reach_execution_or_the_network():
    for path in pathlib.Path(D.__file__).parent.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else ([node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            for name in names:
                assert not any(name == f or name.startswith(f + ".") for f in FORBIDDEN), f"{path.name} imports {name}"
