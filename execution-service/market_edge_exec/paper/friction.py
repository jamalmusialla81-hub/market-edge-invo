"""TASK G (#85): Execution Friction Model V2, a measurement layer.

Records, per executed trade, the friction the paper simulator ASSUMED (lifecycle.py's fixed fee and slippage) next to the
friction that could be OBSERVED (a real order-book walk at entry; the real observed price and its overshoot at exit), and
their difference. It changes no fill, fee, size or decision: every number here is derived from values the engine already
computed plus the book read Risk Sizing V2 already performs (no second network call).

Provenance is explicit and never flattering:
  measured      the value comes from a real observation (book walk, observed price)
  default_used  no validated live input existed; the reported "actual" is the simulator's own assumption, never a
                more favourable number, and `difference_pct` is None because nothing was measured
The fee is always default_used: the paper venue's real fee tier is not observed, so the flat taker assumption is reported
as an assumption, not as a measurement.
"""
from __future__ import annotations

import math
from typing import Optional

from market_edge_exec.paper import lifecycle
from market_edge_exec.risk import sizing_v2 as S

FRICTION_VERSION = "FRICTION-V2"
MEASURED, DEFAULT_USED = "measured", "default_used"
EXPECTED_SOURCE = "LIFECYCLE_FIXED_MODEL"
STOP_KINDS = ("STOP", "BREAKEVEN_STOP", "TIMEOUT")


def _finite(*values) -> bool:
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values)


def expected_per_side() -> dict:
    """The fixed assumption the simulator applies to every fill, per side, as a fraction of notional."""
    return {"fee_pct": lifecycle.FEE_PCT, "slippage_pct": lifecycle.SLIPPAGE_PCT,
            "total_pct": lifecycle.FEE_PCT + lifecycle.SLIPPAGE_PCT, "source": EXPECTED_SOURCE}


def _walk(book: list, notional: float, mid: float) -> Optional[tuple[float, float]]:
    """Average fill price and worst level price for `notional` (in quote) against `book` [(px, sz)], or None if the book is too thin."""
    need, cost, got, worst = notional / mid, 0.0, 0.0, None
    for px, sz in book:
        take = min(sz, need - got)
        if take <= 0:
            break
        cost, got, worst = cost + px * take, got + take, px
        if got >= need - 1e-12:
            return cost / got, worst
    return None


def entry_friction(direction: str, mark_price: float, entry_fill: float, quantity: float, now_ms: int,
                   mark_at_ms: Optional[int], signal_timestamp: Optional[int], depth, policy) -> dict:
    """Friction for the entry leg. `depth` is the Risk Sizing V2 DepthInput (or None), `policy` its SizingPolicy."""
    exp = expected_per_side()
    notional = quantity * mark_price if _finite(quantity, mark_price) else None
    rec: dict = {
        "version": FRICTION_VERSION, "leg": "ENTRY", "expected": exp, "proposed_notional": notional,
        "fee": {"pct": lifecycle.FEE_PCT, "type": "TAKER_ASSUMED", "provenance": DEFAULT_USED,
                "note": "the paper venue's real fee tier is not observed"},
        "latency": {"signal_to_entry_ms": (now_ms - signal_timestamp) if _finite(signal_timestamp) else None,
                    "mark_age_ms": (now_ms - mark_at_ms) if _finite(mark_at_ms) else None, "submit_to_fill_ms": None,
                    "note": "paper fills are instantaneous; no venue round trip exists to time"},
        "spread_bps": None, "fill_vwap": None, "market_impact_bps": None, "depth": None,
    }
    reason = None
    try:
        state, why = S.liquidity_state(depth, direction, now_ms, policy)
        if state is None:
            reason = f"no validated depth: {why}"
        else:
            bids, asks = S._levels(depth.bids), S._levels(depth.asks)
            mid = state["mid"]
            rec["spread_bps"] = (asks[0][0] - bids[0][0]) / mid * 10_000
            rec["depth"] = {"venue": depth.venue, "at_ms": depth.at_ms, "age_ms": now_ms - depth.at_ms, "levels_used": state["book_levels"],
                            "liquidity_cap_notional": state["liquidity_cap_notional"]}
            book = asks if direction == "long" else bids
            walked = _walk(book, entry_fill * quantity, mid) if notional else None
            if walked is None:
                reason = "order is larger than the visible book, so its fill cannot be measured"
            else:
                vwap, worst = walked
                adverse = (vwap - mid) if direction == "long" else (mid - vwap)
                rec["fill_vwap"] = vwap
                rec["market_impact_bps"] = abs(vwap - book[0][0]) / mid * 10_000
                rec["book_slippage_pct"] = adverse / mid
                rec["worst_level_px"] = worst
    except (ValueError, TypeError) as error:  # malformed book never becomes a measurement
        reason = f"depth unusable: {error}"
        rec["spread_bps"] = rec["fill_vwap"] = rec["market_impact_bps"] = None
    if reason is None and rec["fill_vwap"] is not None:
        slip = max(rec["book_slippage_pct"], 0.0)  # a walk cannot be better than the mid; a negative is never credited
        rec["actual"] = {"fee_pct": lifecycle.FEE_PCT, "slippage_pct": slip, "total_pct": lifecycle.FEE_PCT + slip,
                         "slippage_provenance": MEASURED, "fee_provenance": DEFAULT_USED}
        rec["slippage_provenance"], rec["default_reason"] = MEASURED, None
        rec["difference_pct"] = rec["actual"]["total_pct"] - exp["total_pct"]
    else:
        rec["actual"] = {"fee_pct": lifecycle.FEE_PCT, "slippage_pct": lifecycle.SLIPPAGE_PCT, "total_pct": exp["total_pct"],
                         "slippage_provenance": DEFAULT_USED, "fee_provenance": DEFAULT_USED}
        rec["slippage_provenance"], rec["default_reason"], rec["difference_pct"] = DEFAULT_USED, reason or "no depth", None
    return rec


def _adverse_pct(direction: str, level: float, price: float) -> float:
    """How far `price` is beyond `level` against the position, as a fraction of level (>= 0 when adverse)."""
    return ((level - price) if direction == "long" else (price - level)) / level


def exit_friction(direction: str, kind: str, level: float, fill_price: float, trigger: str,
                  observed_price: Optional[float] = None, observation_lag_ms: Optional[int] = None,
                  since_previous_observation_ms: Optional[int] = None) -> dict:
    """Friction for one exit leg. Long exits sell (adverse = lower), short exits buy (adverse = higher)."""
    exp = expected_per_side()
    has_obs = _finite(observed_price) and observed_price > 0 and _finite(level) and level > 0
    # what the leg actually cost against the geometry level (overshoot plus the simulator's fixed slippage)
    actual_slip = _adverse_pct(direction, level, fill_price) if _finite(level, fill_price) and level > 0 else None
    rec = {"version": FRICTION_VERSION, "leg": "EXIT", "kind": kind, "trigger": trigger, "expected": exp, "level": level,
           "fill_price": fill_price, "observed_price": observed_price if has_obs else None,
           "fee": {"pct": lifecycle.FEE_PCT, "type": "TAKER_ASSUMED", "provenance": DEFAULT_USED},
           "monitor": {"observation_lag_ms": observation_lag_ms, "since_previous_observation_ms": since_previous_observation_ms}}
    if has_obs and actual_slip is not None:
        overshoot = max(_adverse_pct(direction, level, observed_price), 0.0)
        # a resting limit (TP) fills at its level even when the print is through it; only a stop-market pays the overshoot
        rec["stop_overshoot_pct"] = overshoot if kind in STOP_KINDS else 0.0
        actual = max(actual_slip, 0.0)
        rec["actual"] = {"fee_pct": lifecycle.FEE_PCT, "slippage_pct": actual, "total_pct": lifecycle.FEE_PCT + actual,
                         "slippage_provenance": MEASURED, "fee_provenance": DEFAULT_USED,
                         "measured_component": "overshoot of the real observed price past the level; the remainder is the fixed slippage assumption"}
        rec["slippage_provenance"], rec["default_reason"] = MEASURED, None
        rec["difference_pct"] = rec["actual"]["total_pct"] - exp["total_pct"]
    else:
        rec["stop_overshoot_pct"] = None
        rec["actual"] = {"fee_pct": lifecycle.FEE_PCT, "slippage_pct": lifecycle.SLIPPAGE_PCT, "total_pct": exp["total_pct"],
                         "slippage_provenance": DEFAULT_USED, "fee_provenance": DEFAULT_USED}
        rec["slippage_provenance"] = DEFAULT_USED
        rec["default_reason"] = "candle-path exit: no live observed price, only the completed candle's level" if not has_obs else "no usable level"
        rec["difference_pct"] = None
    return rec


def summarize(trade: dict) -> dict:
    """Trade-level roll-up in quote currency: expected vs actual friction across the entry and every exit so far.
    `difference` is summed only over legs whose slippage was measured; `default_used_legs` lists the rest."""
    legs = []
    entry = trade.get("friction_entry")
    if entry and _finite(trade.get("entry_fill"), trade.get("quantity")):
        legs.append(("ENTRY", entry, trade["entry_fill"] * trade["quantity"]))
    for ex in trade.get("exits") or []:
        f = ex.get("friction")
        if f and _finite(ex.get("fill_price"), ex.get("quantity")):
            legs.append((ex.get("kind"), f, ex["fill_price"] * ex["quantity"]))
    expected = sum(f["expected"]["total_pct"] * n for _, f, n in legs)
    actual = sum(f["actual"]["total_pct"] * n for _, f, n in legs)
    measured = [(k, f, n) for k, f, n in legs if f["slippage_provenance"] == MEASURED]
    return {"version": FRICTION_VERSION, "legs": len(legs), "expected_friction": expected, "actual_friction": actual,
            "difference": sum(f["difference_pct"] * n for _, f, n in measured),
            "measured_legs": [k for k, _, _ in measured], "default_used_legs": [k for k, f, _ in legs if f["slippage_provenance"] != MEASURED],
            "note": "difference covers measured legs only; default_used legs report the simulator's own assumption"}
