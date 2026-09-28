"""Risk limits across open trades, and the leverage invariant: leverage may
change margin, never size or allowed loss."""
import pytest

from market_edge_exec.domain.contracts import ExecutionIntent
from market_edge_exec.risk.engine import AccountState, RiskLimits, approve


def intent(leverage=1, entry=100.0, stop=95.0, side="buy"):
    return ExecutionIntent.create({"signal_id": f"s-{leverage}-{entry}", "instrument": "BTC-PERP", "side": side, "quantity": 0.0,
                                   "order_type": "MARKET", "strategy_id": "a", "limit_price": entry, "stop": stop, "leverage": leverage})


def test_exposure_cap_counts_already_open_notional():
    # 1% risk / 5% stop = 20% notional -- exactly the cap on its own.
    fresh = approve(intent(), AccountState(equity=10_000))
    assert fresh.decision.approved and not fresh.exposure_capped
    partial = approve(intent(), AccountState(equity=10_000, open_positions=1, open_notional=500))
    assert partial.decision.approved and partial.exposure_capped
    assert partial.notional == pytest.approx(1_500)       # only the room left under 20%
    assert partial.max_loss == pytest.approx(75.0)  # smaller loss, never larger
    sliver = approve(intent(), AccountState(equity=10_000, open_positions=1, open_notional=1_990))
    assert not sliver.decision.approved  # would risk $0.50: not a real trade
    full = approve(intent(), AccountState(equity=10_000, open_positions=1, open_notional=2_000))
    assert not full.decision.approved and full.decision.reason == "MAX_PORTFOLIO_EXPOSURE_EXCEEDED"


def test_tight_stop_is_sized_down_to_the_cap_not_rejected():
    # CI Part F: NEAR stop 1.9% away needed ~53% notional for 1% risk.
    near = approve(intent(entry=4.9483, stop=4.854921), AccountState(equity=10_000))
    assert near.decision.approved and near.exposure_capped
    assert near.notional == pytest.approx(2_000)
    assert near.max_loss == pytest.approx(2_000 / 4.9483 * (4.9483 - 4.854921))
    assert near.max_loss < 100


def test_endurance_segment_1_stacking_would_now_be_blocked():
    # Segment 1: ENA ~0.2824, each entry ~$679 notional on $10k. Replaying
    # the stack must never take total notional past the 20% cap.
    acc_notional, opened = 0.0, 0
    for _ in range(12):
        a = approve(intent(entry=0.2824, stop=0.2824 * (1 - 0.1473)), AccountState(equity=10_000, open_positions=0, open_notional=acc_notional))
        if not a.decision.approved:
            break
        acc_notional += a.notional
        opened += 1
    assert opened == 3  # two full-size entries, then one sized down to the remaining room
    assert acc_notional == pytest.approx(2_000)


@pytest.mark.parametrize("leverage", [1, 2, 3, 5, 10])
def test_leverage_never_changes_size_or_max_loss(leverage):
    wide = RiskLimits(max_portfolio_exposure_pct=100.0)
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
    wide_limits = RiskLimits(max_portfolio_exposure_pct=100.0)
    a = approve(intent(10, stop=85.0), AccountState(equity=10_000), wide_limits)
    assert a.decision.approved
    assert a.decision.approved_leverage == 5
    assert a.liquidation_estimate < 85.0
    assert a.liquidation_buffer_pct >= wide_limits.min_liquidation_buffer_pct


def test_short_liquidation_buffer():
    wide_limits = RiskLimits(max_portfolio_exposure_pct=100.0)
    a = approve(intent(10, entry=100.0, stop=112.0, side="sell"), AccountState(equity=10_000), wide_limits)
    assert a.decision.approved
    assert a.liquidation_estimate > 112.0
    assert a.decision.approved_leverage < 10


def test_leverage_is_never_raised_above_request():
    a = approve(intent(2, stop=99.0), AccountState(equity=10_000), RiskLimits(max_portfolio_exposure_pct=100.0))
    assert a.decision.approved_leverage == 2
