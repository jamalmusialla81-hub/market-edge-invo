"""Test 14 (backend disconnect / divergence causes a safe halt) and 15 (kill
switch blocks new intents) exercised through the actual FastAPI endpoints,
plus /health and auth."""
import os

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}


@pytest.fixture
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "api.sqlite3"))
    return TestClient(app), app


def test_health_needs_no_auth_and_reports_paper_only(client):
    test_client, _ = client
    response = test_client.get("/health")
    assert response.status_code == 200
    assert response.json()["paper_only"] is True


def test_execution_intent_requires_api_key(client):
    test_client, _ = client
    response = test_client.post("/execution/intent", json={"signal_id": "s1"})
    assert response.status_code == 401


def test_execution_intent_end_to_end_then_positions_reflect_it(client):
    test_client, _ = client
    payload = {"signal_id": "s1", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.1, "order_type": "MARKET", "strategy_id": "alpha", "limit_price": 60000, "stop": 56000, "leverage": 1}
    response = test_client.post("/execution/intent", json=payload, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["fill"]["status"] == "FILLED"
    positions = test_client.get("/positions", headers=HEADERS).json()["positions"]
    assert any(p["instrument"] == "BTC-PERP" for p in positions)


def test_duplicate_intent_over_the_api_is_rejected(client):
    test_client, _ = client
    payload = {"signal_id": "s1", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.1, "order_type": "MARKET", "strategy_id": "alpha", "limit_price": 60000, "stop": 56000, "leverage": 1}
    test_client.post("/execution/intent", json=payload, headers=HEADERS)
    response = test_client.post("/execution/intent", json=payload, headers=HEADERS)
    assert response.status_code == 409


def test_reconcile_divergence_halts_new_intents(client):
    test_client, app = client
    # Force a divergence: Hummingbot mock reports a position Nautilus never recorded.
    app.state.hummingbot._positions["ETH-PERP"] = 1.0  # noqa: SLF001 (test-only introspection)
    reconcile_response = test_client.post("/reconcile", json={}, headers=HEADERS)
    assert reconcile_response.status_code == 200
    assert reconcile_response.json()["reconciled"] is False
    assert reconcile_response.json()["halted"] is True

    payload = {"signal_id": "s-after-halt", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.1, "order_type": "MARKET", "strategy_id": "alpha", "limit_price": 60000, "stop": 56000, "leverage": 1}
    blocked = test_client.post("/execution/intent", json=payload, headers=HEADERS)
    assert blocked.status_code == 409


def test_execution_signal_endpoint_sizes_by_risk_and_executes(client):
    import time
    test_client, _ = client
    signal_payload = {"signal_id": "me-1", "asset": "BTC", "direction": "long", "timestamp": int(time.time() * 1000), "entry": 60000, "stop": 56000, "strategy_id": "market-edge-alpha"}
    response = test_client.post("/execution/signal", json={"signal": signal_payload, "instrument": "BTC-PERP"}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is True
    assert body["fill"]["status"] == "FILLED"


def test_reconcile_does_not_false_positive_on_nautilus_native_fills(client):
    # Found via the real Part F forward loop: a NAUTILUS_NATIVE fill has no
    # reason to appear in Hummingbot's position list, and previously
    # reconcile_now() compared ALL canonical positions (including
    # NAUTILUS_NATIVE ones) against Hummingbot's, engaging the kill switch
    # on every single real trade.
    test_client, _ = client
    payload = {"signal_id": "s-native", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.1, "order_type": "MARKET", "strategy_id": "alpha", "limit_price": 60000, "stop": 56000, "leverage": 1}
    fill_response = test_client.post("/execution/intent", json=payload, headers=HEADERS)
    assert fill_response.status_code == 200

    reconcile_response = test_client.post("/reconcile", json={}, headers=HEADERS)
    assert reconcile_response.status_code == 200
    body = reconcile_response.json()
    assert body["reconciled"] is True
    assert body["halted"] is False


def test_execution_signal_endpoint_rejects_stale_signal_with_409(client):
    test_client, _ = client
    stale_payload = {"signal_id": "me-stale", "asset": "BTC", "direction": "long", "timestamp": 0, "entry": 60000, "stop": 56000, "strategy_id": "market-edge-alpha"}
    response = test_client.post("/execution/signal", json={"signal": stale_payload, "instrument": "BTC-PERP"}, headers=HEADERS)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "STALE_SIGNAL"
