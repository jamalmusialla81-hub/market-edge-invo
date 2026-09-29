"""Plain data shapes shared by the state engine, policies and replay."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from market_edge_exec.paper import lifecycle

CANDLE_MS = 5 * 60 * 1000  # the 5m sweep; a candle is only known at its close

HOLD = "HOLD"
TIGHTEN_STOP = "TIGHTEN_STOP"
MOVE_TO_BREAKEVEN = "MOVE_TO_BREAKEVEN"
TRAIL_STOP = "TRAIL_STOP"
PARTIAL_EXIT = "PARTIAL_EXIT"
FULL_EXIT = "FULL_EXIT"
ACTIONS = (HOLD, TIGHTEN_STOP, MOVE_TO_BREAKEVEN, TRAIL_STOP, PARTIAL_EXIT, FULL_EXIT)
STOP_ACTIONS = (TIGHTEN_STOP, MOVE_TO_BREAKEVEN, TRAIL_STOP)


@dataclass(frozen=True)
class Action:
    kind: str = HOLD
    stop: Optional[float] = None       # proposed stop level (stop actions)
    fraction: Optional[float] = None   # of the ORIGINAL quantity (PARTIAL_EXIT)
    note: str = ""


@dataclass(frozen=True)
class TradeSpec:
    """Everything fixed at entry that a replay needs. `risk_dollars` is the
    initial stop risk, |entry - stop| * quantity: 1R everywhere in this package."""
    trade_id: str
    direction: str
    entry: float
    stop: float
    tp1: Optional[float]
    tp2: Optional[float]
    quantity: float
    opened_at_ms: int
    entry_fee: float
    max_hold_ms: int = lifecycle.MAX_HOLD_MS
    asset: Optional[str] = None

    @property
    def long(self) -> bool:
        return self.direction == "long"

    @property
    def risk_distance(self) -> float:
        return abs(self.entry - self.stop)

    @property
    def risk_dollars(self) -> float:
        return self.risk_distance * self.quantity


def spec_from_trade(trade: dict) -> Optional[TradeSpec]:
    """Built from the persisted trade record; None if it has no usable risk."""
    try:
        entry, stop, qty = float(trade["entry_fill"]), float(trade["stop"]), float(trade["quantity"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (entry > 0 and qty > 0) or entry == stop:
        return None
    return TradeSpec(
        trade_id=trade["trade_id"], direction=trade["direction"], entry=entry, stop=stop,
        tp1=trade.get("tp1"), tp2=trade.get("tp2"), quantity=qty, opened_at_ms=int(trade["opened_at_ms"]),
        entry_fee=lifecycle.fee(entry, qty), asset=trade.get("asset"),
    )


@dataclass(frozen=True)
class Observation:
    """One real observation the engine evaluated: a monitor price ("TICK") or a
    completed 5m candle ("CANDLE"). `eval_ms` is when the engine looked at it;
    `last` marks the final candle of one sweep (the fixed timeout is judged once
    per sweep, exactly as the real engine does)."""
    seq: int
    kind: str
    at_ms: int
    eval_ms: int
    price: float
    high: float
    low: float
    open: float
    batch: int
    last: bool = True

    @property
    def known_at_ms(self) -> int:
        return self.at_ms + CANDLE_MS if self.kind == "CANDLE" else self.at_ms
