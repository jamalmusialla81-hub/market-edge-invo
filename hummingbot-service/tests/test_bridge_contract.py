"""Tests the bridge's HTTP contract against a FAKE Hummingbot API server
(httpx.MockTransport) -- this proves the bridge's request/response shapes
are internally consistent and match what
execution-service/market_edge_exec/hummingbot/real_client.py expects. It
does NOT prove the real hummingbot-api project's request/response field
names match (those are our best-effort mapping, unconfirmed against a live
/openapi.json -- see bridge/hummingbot_api_client.py's docstring). No
Docker daemon is available in this environment to run the real stack (see
README.md); CI brings up the real containers instead."""
import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from bridge.app import create_app
from bridge.hummingbot_api_client import HummingbotApiClient

os.environ["BRIDGE_API_KEY"] = "test-bridge-key"
HEADERS = {"X-Bridge-Key": "test-bridge-key"}


def fake_api_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/" and request.method == "GET":
        return httpx.Response(200, json={"status": "ok"})
    if request.url.path == "/trading/orders" and request.method == "POST":
        payload = json.loads(request.content)
        return httpx.Response(200, json={
            "order_id": f"HB-{payload['client_order_id']}", "status": "FILLED",
            "filled_amount": payload["amount"], "average_price": payload.get("price") or 60000, "fee": 0.1,
        })
    if request.url.path.endswith("/cancel") and request.method == "POST":
        return httpx.Response(200, json={"order_id": "HB-cancelled", "filled_amount": 0})
    if request.url.path == "/trading/positions" and request.method == "POST":
        return httpx.Response(200, json={"positions": [{"trading_pair": "BTC-USDT", "amount": 0.1}]})
    return httpx.Response(404)


@pytest.fixture
def client():
    gateway = HummingbotApiClient(base_url="http://fake-hummingbot-api", username="u", password="p", transport=httpx.MockTransport(fake_api_handler))
    app = create_app(gateway=gateway)
    return TestClient(app)


def test_health_reports_ok_when_api_reachable(client):
    assert client.get("/health").json()["status"] == "ok"


def test_orders_requires_bridge_key(client):
    response = client.post("/orders", json={"client_order_id": "s1", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.1, "order_type": "MARKET"})
    assert response.status_code == 401


def test_submit_order_translates_to_api_and_back(client):
    payload = {"client_order_id": "s1", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.1, "order_type": "MARKET"}
    response = client.post("/orders", json=payload, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["backend_order_id"] == "HB-s1"
    assert body["status"] == "FILLED"
    assert body["quantity_filled"] == 0.1


def test_cancel_order(client):
    response = client.delete("/orders/s1", headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["backend_order_id"] == "HB-cancelled"


def test_amend_reports_not_supported_rather_than_pretending(client):
    response = client.patch("/orders/s1", json={"price": 100}, headers=HEADERS)
    assert response.status_code == 501


def test_positions(client):
    response = client.get("/positions", headers=HEADERS)
    assert response.json()["positions"] == [{"instrument": "BTC-USDT", "quantity": 0.1}]


def test_api_error_surfaces_as_502_not_a_silent_empty_success():
    def failing_handler(request):
        return httpx.Response(500, text="hummingbot-api exploded")
    gateway = HummingbotApiClient(base_url="http://fake-hummingbot-api", username="u", password="p", transport=httpx.MockTransport(failing_handler))
    app = create_app(gateway=gateway)
    client = TestClient(app)
    response = client.post("/orders", json={"client_order_id": "s1", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.1, "order_type": "MARKET"}, headers=HEADERS)
    assert response.status_code == 502
