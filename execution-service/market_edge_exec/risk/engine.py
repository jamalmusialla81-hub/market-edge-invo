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


@dataclass
class RiskLimits:
    max_risk_per_trade_pct: float = 1.0       # % of equity
    max_portfolio_exposure_pct: float = 20.0  # % of equity, notional
    max_concurrent_positions: int = 5
    leverage_ceiling: float = 10.0
    min_liquidation_distance_pct: float = 5.0  # stop must sit this far from liquidation, at minimum
    daily_loss_limit_pct: float = 5.0
    drawdown_limit_pct: float = 15.0


@dataclass
class RiskAssessment:
    decision: RiskDecision
    position_size: float
    risk_amount: float
    max_loss: float
    margin_required: float
    liquidation_estimate: Optional[float]
    stop_distance: float


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

    # position size = risk budget / stop distance (the core invariant; leverage never enters this)
    risk_budget = account.equity * (limits.max_risk_per_trade_pct / 100.0)
    position_size = risk_budget / stop_distance
    max_loss = position_size * stop_distance  # == risk_budget by construction; leverage cannot raise this
    notional = position_size * entry

    if notional / account.equity * 100 > limits.max_portfolio_exposure_pct:
        return reject("MAX_PORTFOLIO_EXPOSURE_EXCEEDED")

    requested_leverage = max(intent.leverage, 0.0001)
    approved_leverage = min(requested_leverage, limits.leverage_ceiling)
    liq_price = liquidation_price(entry, approved_leverage, intent.side)
    liquidation_distance_pct = abs(entry - liq_price) / entry * 100
    if liquidation_distance_pct < limits.min_liquidation_distance_pct:
        # walk leverage down until the liquidation distance clears the floor, or reject
        for band in sorted(LEVERAGE_BANDS):
            candidate_liq = liquidation_price(entry, band, intent.side)
            if abs(entry - candidate_liq) / entry * 100 >= limits.min_liquidation_distance_pct:
                approved_leverage = min(band, limits.leverage_ceiling)
                liq_price = candidate_liq
                break
        else:
            return reject("LIQUIDATION_DISTANCE_TOO_TIGHT")

    margin_required = notional / approved_leverage

    return RiskAssessment(
        decision=RiskDecision(signal_id=intent.signal_id, approved=True, approved_leverage=approved_leverage,
                               max_position_notional=notional),
        position_size=position_size, risk_amount=risk_budget, max_loss=max_loss,
        margin_required=margin_required, liquidation_estimate=liq_price, stop_distance=stop_distance,
    )
