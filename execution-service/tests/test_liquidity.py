"""TASK I: the shared book walk (risk/liquidity.py) and the execution_feasibility stage.

The reference copy below is the pre-refactor `sizing_v2.liquidity_state`, frozen verbatim (only renamed), so the refactor is
proven number-for-number against the original on randomised books instead of only by the existing suite."""
import math
import random

import pytest

from market_edge_exec.risk import liquidity as L
from market_edge_exec.risk import sizing_v2 as S

NOW = 1_800_000_000_000
POLICY = S.DEFAULT_POLICY
from typing import Optional  # noqa: E402  (reference copy uses it)


def _ref_levels(side: list) -> list[tuple[float, float]]:
    out = []
    for lvl in side or []:
        px, sz = (lvl[0], lvl[1]) if isinstance(lvl, (list, tuple)) else (lvl.get("px"), lvl.get("sz"))
        px, sz = float(px), float(sz)
        if not (S._finite(px, sz) and px > 0 and sz > 0):
            raise ValueError("bad depth level")
        out.append((px, sz))
    return out


def ref_liquidity_state(depth: object, direction: str, now_ms: int, policy) -> tuple[object, object]:
    """The largest order whose average fill stays within
    MAX_EXPECTED_ENTRY_SLIPPAGE_BPS of the mid, walking the real book."""
    if depth is None:
        return None, "missing"
    if depth.venue != policy.vol_venue:
        return None, f"wrong venue {depth.venue}"
    if not S._finite(depth.at_ms) or now_ms - depth.at_ms > policy.max_depth_age_ms or depth.at_ms > now_ms + 5_000:
        return None, "stale depth"
    try:
        bids, asks = _ref_levels(depth.bids), _ref_levels(depth.asks)
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

    def slippage_at(notional: float) -> float:
        if notional <= 0:
            return 0.0
        need, c, q = notional / mid, 0.0, 0.0
        for px, sz in book:
            take = min(sz, need - q)
            c, q = c + px * take, q + take
            if q >= need - 1e-15:
                break
        if q < need - 1e-12:
            return math.inf
        return abs(c / q / mid - 1)
    return {"mid": mid, "liquidity_cap_notional": cap_notional, "slippage_at": slippage_at,
            "depth_at_ms": depth.at_ms, "book_levels": len(book)}, None




def dep(bids, asks, at=NOW - 500, venue="HYPERLIQUID"):
    return S.DepthInput(venue, bids, asks, at)


def book(mid=100.0, half=0.01, size=5.0, levels=12, step=0.05, jitter=None):
    rnd = random.Random(jitter) if jitter is not None else None
    def sz(): return size * (0.2 + 1.8 * rnd.random()) if rnd else size
    return dep([[mid - half - i * step, sz()] for i in range(levels)], [[mid + half + i * step, sz()] for i in range(levels)])


# ---- refactor equivalence -----------------------------------------------------------------------------------------
@pytest.mark.parametrize("seed", range(40))
@pytest.mark.parametrize("direction", ["long", "short"])
def test_shared_walk_matches_the_pre_refactor_function_number_for_number(seed, direction):
    rnd = random.Random(seed)
    d = book(mid=rnd.uniform(1, 500), half=rnd.uniform(0.0001, 0.3), size=rnd.uniform(0.01, 80), levels=rnd.randint(1, 25),
             step=rnd.uniform(0.0001, 0.6), jitter=seed)
    old, why_old = ref_liquidity_state(d, direction, NOW, POLICY)
    new, why_new = S.liquidity_state(d, direction, NOW, POLICY)
    assert why_old == why_new
    if old is None:
        assert new is None
        return
    assert set(new) == set(old)                                     # same keys, so records are unchanged
    for k in ("mid", "liquidity_cap_notional", "depth_at_ms", "book_levels"):
        assert new[k] == old[k], k
    for notional in (0, 1, 10, old["liquidity_cap_notional"] * 0.5, old["liquidity_cap_notional"], old["liquidity_cap_notional"] * 3, 1e9):
        a, b = old["slippage_at"](notional), new["slippage_at"](notional)
        assert a == b or (math.isinf(a) and math.isinf(b)), notional


@pytest.mark.parametrize("bad,why", [(None, "missing"), (dep([[99.9, 1]], [[100.1, 1]], at=NOW - 120_000), "stale depth"),
                                     (dep([[99.9, 1]], [[100.1, 1]], venue="BINANCE"), "wrong venue"),
                                     (dep([[100.2, 1]], [[100.1, 1]]), "invalid depth"), (dep([[99.9, "x"]], [[100.1, 1]]), "invalid depth"),
                                     (dep([], [[100.1, 1]]), "invalid depth"), (dep([[99.9, 1]], [[100.1, 1]], at=NOW + 60_000), "stale depth")])
def test_fail_closed_states_are_unchanged(bad, why):
    assert ref_liquidity_state(bad, "long", NOW, POLICY)[1].startswith(why)
    assert S.liquidity_state(bad, "long", NOW, POLICY) == (None, ref_liquidity_state(bad, "long", NOW, POLICY)[1])


# ---- richer output against a synthetic book -----------------------------------------------------------------------
def test_richer_output_is_correct_against_a_hand_computed_book():
    d = dep([[99.99, 10], [99.90, 10], [99.70, 10]], [[100.01, 2.0], [100.05, 3.0], [100.30, 10.0], [100.60, 10.0]])
    s, _ = L.walk(d, "long", NOW, POLICY)
    assert s["mid"] == pytest.approx(100.0) and s["spread_bps"] == pytest.approx(2.0)
    # notional 400 at mid = 4 units: 2 @100.01 + 2 @100.05
    assert s["vwap_at"](400.0) == pytest.approx((2 * 100.01 + 2 * 100.05) / 4)
    assert s["slippage_at"](400.0) == pytest.approx((2 * 100.01 + 2 * 100.05) / 4 / 100 - 1)
    assert s["impact_bps_at"](400.0) == pytest.approx(((2 * 100.01 + 2 * 100.05) / 4 - 100.01) / 100 * 10_000)
    # depth within N bps of mid = level_notional (price x quantity) of ask levels at or below mid*(1+N/1e4)
    b = s["depth_within_bps"]
    assert b[5]["level_notional"] == pytest.approx(100.01 * 2.0 + 100.05 * 3.0) and b[5]["levels"] == 2 and b[5]["quantity"] == pytest.approx(5.0)
    assert b[10]["level_notional"] == pytest.approx(100.01 * 2 + 100.05 * 3) and b[25]["levels"] == 2   # 100.30 is 30 bps out
    assert b[50]["level_notional"] == pytest.approx(100.01 * 2 + 100.05 * 3 + 100.30 * 10) and b[50]["levels"] == 3   # 100.60 is 60 bps out
    assert s["visible_notional"] == pytest.approx(100.01 * 2 + 100.05 * 3 + 100.30 * 10 + 100.60 * 10)
    assert s["vwap_at"](1e9) is None and s["vwap_at"](0) is None       # too thin / empty: no number, never a guess
    short, _ = L.walk(d, "short", NOW, POLICY)
    assert short["depth_within_bps"][5]["level_notional"] == pytest.approx(99.99 * 10) and short["depth_within_bps"][10]["level_notional"] == pytest.approx(99.99 * 10 + 99.90 * 10) and short["vwap_at"](100.0) == pytest.approx(99.99)


def test_quantity_is_never_compared_with_notional():
    # 1000 units at 100 is 100,000 of notional; a 5,000 order is small against it even though 5,000 > 1000 is false
    d = dep([[99.99, 1000]], [[100.01, 1000]])
    assert L.assess(d, "long", 5_000.0, NOW, POLICY)["decision"] == L.PASS
    thin = dep([[99.99, 0.01]], [[100.01, 0.01]])    # 1.0 of notional visible
    assert L.assess(thin, "long", 5_000.0, NOW, POLICY)["decision"] != L.PASS


# ---- execution_feasibility ----------------------------------------------------------------------------------------
def test_pass_reduce_and_reject_with_reasons():
    d = book(size=5.0)
    cap = L.walk(d, "long", NOW, POLICY)[0]["liquidity_cap_notional"]
    ok = L.assess(d, "long", cap * 0.5, NOW, POLICY)
    assert ok["decision"] == L.PASS and ok["max_notional"] == pytest.approx(cap * 0.5) and ok["slippage_bps"] <= POLICY.max_expected_entry_slippage_bps + 1e-9
    red = L.assess(d, "long", cap * 4, NOW, POLICY)
    assert red["decision"] == L.REDUCE and red["max_notional"] == pytest.approx(cap) and red["reason"] == "REQUESTED_EXCEEDS_LIQUIDITY_CAP"
    assert red["slippage_bps"] == pytest.approx(POLICY.max_expected_entry_slippage_bps, rel=1e-6) or red["slippage_bps"] <= POLICY.max_expected_entry_slippage_bps
    wide = dep([[99.0, 5]], [[101.0, 5]])                          # spread far beyond the bound: first unit already too costly
    r = L.assess(wide, "long", 100.0, NOW, POLICY)
    assert r["decision"] == L.REJECT and r["reason"] == L.EXCESS_EXPECTED_SLIPPAGE
    assert L.assess(d, "long", -1, NOW, POLICY)["reason"] == "INVALID_NOTIONAL" and L.assess(d, "long", None, NOW, POLICY)["decision"] == L.REJECT


@pytest.mark.parametrize("bad", [None, dep([[99.9, 1]], [[100.1, 1]], at=NOW - 120_000), dep([[99.9, 1]], [[100.1, 1]], venue="BINANCE"),
                                 dep([[100.2, 1]], [[100.1, 1]])])
def test_feasibility_never_passes_where_sizing_would_fail_closed(bad):
    sizing_state, _ = S.liquidity_state(bad, "long", NOW, POLICY)
    assert sizing_state is None                                     # sizing_v2 answers NO_LIQUIDITY_STATE here
    r = L.assess(bad, "long", 100.0, NOW, POLICY)
    assert r["decision"] == L.REJECT and r["reason"] == "NO_LIQUIDITY_STATE" and r["max_notional"] == 0.0 and r["liquidity_status"].startswith("UNAVAILABLE")


@pytest.mark.parametrize("seed", range(30))
def test_feasibility_agrees_with_the_sizing_cap_and_never_returns_more_than_requested(seed):
    rnd = random.Random(seed)
    d = book(size=rnd.uniform(0.05, 60), half=rnd.uniform(0.001, 0.2), levels=rnd.randint(1, 20), jitter=seed)
    for direction in ("long", "short"):
        state, _ = S.liquidity_state(d, direction, NOW, POLICY)
        for req in (1.0, 50.0, 1_000.0, 50_000.0, 5e6):
            r = L.assess(d, direction, req, NOW, POLICY)
            assert r["max_notional"] <= req + 1e-9
            if state["liquidity_cap_notional"] <= 0:
                assert r["decision"] == L.REJECT
            else:
                assert r["max_notional"] == pytest.approx(min(req, state["liquidity_cap_notional"]))
                assert r["decision"] == (L.PASS if req <= state["liquidity_cap_notional"] else L.REDUCE)


def test_stronger_liquidity_never_increases_the_allowed_notional_beyond_the_request():
    # explicit regression for the invariant: deep books do not upsize, they only stop capping
    for size in (0.1, 1, 10, 1_000, 1e6):
        r = L.assess(book(size=size), "long", 2_000.0, NOW, POLICY)
        assert r["max_notional"] <= 2_000.0 + 1e-9
    deep = L.assess(book(size=1e6), "long", 2_000.0, NOW, POLICY)
    assert deep["decision"] == L.PASS and deep["max_notional"] == pytest.approx(2_000.0)
    # and through the real sizer: better depth never yields a larger final notional than the same request with deep depth
    from tests.test_risk_sizing_v2 import req as sizing_req, depth as sizing_depth, notional as sizing_notional
    sizes = [sizing_notional(sizing_req(0.02, dep=sizing_depth(size_per_level=s))) for s in (50.0, 5.0, 1.0, 0.5, 0.2, 0.05)]
    assert all(a >= b - 1e-9 for a, b in zip(sizes, sizes[1:]))
    assert max(sizes) <= sizing_notional(sizing_req(0.02, dep=sizing_depth(size_per_level=5e6))) + 1e-9
