"""TASK I (#87): the order-book walk as its own reusable stage.

This is the book walk that Risk Sizing V2's liquidity cap has always used, moved here unchanged and given a richer output.
It has two consumers:
  1. sizing_v2.liquidity_state() (same signature, same keys, same numbers as before: N_liquidity / liquidity_status),
  2. assess(): the `execution_feasibility` stage (PASS / REDUCE / REJECT) for the decision-semantics pipeline.
It performs no I/O: the caller passes the one l2Book read the cycle already made, so there is no second network call.

Units: every level is (price, quantity) and `level_notional = price * quantity`. A quantity is never compared with a notional.
Liquidity can only shrink an order. Nothing here returns more than was requested, and strong depth never raises size.
No depth, stale depth, wrong venue or a crossed book yield no state, and assess() then REJECTs: depth is never faked or reused.
"""
from __future__ import annotations

import math
from typing import Optional

BANDS_BPS = (5, 10, 25, 50)
PASS, REDUCE, REJECT = "PASS", "REDUCE", "REJECT"
NO_LIQUIDITY_STATE = "NO_LIQUIDITY_STATE"
EXCESS_EXPECTED_SLIPPAGE = "EXCESS_EXPECTED_SLIPPAGE"
STAGE_VERSION = "EXECUTION-FEASIBILITY-V1"


def finite(*xs) -> bool:
    return all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in xs)


def levels(side: list) -> list[tuple[float, float]]:
    out = []
    for lvl in side or []:
        px, sz = (lvl[0], lvl[1]) if isinstance(lvl, (list, tuple)) else (lvl.get("px"), lvl.get("sz"))
        px, sz = float(px), float(sz)
        if not (finite(px, sz) and px > 0 and sz > 0):
            raise ValueError("bad depth level")
        out.append((px, sz))
    return out


def walk(depth, direction: str, now_ms: int, policy) -> tuple[Optional[dict], Optional[str]]:
    """The largest order whose average fill stays within `policy.max_expected_entry_slippage_bps` of the mid, walking the
    real book, plus the richer shape (VWAP, per-band depth, spread, impact). `depth` is a DepthInput (venue, bids, asks,
    at_ms) or None; `policy` supplies vol_venue, max_depth_age_ms and max_expected_entry_slippage_bps."""
    if depth is None:
        return None, "missing"
    if depth.venue != policy.vol_venue:
        return None, f"wrong venue {depth.venue}"
    if not finite(depth.at_ms) or now_ms - depth.at_ms > policy.max_depth_age_ms or depth.at_ms > now_ms + 5_000:
        return None, "stale depth"
    try:
        bids, asks = levels(depth.bids), levels(depth.asks)
    except (TypeError, ValueError):
        return None, "invalid depth"
    if not bids or not asks or bids[0][0] >= asks[0][0]:
        return None, "invalid depth"
    mid = (bids[0][0] + asks[0][0]) / 2
    book = asks if direction == "long" else bids
    bound = policy.max_expected_entry_slippage_bps / 10_000
    cap_notional, cost, qty = 0.0, 0.0, 0.0     # cost = sum px*sz consumed
    for px, sz in book:
        # average px after adding x units of this level must stay within the bound
        limit = mid * (1 + bound) if direction == "long" else mid * (1 - bound)
        adverse = (px - limit) if direction == "long" else (limit - px)
        if adverse <= 0:
            cost, qty = cost + px * sz, qty + sz
            continue
        # solve (cost + px*x) / (qty + x) = limit for x
        x = (limit * qty - cost) / adverse if direction == "long" else (cost - limit * qty) / adverse
        x = max(0.0, min(sz, x))
        cost, qty = cost + px * x, qty + x
        break
    cap_notional = qty * mid

    def fill(notional: float) -> Optional[tuple[float, float]]:
        """(average price, quantity) for `notional` quote units (at mid) against this side, or None if the book is too thin."""
        need, c, q = notional / mid, 0.0, 0.0
        for px, sz in book:
            take = min(sz, need - q)
            c, q = c + px * take, q + take
            if q >= need - 1e-15:
                break
        if q < need - 1e-12:
            return None
        return c / q, q

    def slippage_at(notional: float) -> float:
        if notional <= 0:
            return 0.0
        got = fill(notional)
        return math.inf if got is None else abs(got[0] / mid - 1)

    def within(bps: float) -> dict:
        lo, hi = mid * (1 - bps / 10_000), mid * (1 + bps / 10_000)
        chosen = [(px, sz) for px, sz in book if (px <= hi if direction == "long" else px >= lo)]
        return {"level_notional": sum(px * sz for px, sz in chosen), "quantity": sum(sz for _, sz in chosen), "levels": len(chosen)}

    def vwap_at(notional: float) -> Optional[float]:
        got = fill(notional) if notional > 0 else None
        return None if got is None else got[0]

    def impact_bps_at(notional: float) -> Optional[float]:
        got = fill(notional) if notional > 0 else None
        return None if got is None else abs(got[0] - book[0][0]) / mid * 10_000

    return {"mid": mid, "liquidity_cap_notional": cap_notional, "slippage_at": slippage_at,
            "depth_at_ms": depth.at_ms, "book_levels": len(book),
            "best_bid": bids[0][0], "best_ask": asks[0][0], "spread_bps": (asks[0][0] - bids[0][0]) / mid * 10_000,
            "vwap_at": vwap_at, "impact_bps_at": impact_bps_at,
            "depth_within_bps": {b: within(b) for b in BANDS_BPS},
            "visible_notional": sum(px * sz for px, sz in book)}, None


def assess(depth, direction: str, notional: Optional[float], now_ms: int, policy) -> dict:
    """The `execution_feasibility` stage for an order of `notional` quote units. Never returns more than requested and
    never PASSes without a real, fresh, same-venue book."""
    base = {"stage": "EXECUTION_FEASIBILITY", "version": STAGE_VERSION, "direction": direction, "requested_notional": notional,
            "max_expected_slippage_bps": policy.max_expected_entry_slippage_bps}
    state, why = walk(depth, direction, now_ms, policy)
    if state is None:
        return {**base, "decision": REJECT, "reason": NO_LIQUIDITY_STATE, "detail": why, "liquidity_status": f"UNAVAILABLE ({why})",
                "max_notional": 0.0, "expected_vwap": None, "slippage_bps": None, "market_impact_bps": None, "depth_within_bps": None}
    cap = state["liquidity_cap_notional"]
    detail = {"liquidity_status": "BOOK", "spread_bps": state["spread_bps"], "depth_at_ms": state["depth_at_ms"],
              "depth_age_ms": now_ms - state["depth_at_ms"], "liquidity_cap_notional": cap, "visible_notional": state["visible_notional"],
              "depth_within_bps": state["depth_within_bps"]}
    if not finite(notional) or notional <= 0:
        return {**base, **detail, "decision": REJECT, "reason": "INVALID_NOTIONAL", "detail": "requested notional must be a positive number",
                "max_notional": 0.0, "expected_vwap": None, "slippage_bps": None, "market_impact_bps": None}
    if cap <= 0:
        return {**base, **detail, "decision": REJECT, "reason": EXCESS_EXPECTED_SLIPPAGE, "detail": "the first unit already exceeds the slippage bound",
                "max_notional": 0.0, "expected_vwap": None, "slippage_bps": None, "market_impact_bps": None}
    allowed = min(notional, cap)               # liquidity only ever reduces
    vwap = state["vwap_at"](allowed)
    slip = state["slippage_at"](allowed)
    decision = PASS if notional <= cap else REDUCE
    return {**base, **detail, "decision": decision, "reason": None if decision == PASS else "REQUESTED_EXCEEDS_LIQUIDITY_CAP",
            "detail": None, "max_notional": allowed, "expected_vwap": vwap, "slippage_bps": slip * 10_000 if math.isfinite(slip) else None,
            "market_impact_bps": state["impact_bps_at"](allowed)}
