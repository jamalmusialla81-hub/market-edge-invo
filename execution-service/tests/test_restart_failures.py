"""Failure hardening for restarts: Hummingbot bridge restart (during submit
and during reconciliation), Nautilus/service restart, and partial fill then
restart. Every case must fail closed."""
import os
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.domain.contracts import ExecutionIntent, RiskDecision
from market_edge_exec.hummingbot.real_client import HummingbotBridgeUnavailable, HummingbotExecutionClientReal
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.persistence.store import Store
from market_edge_exec.routing.router import BACKEND_HUMMINGBOT, ExecutionRouter, RouterError

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}


class RestartingBridge:
    """Stands in for the bridge; `up` toggles as if Hummingbot restarted."""

    def __init__(self):
        self.up = True
        self.orders = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if not self.up:
            raise httpx.ConnectError("connection refused", request=request)
        if request.url.path == "/orders" and request.method == "POST":
            self.orders.append(request)
            return httpx.Response(200, json={"backend_order_id": f"HB-{len(self.orders)}", "status": "FILLED", "quantity_filled": 0.1, "avg_price": 60000, "timestamp": 1})
        if request.url.path == "/positions":
            return httpx.Response(200, json={"positions": []})
        return httpx.Response(404)


def real_client(handler):
    client = HummingbotExecutionClientReal(base_url="http://bridge", api_key="k")
    client._client = httpx.Client(base_url="http://bridge", headers={"X-Bridge-Key": "k"}, transport=httpx.MockTransport(handler))
    return client


def intent(signal_id="s1", quantity=0.1):
    return ExecutionIntent.create(dict(signal_id=signal_id, instrument="BTC-PERP", side="buy", quantity=quantity, order_type="MARKET",
                                       strategy_id="alpha", limit_price=60000, stop=56000, leverage=1))


def approve(intent):
    return RiskDecision.create(dict(signal_id=intent.signal_id, approved=True, approved_leverage=5))


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "restart.sqlite3")


def test_hummingbot_restart_during_submit_fails_closed_and_signal_is_not_replayed(db):
    bridge = RestartingBridge()
    router = ExecutionRouter(store=Store(db), risk_gate=approve, backends={BACKEND_HUMMINGBOT: real_client(bridge)})
    bridge.up = False
    with pytest.raises(RouterError, match="BACKEND_SUBMIT_FAILED"):
        router.route(intent("s1"))
    order = [o for o in router.store.orders() if o["signal_id"] == "s1"][0]
    assert order["status"] == "SUBMIT_FAILED_UNKNOWN"  # not "no order", not "filled"
    assert bridge.orders == []

    bridge.up = True  # Hummingbot back
    with pytest.raises(RouterError, match="DUPLICATE"):
        router.route(intent("s1"))  # the unknown-outcome signal is never blindly resent
    assert bridge.orders == []
    router.route(intent("s2"))  # a new signal routes normally once it is back
    assert len(bridge.orders) == 1


def test_hummingbot_error_body_never_reads_as_no_positions():
    client = real_client(lambda request: httpx.Response(503, text="restarting"))
    with pytest.raises(HummingbotBridgeUnavailable, match="503"):
        client.positions()


def test_reconcile_halts_when_hummingbot_positions_are_unreadable(db):
    app = create_app(db_path=db, hummingbot_mode="mock")

    def down():
        raise HummingbotBridgeUnavailable("HUMMINGBOT_BRIDGE_UNREACHABLE: connection refused")

    app.state.hummingbot.positions = down
    result = TestClient(app).post("/reconcile", json={}, headers=HEADERS).json()
    assert result["reconciled"] is False and result["halted"] is True
    assert app.state.store.active_halt() == "RECONCILIATION_BACKEND_UNAVAILABLE"
    assert create_app(db_path=db).state.router.killed is True  # still halted after a restart


def test_nautilus_restart_restores_position_and_reconciles_cleanly(db):
    app = create_app(db_path=db)
    now = int(time.time() * 1000)
    signal = {"signal_id": "sig-r", "asset": "ETH", "direction": "long", "timestamp": now, "entry": 100.0, "stop": 90.0,
              "targets": [110.0, 120.0], "strategy_id": "TREND CONTINUATION"}
    opened = app.state.paper.open_from_signal(signal, "ETH-PERP", 100.0, now, requested_leverage=3.0, now_ms=now)
    assert opened.accepted, opened.reason
    del app

    restarted = create_app(db_path=db)
    position = restarted.state.portfolio.position("ETH-PERP")
    assert position.quantity == pytest.approx(opened.trade["quantity"], rel=1e-6)
    result = TestClient(restarted).post("/reconcile", json={}, headers=HEADERS).json()
    assert result["reconciled"] is True and result["halted"] is False
    again = restarted.state.paper.open_from_signal(signal, "ETH-PERP", 100.0, now, requested_leverage=3.0, now_ms=now)
    assert again.accepted is False and again.reason == "DUPLICATE_SIGNAL"


def test_partial_fill_then_restart_keeps_partial_quantity_and_blocks_replay(db):
    store = Store(db)
    portfolio = NautilusPortfolio(store)
    partial = intent("p1", quantity=1.0)
    store.record_intent(partial.to_dict())
    store.upsert_order("p1", "NAUTILUS_NATIVE", "PARTIALLY_FILLED", external_id="n-p1")
    portfolio.apply_fill(partial, fill_price=60000, quantity_filled=0.4, backend="NAUTILUS_NATIVE")
    del portfolio, store

    store_b = Store(db)
    portfolio_b = NautilusPortfolio(store_b)
    assert portfolio_b.position("BTC-PERP").quantity == pytest.approx(0.4)
    assert [o["status"] for o in store_b.orders() if o["signal_id"] == "p1"] == ["PARTIALLY_FILLED"]
    router = ExecutionRouter(store=store_b, risk_gate=approve, backends={"NAUTILUS_NATIVE": object()})
    with pytest.raises(RouterError, match="DUPLICATE"):
        router.route(partial)


def test_default_runtime_has_no_hummingbot_backend_and_no_mock(db, monkeypatch):
    monkeypatch.delenv("HUMMINGBOT_MODE", raising=False)
    app = create_app(db_path=db)
    assert app.state.hummingbot is None
    assert BACKEND_HUMMINGBOT not in app.state.router.backends
    assert TestClient(app).get("/health").json()["hummingbot_mode"] == "disabled"


def test_real_mode_without_a_bridge_refuses_to_start(db, monkeypatch):
    from market_edge_exec.hummingbot.factory import HummingbotModeError
    monkeypatch.delenv("HUMMINGBOT_BRIDGE_URL", raising=False)
    with pytest.raises(HummingbotModeError):
        create_app(db_path=db, hummingbot_mode="real")
