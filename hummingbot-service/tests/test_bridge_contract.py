"""Bridge contract tests against a fake Hummingbot API whose responses copy
the running hummingbot-api 1.0.1 source (routers/trading.py,
services/perpetual_trading_service.py) captured in CI. The request side is
checked against the live openapi.json by verify_openapi.py in CI; these
tests cover the bridge's own behavior around it."""
import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from bridge.app import create_app
from bridge.hummingbot_api_client import HummingbotApiClient, HummingbotApiError

os.environ["BRIDGE_API_KEY"] = "test-bridge-key"
HEADERS = {"X-Bridge-Key": "test-bridge-key"}
ORDER = {"client_order_id": "sig-1", "instrument": "BTC-PERP", "side": "buy", "quantity": 0.01, "order_type": "MARKET", "leverage": 3}
PAGE = {"has_more": False, "next_cursor": None, "limit": 100, "total_count": 0}


class FakeApi:
    """Answers like the live API: 201 {order_id, status:'submitted'} on
    place, fill state only via /orders/active and /orders/search."""

    def __init__(self, fill_after_polls=1, final_status="FILLED", credentials=("binance_perpetual_testnet",)):
        self.requests, self.polls = [], 0
        self.fill_after_polls, self.final_status, self.credentials = fill_after_polls, final_status, list(credentials)
        self.positions = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, request.url.path, body))
        path = request.url.path
        if path == "/":
            return httpx.Response(200, json={"name": "Hummingbot API", "version": "1.0.1", "status": "running"})
        if path.endswith("/leverage"):
            return httpx.Response(200, json={"success": True})
        if path == "/trading/orders":
            return httpx.Response(201, json={"order_id": "buy-BTC-USDT-1", "account_name": body["account_name"], "connector_name": body["connector_name"],
                                             "trading_pair": body["trading_pair"], "trade_type": body["trade_type"], "amount": body["amount"],
                                             "order_type": body["order_type"], "price": body.get("price"), "status": "submitted"})
        if path == "/trading/orders/active":
            self.polls += 1
            done = self.polls > self.fill_after_polls
            rows = [] if done else [{"order_id": "buy-BTC-USDT-1", "status": "OPEN", "filled_amount": 0, "average_fill_price": None}]
            return httpx.Response(200, json={"data": rows, "pagination": PAGE})
        if path == "/trading/orders/search":
            rows = [{"order_id": "buy-BTC-USDT-1", "status": self.final_status, "filled_amount": 0.01, "average_fill_price": 60000.0,
                     "fee_paid": 0.24, "exchange_order_id": "X1"}] if self.polls > self.fill_after_polls else []
            return httpx.Response(200, json={"data": rows, "pagination": PAGE})
        if path.endswith("/cancel"):
            return httpx.Response(200, json={"message": "Order cancellation initiated for buy-BTC-USDT-1"})
        if path == "/accounts/market_edge/credentials":
            return httpx.Response(200, json=self.credentials)
        if path == "/trading/positions":
            return httpx.Response(200, json={"data": self.positions, "pagination": PAGE})
        if path == "/portfolio/state":
            return httpx.Response(200, json={"market_edge": {"binance_perpetual_testnet": [{"token": "USDT", "units": 1000.0, "available_units": 990.0}]}})
        return httpx.Response(404)


def gateway(api):
    return HummingbotApiClient("http://hb", username="u", password="p", transport=httpx.MockTransport(api), sleep=lambda s: None, fill_wait_s=5)


@pytest.fixture
def api():
    return FakeApi()


@pytest.fixture
def client(api, tmp_path):
    return TestClient(create_app(gateway=gateway(api), db_path=str(tmp_path / "bridge.sqlite3")))


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_orders_requires_bridge_key(client):
    assert client.post("/orders", json=ORDER).status_code == 401


def test_order_sets_leverage_separately_and_sends_only_schema_fields(client, api):
    body = client.post("/orders", json=ORDER, headers=HEADERS).json()
    leverage = [r for r in api.requests if r[1].endswith("/leverage")][0]
    assert leverage[2] == {"trading_pair": "BTC-USDT", "leverage": 3}
    placed = [r for r in api.requests if r[1] == "/trading/orders"][0][2]
    assert set(placed) == {"account_name", "connector_name", "trading_pair", "trade_type", "amount", "order_type", "position_action"}
    assert placed["trade_type"] == "BUY" and placed["position_action"] == "OPEN"
    assert body["status"] == "FILLED" and body["quantity_filled"] == 0.01 and body["avg_price"] == 60000.0
    assert body["backend_order_id"] == "buy-BTC-USDT-1"


def test_submitted_is_not_reported_as_a_fill(tmp_path):
    api = FakeApi(fill_after_polls=10_000)
    gw = HummingbotApiClient("http://hb", username="u", password="p", transport=httpx.MockTransport(api), sleep=lambda s: None, fill_wait_s=0)
    body = TestClient(create_app(gateway=gw, db_path=str(tmp_path / "b.sqlite3"))).post("/orders", json=ORDER, headers=HEADERS).json()
    assert body["status"] == "OPEN" and body["quantity_filled"] == 0


def test_reduce_only_closes_without_touching_leverage(client, api):
    client.post("/orders", json={**ORDER, "client_order_id": "sig-exit", "side": "sell", "reduce_only": True}, headers=HEADERS)
    assert not [r for r in api.requests if r[1].endswith("/leverage")]
    placed = [r for r in api.requests if r[1] == "/trading/orders"][0][2]
    assert placed["position_action"] == "CLOSE" and placed["trade_type"] == "SELL"


def test_non_integer_leverage_is_refused_not_rounded(client, api):
    response = client.post("/orders", json={**ORDER, "leverage": 2.5}, headers=HEADERS)
    assert response.status_code == 502
    assert not [r for r in api.requests if r[1] == "/trading/orders"]


def test_duplicate_signal_is_refused_even_after_bridge_restart(api, tmp_path):
    db = str(tmp_path / "bridge.sqlite3")
    TestClient(create_app(gateway=gateway(api), db_path=db)).post("/orders", json=ORDER, headers=HEADERS)
    restarted = TestClient(create_app(gateway=gateway(api), db_path=db))
    assert restarted.post("/orders", json=ORDER, headers=HEADERS).status_code == 409
    assert len([r for r in api.requests if r[1] == "/trading/orders"]) == 1
    cancel = restarted.delete("/orders/sig-1", headers=HEADERS).json()
    assert cancel["backend_order_id"] == "buy-BTC-USDT-1"  # the map survived the restart


def test_cancel_unknown_signal_is_404(client):
    assert client.delete("/orders/never-sent", headers=HEADERS).status_code == 404


def test_amend_reports_not_supported_rather_than_pretending(client):
    assert client.patch("/orders/s1", json={"price": 100}, headers=HEADERS).status_code == 501


def test_positions_signed_by_side(client, api):
    api.positions = [{"trading_pair": "ETH-USDT", "side": "SHORT", "amount": 0.5, "entry_price": 3000.0, "leverage": 2.0},
                     {"trading_pair": "BTC-USDT", "side": "LONG", "amount": 0.01, "entry_price": 60000.0, "leverage": 3.0}]
    positions = client.get("/positions", headers=HEADERS).json()["positions"]
    assert [(p["instrument"], p["quantity"]) for p in positions] == [("ETH-PERP", -0.5), ("BTC-PERP", 0.01)]


def test_positions_refuse_to_answer_when_connector_not_configured(tmp_path):
    api = FakeApi(credentials=())
    response = TestClient(create_app(gateway=gateway(api), db_path=str(tmp_path / "b.sqlite3"))).get("/positions", headers=HEADERS)
    assert response.status_code == 502 and "not configured" in response.json()["detail"]


def test_balances_from_portfolio_state(client):
    assert client.get("/balances", headers=HEADERS).json()["balances"][0]["token"] == "USDT"


def test_client_raises_on_error_status():
    gw = HummingbotApiClient("http://hb", transport=httpx.MockTransport(lambda r: httpx.Response(500, text="boom")))
    with pytest.raises(HummingbotApiError):
        gw.accounts()
