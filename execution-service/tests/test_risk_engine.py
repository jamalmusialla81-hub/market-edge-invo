from market_edge_exec.domain.contracts import ExecutionIntent
from market_edge_exec.risk.engine import AccountState, RiskLimits, approve, DEFAULT_LEVERAGE


def intent(**overrides):
    base = dict(signal_id="s1", instrument="BTC-PERP", side="buy", quantity=0.1, order_type="MARKET",
                strategy_id="alpha", limit_price=60000, stop=56000, leverage=DEFAULT_LEVERAGE)
    base.update(overrides)
    return ExecutionIntent.create(base)


def test_risk_rejection_prevents_backend_call_missing_entry_stop():
    account = AccountState(equity=10_000, peak_equity=10_000)
    intent_missing_stop = ExecutionIntent.create(dict(signal_id="s1", instrument="BTC-PERP", side="buy", quantity=0.1, order_type="MARKET", strategy_id="alpha", limit_price=60000))
    assessment = approve(intent_missing_stop, account)
    assert assessment.decision.approved is False
    assert assessment.decision.reason == "MISSING_ENTRY_OR_STOP"


def test_leverage_ceiling_is_enforced_even_when_intent_requests_more():
    account = AccountState(equity=10_000, peak_equity=10_000)
    assessment = approve(intent(leverage=50), account, RiskLimits(leverage_ceiling=10))
    assert assessment.decision.approved is True
    assert assessment.decision.approved_leverage <= 10


def test_kill_switch_blocks_new_intents():
    account = AccountState(equity=10_000, peak_equity=10_000, killed=True)
    assessment = approve(intent(), account)
    assert assessment.decision.approved is False
    assert assessment.decision.reason == "KILL_SWITCH_ACTIVE"


def test_position_size_equals_risk_budget_over_stop_distance_leverage_does_not_change_max_loss():
    account = AccountState(equity=10_000, peak_equity=10_000)
    # Wide caps: this test isolates the risk-budget invariant from the
    # 5%-per-position and 20%-aggregate exposure ceilings, covered separately.
    limits = RiskLimits(max_risk_per_trade_pct=1.0, max_initial_position_notional_pct=100.0, max_portfolio_exposure_pct=100.0)
    low_leverage = approve(intent(leverage=1), account, limits)
    high_leverage = approve(intent(leverage=5), account, limits)
    assert low_leverage.max_loss == high_leverage.max_loss  # leverage changes margin, never allowed loss
    assert abs(low_leverage.max_loss - 100.0) < 1e-6  # 1% of 10,000 equity


def test_max_concurrent_positions_exceeded_is_rejected():
    account = AccountState(equity=10_000, peak_equity=10_000, open_positions=5)
    assessment = approve(intent(), account, RiskLimits(max_concurrent_positions=5))
    assert assessment.decision.approved is False
    assert assessment.decision.reason == "MAX_CONCURRENT_POSITIONS_EXCEEDED"


def test_daily_loss_limit_blocks_new_risk():
    account = AccountState(equity=10_000, peak_equity=10_000, daily_pnl=-600)
    assessment = approve(intent(), account, RiskLimits(daily_loss_limit_pct=5))
    assert assessment.decision.approved is False
    assert assessment.decision.reason == "DAILY_LOSS_LIMIT_HIT"
