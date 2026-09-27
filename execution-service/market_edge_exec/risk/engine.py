"""Paper-only hard risk gates.

Core invariant enforced here: position size = risk budget / stop distance.
Leverage changes margin required, never the allowed loss — a RiskDecision's
approved_leverage is capped by liquidation-distance and venue limits, but it
never scales max_loss up. All checks run before an ExecutionIntent ever
reaches a backend; a backend cannot appeal or override a rejection here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from market_edge_exec.domain.contracts import ExecutionIntent, RiskDecision

LEVERAGE_BANDS = (1, 2, 3, 5, 10)
DEFAULT_LEVERAGE = 1  # never default to 10x


@dataclass
class AccountState:
    equity: float
    open_positions: int = 0
    daily_pnl: float = 0.0
    peak_equity: Optional[float] = None
    killed: bool = False
    # Notional already open. Without it the exposure cap only ever saw the
    # new trade, which let endurance segment 1 stack ENA 12x to ~81% notional.
    open_notional: float = 0.0


@dataclass
class RiskLimits:
    max_risk_per_trade_pct: float = 1.0       # % of equity
    max_portfolio_exposure_pct: float = 20.0  # % of equity, notional, open + new -- aggregate ceiling, never raised
    max_initial_position_notional_pct: float = 5.0  # % of equity, notional -- a ceiling per position, never a target
    max_concurrent_positions: int = 4
    leverage_ceiling: float = 10.0
    min_liquidation_distance_pct: float = 5.0  # entry to liquidation, at minimum
    min_liquidation_buffer_pct: float = 1.0    # stop must be hit this far before liquidation
    daily_loss_limit_pct: float = 5.0
    drawdown_limit_pct: float = 15.0
    min_capped_risk_fraction: float = 0.1     # a trade shrunk by a cap must still risk >= 10% of the budget


@dataclass
class RiskAssessment:
    decision: RiskDecision
    position_size: float
    risk_amount: float
    max_loss: float
    margin_required: float
    liquidation_estimate: Optional[float]
    stop_distance: float
    notional: float = 0.0
    requested_leverage: float = 0.0
    liquidation_buffer_pct: Optional[float] = None
    exposure_capped: bool = False


def liquidation_price(entry: float, leverage: float, side: str, maintenance_margin_pct: float = 0.5) -> float:
    """Rough isolated-margin liquidation estimate: entry moved by (1/leverage - maintenance) fraction."""
    fraction = max(1.0 / leverage - maintenance_margin_pct / 100.0, 0.0)
    return entry * (1 - fraction) if side == "buy" else entry * (1 + fraction)


def approve(intent: ExecutionIntent, account: AccountState, limits: RiskLimits = RiskLimits()) -> RiskAssessment:
    def reject(reason: str) -> RiskAssessment:
        return RiskAssessment(
            decision=RiskDecision(signal_id=intent.signal_id, approved=False, approved_leverage=0.0, reason=reason),
            position_size=0.0, risk_amount=0.0, max_loss=0.0, margin_required=0.0, liquidation_estimate=None, stop_distance=0.0,
        )

    if account.killed:
        return reject("KILL_SWITCH_ACTIVE")

    entry = intent.limit_price
    if entry is None or intent.stop is None:
        return reject("MISSING_ENTRY_OR_STOP")

    stop_distance = abs(entry - intent.stop)
    if stop_distance <= 0:
        return reject("ZERO_STOP_DISTANCE")

    if account.open_positions >= limits.max_concurrent_positions:
        return reject("MAX_CONCURRENT_POSITIONS_EXCEEDED")

    if account.daily_pnl < 0 and abs(account.daily_pnl) / account.equity * 100 >= limits.daily_loss_limit_pct:
        return reject("DAILY_LOSS_LIMIT_HIT")

    peak = account.peak_equity or account.equity
    drawdown_pct = max(0.0, (peak - account.equity) / peak * 100) if peak else 0.0
    if drawdown_pct >= limits.drawdown_limit_pct:
        return reject("DRAWDOWN_LIMIT_HIT")

    # Risk sizing is authoritative: position size = risk budget / stop distance
    # (the core invariant; leverage never enters this). Two ceilings can then
    # shrink it -- never enlarge it -- and neither is a target: if risk sizing
    # already produces 2.3% notional, that stands; if it produces 12%, it is
    # capped to the 5% per-position ceiling.
    risk_budget = account.equity * (limits.max_risk_per_trade_pct / 100.0)
    risk_size = risk_budget / stop_distance

    room = account.equity * limits.max_portfolio_exposure_pct / 100.0 - account.open_notional
    if room <= 0:
        return reject("PORTFOLIO_EXPOSURE_CAP")
    position_cap_size = (account.equity * limits.max_initial_position_notional_pct / 100.0) / entry
    room_size = room / entry

    binding, position_size = min(
        (("RISK", risk_size), ("POSITION", position_cap_size), ("PORTFOLIO", room_size)),
        key=lambda pair: pair[1],
    )
    exposure_capped = binding != "RISK"
    notional = position_size * entry
    max_loss = position_size * stop_distance  # <= risk_budget by construction; leverage cannot raise this
    if exposure_capped and max_loss < risk_budget * limits.min_capped_risk_fraction:
        return reject(f"{binding}_EXPOSURE_CAP")

    requested_leverage = max(intent.leverage, 0.0001)

    def liquidation_ok(leverage: float) -> tuple[bool, float, float]:
        liq = liquidation_price(entry, leverage, intent.side)
        distance_pct = abs(entry - liq) / entry * 100
        # The stop must trigger before liquidation, with a buffer: otherwise
        # leverage could turn a 1R stop-out into a larger liquidation loss.
        buffer_pct = ((intent.stop - liq) if intent.side == "buy" else (liq - intent.stop)) / entry * 100
        return (distance_pct >= limits.min_liquidation_distance_pct and buffer_pct >= limits.min_liquidation_buffer_pct), liq, buffer_pct

    approved_leverage = min(requested_leverage, limits.leverage_ceiling)
    ok, liq_price, buffer_pct = liquidation_ok(approved_leverage)
    if not ok:
        # walk leverage down (never up) until it clears both floors, or reject
        for band in sorted((b for b in LEVERAGE_BANDS if b < approved_leverage), reverse=True):
            ok, liq_price, buffer_pct = liquidation_ok(band)
            if ok:
                approved_leverage = band
                break
        else:
            return reject("LIQUIDATION_DISTANCE_TOO_TIGHT")

    margin_required = notional / approved_leverage

    return RiskAssessment(
        decision=RiskDecision(signal_id=intent.signal_id, approved=True, approved_leverage=approved_leverage,
                               max_position_notional=notional),
        position_size=position_size, risk_amount=max_loss, max_loss=max_loss,
        margin_required=margin_required, liquidation_estimate=liq_price, stop_distance=stop_distance,
        notional=notional, requested_leverage=requested_leverage, liquidation_buffer_pct=buffer_pct,
        exposure_capped=exposure_capped,
    )
