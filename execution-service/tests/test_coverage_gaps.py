"""SIDE 8 (#37): narrowly scoped tests for safety invariants the coverage
audit (TEST_COVERAGE_REPORT.md) found without a direct test. Additive only."""
import os
import sqlite3

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.shadow.store import IMMUTABLE
from tests.test_shadow import BAR, T0, bars_path, candidate, decision, scan_payload
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow import resolve as R

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
PUBLIC = {"/health", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}


def test_every_route_except_health_rejects_a_missing_api_key(tmp_path):
    """The per-endpoint list in test_desktop_api.py is static; this walks the
    app's real route table so a newly added endpoint cannot ship without auth."""
    app = create_app(db_path=str(tmp_path / "paper.sqlite3"))
    client = TestClient(app)
    checked = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.path in PUBLIC:
            continue
        path = route.path.replace("{", "").replace("}", "")   # any value; auth runs first
        for method in route.methods - {"HEAD", "OPTIONS"}:
            r = client.request(method, path, json={} if method in ("POST", "PUT", "PATCH") else None)
            assert r.status_code == 401, f"{method} {route.path} answered {r.status_code} without an API key"
            checked.append(f"{method} {route.path}")
    assert len(checked) >= 30   # the table really was walked (39 routes on main 9d9ac01)


def test_every_immutable_shadow_table_refuses_update_and_delete(tmp_path):
    """test_shadow.py checks observations and scans; this covers the rest of
    IMMUTABLE (labels, hindsight, forward_paper_executed) with real rows."""
    from market_edge_exec.shadow.store import ShadowStore
    store = ShadowStore(str(tmp_path / "shadow.sqlite3"))
    store.record_scan(scan_payload(submitted_signal_id="scan-1-BTC",
                                   execution={"decision": "EXECUTED", "signal_id": "scan-1-BTC", "trade": {"qty": 1}},
                                   observations=[{"kind": "CANDIDATE", "asset": "BTC", "submitted": True, "decision": decision(cand=candidate())}]))
    store.record_execution_quality({"status": "CLOSED", "signal_id": "scan-1-BTC", "trade_id": "scan-1-BTC", "direction": "long",
                                    "exits": [], "opened_at_ms": T0 + 5, "signal_timestamp": T0})
    store.record_quality_verdicts([{"subject_kind": "SHADOW_OBSERVATION", "subject_id": "x", "verdict": "VALID", "reasons": []}], "TEST", now_ms=T0)
    from market_edge_exec.experiments.registry import ExperimentRegistry
    ExperimentRegistry(store).create({"research_question": "q", "dataset_version": "d", "feature_set_version": "f", "model_type": "m",
                                      "random_seed": 1, "baseline": "b"}, now_ms=T0)
    store.record_drift_baseline("b", T0, T0 + 1, {"numeric": {}, "categorical": {}}, "T", now_ms=T0)
    store.record_drift_alerts("b", 1, [{"dimension": "score", "level": "ALERT", "statistic": 1.0}], "T", T0)
    store._connect().execute("INSERT INTO shadow_model_deployments (model_key, event, model_name, actor, at_ms, detail) VALUES ('k','DEPLOYED','ridge','t',1,x'00')").connection.commit()
    store._connect().execute("INSERT INTO policy_lifecycle_events (policy_id, event_type, actor, payload, at_ms) VALUES ('p','REGISTERED','a',x'00',1)").connection.commit()
    store._connect().execute("INSERT INTO shadow_model_predictions VALUES ('p','k','h','s',1,NULL,NULL,x'00','h',1)").connection.commit()
    first = R.first_bar_open(T0)
    closes = [100 + min(i, 60) * 0.1 for i in range(C.FULL_WINDOW_MS // BAR + 2)]
    store.resolve("BTC", bars_path(first, closes, spread=0.05), "HYPERLIQUID", "5m", now_ms=T0 + C.FULL_WINDOW_MS + C.HOUR)
    with sqlite3.connect(store.path) as conn:
        for table in IMMUTABLE:
            assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] > 0, f"{table} has no row to protect"
            col = {"data_quality_verdicts": "checker_version", "experiment_events": "actor", "drift_baselines": "drift_version", "drift_alerts": "drift_version", "shadow_model_deployments": "actor", "shadow_model_predictions": "artifact_hash", "policy_lifecycle_events": "actor"}.get(table, "dataset_version")
            for sql in (f"UPDATE {table} SET {col}='TAMPERED'", f"DELETE FROM {table}"):
                with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
                    conn.execute(sql)
