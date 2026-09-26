"""Tests HummingbotExecutionClientReal against a FAKE bridge (httpx mock
transport standing in for hummingbot-service/bridge/app.py, which itself is
untested end-to-end in this environment -- see that service's README) and
the factory's explicit-backend / no-silent-fallback behavior (failure tests:
backend timeout / bridge unavailable, and mode selection)."""
import httpx
import pytest

from market_edge_exec.domain.contracts import ExecutionIntent
from market_edge_exec.hummingbot.factory import HummingbotModeError, build_hummingbot_client
from market_edge_exec.hummingbot.mock_client import HummingbotExecutionClient
from market_edge_exec.hummingbot.real_client import HummingbotBridgeUnavailable, HummingbotExecutionClientReal


def intent(**overrides):
    base = dict(signal_id="s1", instrument="BTC-PERP", side="buy", quantity=0.1, order_type="MARKET", strategy_id="alpha", limit_price=60000)
    base.update(overrides)
    return ExecutionIntent.create(base)


def fake_bridge_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/health":
        return httpx.Response(200, json={"status": "ok"})
    if request.url.path == "/orders" and request.method == "POST":
        return httpx.Response(200, json={"backend_order_id": "HB-s1", "status": "FILLED", "quantity_filled": 0.1, "avg_price": 60000, "timestamp": 1700000000000})
    if request.url.path.startswith("/orders/") and request.method == "DELETE":
        return httpx.Response(200, json={"backend_order_id": "HB-cancel", "status": "CANCELLED", "quantity_filled": 0, "timestamp": 1700000000000})
    return httpx.Response(404)


def unreachable_handler(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def real_client_with_transport(transport):
    client = HummingbotExecutionClientReal(base_url="http://fake-bridge", api_key="k")
    client._client = httpx.Client(base_url="http://fake-bridge", headers={"X-Bridge-Key": "k"}, transport=transport)
    return client


def test_real_client_reports_the_real_backend_name_not_mock():
    client = real_client_with_transport(httpx.MockTransport(fake_bridge_handler))
    fill = client.submit(intent())
    assert fill.backend == "HUMMINGBOT"
    assert fill.status == "FILLED"


def test_real_client_cancel():
    client = real_client_with_transport(httpx.MockTransport(fake_bridge_handler))
    fill = client.cancel("s1")
    assert fill.status == "CANCELLED"


def test_backend_timeout_raises_rather_than_returning_a_fake_fill():
    client = real_client_with_transport(httpx.MockTransport(unreachable_handler))
    with pytest.raises(HummingbotBridgeUnavailable):
        client.submit(intent())


def test_health_reports_false_on_connection_failure():
    client = real_client_with_transport(httpx.MockTransport(unreachable_handler))
    assert client.health() is False


def test_factory_never_silently_falls_back_real_to_mock(monkeypatch):
    monkeypatch.delenv("HUMMINGBOT_BRIDGE_URL", raising=False)
    monkeypatch.delenv("HUMMINGBOT_BRIDGE_API_KEY", raising=False)
    with pytest.raises(HummingbotModeError):
        build_hummingbot_client("real")  # must raise, never quietly return a mock


def test_factory_rejects_an_unknown_mode():
    with pytest.raises(HummingbotModeError):
        build_hummingbot_client("sort-of-real")


def test_factory_returns_mock_only_when_explicitly_asked():
    client = build_hummingbot_client("mock")
    assert isinstance(client, HummingbotExecutionClient)


@pytest.mark.parametrize("bridge_status", ["OPEN", "SUBMITTED", "PENDING_CANCEL"])
def test_non_final_order_is_never_reported_as_a_fill(bridge_status):
    from market_edge_exec.hummingbot.real_client import HummingbotOrderNotFinal
    handler = lambda request: httpx.Response(200, json={"backend_order_id": "HB-1", "status": bridge_status, "quantity_filled": 0})
    with pytest.raises(HummingbotOrderNotFinal):
        real_client_with_transport(httpx.MockTransport(handler)).submit(intent())


def test_failed_order_maps_to_rejected():
    handler = lambda request: httpx.Response(200, json={"backend_order_id": "HB-1", "status": "FAILED", "quantity_filled": 0})
    assert real_client_with_transport(httpx.MockTransport(handler)).submit(intent()).status == "REJECTED"


def test_cancel_is_only_confirmed_when_the_bridge_says_cancelled():
    from market_edge_exec.hummingbot.real_client import HummingbotOrderNotFinal
    handler = lambda request: httpx.Response(200, json={"backend_order_id": "HB-1", "status": "PENDING_CANCEL"})
    with pytest.raises(HummingbotOrderNotFinal):
        real_client_with_transport(httpx.MockTransport(handler)).cancel("s1")
