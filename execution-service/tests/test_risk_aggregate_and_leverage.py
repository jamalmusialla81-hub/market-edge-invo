"""Risk limits across open trades, and the leverage invariant: leverage may
change margin, never size or allowed loss."""
import pytest

from market_edge_exec.domain.contracts import ExecutionIntent
from market_edge_exec.risk.engine import AccountState, RiskLimits, approve


def intent(leverage=1, entry=100.0, stop=95.0, side="buy"):
    return ExecutionIntent.create({"signal_id": f"s-{leverage}-{entry}", "instrument": "BTC-PERP", "side": side, "quantity": 0.0,
                                   "order_type": "MARKET", "strategy_id": "a", "limit_price": entry, "stop": stop, "leverage": leverage})


def test_position_cap_binds_before_the_aggregate_cap_even_with_room_to_spare():
    # Jakob's policy (2026-09-27): risk sizing is authoritative, then
    # final_size = min(risk_size, 5% equity notional, remaining 20% room).
    # 1% risk / 5% stop alone would size to 20% notional -- the 5% per-
    # position ceiling binds first, well inside the 20% aggregate room.
    fresh = approve(intent(), AccountState(equity=10_000))
    assert fresh.decision.approved and fresh.exposure_capped
    assert fresh.notional == pytest.approx(500)   # 5% of equity, not 20%
    assert fresh.max_loss == pytest.approx(25.0)  # 5 units * $5 stop distance
    # A wide-stop signal whose risk size alone is already under 5% is never
    # enlarged to "consume the slot" -- the ceiling is a cap, not a target.
    # (A tighter stop makes risk sizing pick a *larger* position for the same
    # dollar risk, so it takes an unusually wide stop to land under 5% here.)
    modest = approve(intent(stop=75.0), AccountState(equity=10_000))  # 25% stop -> risk size = 4% notional
    assert modest.decision.approved and not modest.exposure_capped
    assert modest.notional == pytest.approx(400.0)


def test_portfolio_cap_binds_once_the_aggregate_room_left_is_tighter_than_5_pct():
    tight_room = approve(intent(), AccountState(equity=10_000, open_positions=1, open_notional=1_700))
    assert tight_room.decision.approved and tight_room.exposure_capped
    assert tight_room.notional == pytest.approx(300)   # only $300 of the 20% cap remains
    assert tight_room.max_loss == pytest.approx(15.0)
    sliver = approve(intent(), AccountState(equity=10_000, open_positions=1, open_notional=1_990))
    assert not sliver.decision.approved and sliver.decision.reason == "PORTFOLIO_EXPOSURE_CAP"  # would risk $0.50: not a real trade
    full = approve(intent(), AccountState(equity=10_000, open_positions=1, open_notional=2_000))
    assert not full.decision.approved and full.decision.reason == "PORTFOLIO_EXPOSURE_CAP"


def test_four_5pct_position_slots_exactly_fill_the_20pct_aggregate_cap():
    # Matches MAX_CONCURRENT_POSITIONS = 4: four positions capped at 5% each
    # use exactly the 20% aggregate ceiling, and a fifth signal is rejected
    # even though max_concurrent_positions itself wasn't hit yet in this test
    # (open_positions is tracked by the caller, not derived from notional).
    acc_notional, opened = 0.0, 0
    for _ in range(6):
        a = approve(intent(), AccountState(equity=10_000, open_notional=acc_notional))
        if not a.decision.approved:
            break
        assert a.notional == pytest.approx(500)
        acc_notional += a.notional
        opened += 1
    assert opened == 4
    assert acc_notional == pytest.approx(2_000)


def test_tight_stop_under_the_position_cap_is_rejected_not_silently_shrunk_to_dust():
    # CI Part F flagged this: NEAR's stop was 1.9% away. Under the 20%-only
    # cap that sized down to a real trade; under the new 5% per-position
    # ceiling the capped size risks under the 10%-of-budget floor, so it is
    # rejected rather than opened as a near-zero-risk position. This is a
    # real behavior change worth flagging to Jakob if it blocks too much.
    near = approve(intent(entry=4.9483, stop=4.854921), AccountState(equity=10_000))
    assert not near.decision.approved
    assert near.decision.reason == "POSITION_EXPOSURE_CAP"


@pytest.mark.parametrize("leverage", [1, 2, 3, 5, 10])
def test_leverage_never_changes_size_or_max_loss(leverage):
    wide = RiskLimits(max_portfolio_exposure_pct=100.0, max_initial_position_notional_pct=100.0)
    base = approve(intent(1, stop=97.0), AccountState(equity=10_000), wide)
    levered = approve(intent(leverage, stop=97.0), AccountState(equity=10_000), wide)
    assert levered.decision.approved
    assert levered.position_size == pytest.approx(base.position_size)
    assert levered.max_loss == pytest.approx(base.max_loss) == pytest.approx(100.0)
    assert levered.decision.approved_leverage <= leverage
    assert levered.margin_required == pytest.approx(levered.notional / levered.decision.approved_leverage)


def test_leverage_walks_down_until_stop_sits_inside_liquidation():
    # Long 100, stop 85. At 10x liquidation is ~90.5 -- above the stop, so a
    # stop-out would be a liquidation. Must walk down to 5x (liq ~80.5).
    wide_limits = RiskLimits(max_portfolio_exposure_pct=100.0, max_initial_position_notional_pct=100.0)
    a = approve(intent(10, stop=85.0), AccountState(equity=10_000), wide_limits)
    assert a.decision.approved
    assert a.decision.approved_leverage == 5
    assert a.liquidation_estimate < 85.0
    assert a.liquidation_buffer_pct >= wide_limits.min_liquidation_buffer_pct


def test_short_liquidation_buffer():
    wide_limits = RiskLimits(max_portfolio_exposure_pct=100.0, max_initial_position_notional_pct=100.0)
    a = approve(intent(10, entry=100.0, stop=112.0, side="sell"), AccountState(equity=10_000), wide_limits)
    assert a.decision.approved
    assert a.liquidation_estimate > 112.0
    assert a.decision.approved_leverage < 10


def test_leverage_is_never_raised_above_request():
    a = approve(intent(2, stop=99.0), AccountState(equity=10_000), RiskLimits(max_portfolio_exposure_pct=100.0, max_initial_position_notional_pct=100.0))
    assert a.decision.approved_leverage == 2
