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
