from market_edge_exec.domain.contracts import ExecutionIntent
from market_edge_exec.hummingbot.mock_client import HummingbotExecutionClient


def intent(**overrides):
    base = dict(signal_id="s1", instrument="BTC-PERP", side="buy", quantity=0.1, order_type="MARKET", strategy_id="alpha", limit_price=60000, stop=59000)
    base.update(overrides)
    return ExecutionIntent.create(base)


def test_mock_backend_reports_itself_as_mock_not_the_real_connector():
    client = HummingbotExecutionClient()
    fill = client.submit(intent())
    assert fill.backend == "HUMMINGBOT_MOCK"


def test_mock_submit_then_cancel_updates_status():
    client = HummingbotExecutionClient()
    client.submit(intent(signal_id="s2"))
    fill = client.cancel("s2")
    assert fill.status == "CANCELLED"


def test_mock_cancel_of_unknown_order_raises():
    client = HummingbotExecutionClient()
    try:
        client.cancel("does-not-exist")
        assert False, "expected KeyError"
    except KeyError:
        pass


def test_mock_leverage_translation_echoes_approved_value_and_isolated_margin():
    client = HummingbotExecutionClient()
    translated = client.translate_leverage(5)
    assert translated == {"leverage": 5, "margin_mode": "ISOLATED"}
