"""Position State Engine: a pure function of the trade's fixed geometry and the
running accumulators of a replay. No I/O. Reused by the shadow replay (3G) and,
one day, by a real policy (MAJOR 4)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from market_edge_exec.exits.model import CANDLE_MS, TradeSpec

VOL_WINDOW = 12       # PATH_RANGE_V1: mean high-low of the last 12 completed candles
VOL_MIN_CANDLES = 3   # ... and None until 3 have been seen
CLOSES_KEPT = 8


@dataclass
class RunState:
    """Mutable accumulators of one (trade, policy) replay. JSON-serialisable."""
    qty_left: float
    best_price: float
    worst_price: float
    best_at_ms: int
    last_price: float
    last_known_ms: int
    tp1_hit: bool = False
    cf_stop: Optional[float] = None          # policy-tightened stop (None = the fixed lifecycle's own)
    last_seq: int = 0
    obs_count: int = 0
    last_exit_at_ms: int = 0
    status: str = "OPEN"                     # OPEN | CLOSED
    closed_at_ms: Optional[int] = None
    exit_reason: Optional[str] = None
    realized_pnl: float = 0.0
    fees: float = 0.0
    exit_slippage: float = 0.0
    partials: int = 0
    events: list = field(default_factory=list)
    stop_changes: list = field(default_factory=list)
    closes: list = field(default_factory=list)
    ranges: list = field(default_factory=list)


@dataclass(frozen=True)
class PositionState:
    direction: str
    at_ms: int
    price: float
    entry: float
    risk_distance: float
    unrealized_R: float
    mfe_price: float
    mfe_R: float
    mae_R: float
    best_price: float
    elapsed_ms: int
    time_since_mfe_ms: int
    distance_from_peak_R: float          # give-back so far: (peak - now) / 1R
    active_stop: float
    stop_distance_R: float               # |price - active stop| / 1R
    tp1: Optional[float]
    tp2: Optional[float]
    tp1_distance_R: Optional[float]
    tp2_distance_R: Optional[float]
    tp1_hit: bool
    remaining_frac: float
    volatility: Optional[float]          # price units, PATH_RANGE_V1
    volatility_R: Optional[float]
    adverse_closes: int                  # consecutive candle closes against the trade
    momentum_R: Optional[float]          # signed close-to-close move over 3 candles, in R


def baseline_stop(spec: TradeSpec, tp1_hit: bool) -> float:
    """The fixed lifecycle's own stop: the entry stop, or breakeven after TP1."""
    return spec.entry if tp1_hit else spec.stop


def effective_stop(spec: TradeSpec, run: RunState) -> float:
    base = baseline_stop(spec, run.tp1_hit)
    if run.cf_stop is None:
        return base
    return max(base, run.cf_stop) if spec.long else min(base, run.cf_stop)


def path_volatility(ranges: list) -> Optional[float]:
    if len(ranges) < VOL_MIN_CANDLES:
        return None
    window = ranges[-VOL_WINDOW:]
    return sum(window) / len(window)


def adverse_close_count(closes: list, long: bool) -> int:
    count = 0
    for newer, older in zip(reversed(closes[1:]), reversed(closes[:-1])):
        if (newer < older) if long else (newer > older):
            count += 1
        else:
            break
    return count


def compute_state(spec: TradeSpec, run: RunState) -> PositionState:
    long, one_r = spec.long, spec.risk_distance
    price, at_ms = run.last_price, run.last_known_ms
    signed = (lambda p: (p - spec.entry) if long else (spec.entry - p))
    mfe = max(0.0, signed(run.best_price))
    mae = max(0.0, -signed(run.worst_price))
    stop = effective_stop(spec, run)
    vol = path_volatility(run.ranges)
    momentum = None
    if len(run.closes) >= 4:
        momentum = ((run.closes[-1] - run.closes[-4]) if long else (run.closes[-4] - run.closes[-1])) / one_r
    dist = lambda level: None if level is None else abs(level - price) / one_r
    return PositionState(
        direction=spec.direction, at_ms=at_ms, price=price, entry=spec.entry, risk_distance=one_r,
        unrealized_R=signed(price) / one_r, mfe_price=mfe, mfe_R=mfe / one_r, mae_R=mae / one_r,
        best_price=run.best_price, elapsed_ms=at_ms - spec.opened_at_ms, time_since_mfe_ms=max(0, at_ms - run.best_at_ms),
        distance_from_peak_R=max(0.0, (mfe - signed(price)) / one_r), active_stop=stop, stop_distance_R=abs(price - stop) / one_r,
        tp1=spec.tp1, tp2=spec.tp2, tp1_distance_R=dist(spec.tp1), tp2_distance_R=dist(spec.tp2), tp1_hit=run.tp1_hit,
        remaining_frac=run.qty_left / spec.quantity, volatility=vol, volatility_R=None if vol is None else vol / one_r,
        adverse_closes=adverse_close_count(run.closes, long), momentum_R=momentum,
    )
