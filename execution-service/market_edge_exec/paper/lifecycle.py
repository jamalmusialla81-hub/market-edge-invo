"""Paper position lifecycle: entry -> TP1 (50%, stop to breakeven) -> TP2
(remaining 50%) | stop | max-hold timeout.

This mirrors production's own forward-paper execution model exactly
(forward-engine.js resolveSignal: "next-observed-bar; stop-first if
ambiguous; 50% TP1 / 50% TP2", breakeven stop after TP1, fee 0.05% and
slippage 0.03% per side, maxBars 30). Market Edge geometry (entry/stop/
tp1/tp2) is taken as-is from the signal and never altered here.

Pure functions only: given a trade's current state and the candles observed
since it was last checked, return the exit events. No I/O, so every branch
is unit-testable without a network or a database.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

FEE_PCT = 0.0005       # per side, forward-engine.js:65
SLIPPAGE_PCT = 0.0003  # per side, forward-engine.js:65
TP1_FRACTION = 0.5     # forward-engine.js:60 "50% TP1 / 50% TP2"
# forward-engine.js maxBars=30 on the scan's reference timeframe, which is 4h
# (scan-core.mjs:119 `h4: reference.candles`), so 30 bars = 120 hours.
MAX_HOLD_MS = 30 * 4 * 60 * 60 * 1000


@dataclass
class ExitEvent:
    kind: str            # TP1 | TP2 | STOP | BREAKEVEN_STOP | TIMEOUT
    quantity: float
    level: float         # the geometry level (or close price for TIMEOUT)
    fill_price: float    # level after adverse slippage
    at_ms: int


def slipped(price: float, side_of_fill: str) -> float:
    """Adverse slippage: buying fills higher, selling fills lower."""
    return price * (1 + SLIPPAGE_PCT) if side_of_fill == "buy" else price * (1 - SLIPPAGE_PCT)


def exit_side(direction: str) -> str:
    return "sell" if direction == "long" else "buy"


def advance(direction: str, entry: float, stop: float, tp1: Optional[float], tp2: Optional[float],
            remaining_qty: float, original_qty: float, tp1_hit: bool, opened_at_ms: int,
            candles: list[dict], now_ms: int, max_hold_ms: int = MAX_HOLD_MS) -> list[ExitEvent]:
    """Walks candles (dicts with time/open/high/low/close, time in ms, only
    those after the last check) in order and returns the exit events they
    trigger. Stop is checked first within a candle: if a candle spans both
    the stop and a target, the conservative assumption is the stop hit."""
    events: list[ExitEvent] = []
    long = direction == "long"
    side = exit_side(direction)
    qty_left = remaining_qty

    for candle in sorted(candles, key=lambda c: c["time"]):
        if qty_left <= 0:
            break
        active_stop = entry if tp1_hit else stop
        stop_hit = candle["low"] <= active_stop if long else candle["high"] >= active_stop
        if stop_hit:
            kind = "BREAKEVEN_STOP" if tp1_hit else "STOP"
            events.append(ExitEvent(kind, qty_left, active_stop, slipped(active_stop, side), candle["time"]))
            return events
        if not tp1_hit and tp1 is not None and (candle["high"] >= tp1 if long else candle["low"] <= tp1):
            tp1_hit = True
            part = min(round(original_qty * TP1_FRACTION, 8), qty_left)
            events.append(ExitEvent("TP1", part, tp1, slipped(tp1, side), candle["time"]))
            qty_left -= part
        if tp1_hit and qty_left > 0 and tp2 is not None and (candle["high"] >= tp2 if long else candle["low"] <= tp2):
            events.append(ExitEvent("TP2", qty_left, tp2, slipped(tp2, side), candle["time"]))
            return events

    if qty_left > 0 and now_ms - opened_at_ms >= max_hold_ms and candles:
        last_close = sorted(candles, key=lambda c: c["time"])[-1]["close"]
        events.append(ExitEvent("TIMEOUT", qty_left, last_close, slipped(last_close, side), now_ms))
    return events


def pnl(direction: str, entry_fill: float, exit_fill: float, quantity: float) -> float:
    return (exit_fill - entry_fill) * quantity if direction == "long" else (entry_fill - exit_fill) * quantity


def fee(price: float, quantity: float) -> float:
    return abs(price * quantity) * FEE_PCT
