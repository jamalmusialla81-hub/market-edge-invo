"""TASK O: fixed-parameter lifecycle variants live in the existing exit-policy registry and replay through the same lifecycle."""
import dataclasses
import random

import pytest

from market_edge_exec.exits import policies as pol, replay as rp
from market_edge_exec.exits.model import Observation, TradeSpec
from market_edge_exec.paper import lifecycle

M5, H = 300_000, 3_600_000
V1_POLICIES = 18
VARIANTS = ("TP1_SPLIT_V1_25_75", "TP1_SPLIT_V1_75_25", "TIMEOUT_V1_H48", "TIMEOUT_V1_H72")


def spec(direction="long", entry=100.0, stop=90.0, tp1=110.0, tp2=120.0, qty=4.0):
    return TradeSpec("t", direction, entry, stop, tp1, tp2, qty, 0, lifecycle.fee(entry, qty))


def obs(i, o, h, l, c, seq=None, last=True, kind="CANDLE"):
    return Observation(seq=seq or i, kind=kind, at_ms=i * M5, eval_ms=(i + 1) * M5, price=c, high=h, low=l, open=o, batch=i, last=last)


def run(policy, s, path):
    return rp.replay(s, path, pol.REGISTRY[policy])


def test_variants_are_registered_in_the_same_versioned_registry_and_no_v1_policy_changed():
    assert pol.POLICY_REGISTRY_VERSION == "EXIT-POLICIES-V3"   # V3 adds the 3Q STATE_AWARE_GIVEBACK_V1 family; 3O and V1 are untouched
    for name in VARIANTS:
        assert name in pol.REGISTRY and pol.REGISTRY[name].study == "3O"
    v1 = [p for p in pol.REGISTRY.values() if p.study not in ("3O", "3Q")]
    assert len(v1) == V1_POLICIES and v1[0].version == "CURRENT_POLICY"
    assert dict(pol.REGISTRY["TP1_SPLIT_V1_25_75"].params) == {"tp1_fraction": 0.25}
    assert dict(pol.REGISTRY["TIMEOUT_V1_H72"].params) == {"max_hold_h": 72}
    with pytest.raises(TypeError):
        pol.REGISTRY["TP1_SPLIT_V1_25_75"].params["tp1_fraction"] = 0.9
    assert "3O" in {p["study"] for p in pol.registry_view()}


@pytest.mark.parametrize("direction,entry,stop,tp1,tp2,path", [
    ("long", 100.0, 90.0, 110.0, 120.0, [obs(1, 100, 111, 99, 110), obs(2, 110, 121, 109, 120)]),
    ("short", 100.0, 110.0, 90.0, 80.0, [obs(1, 100, 101, 89, 90), obs(2, 90, 91, 79, 80)]),
])
def test_split_variants_take_the_named_fractions_at_tp1_and_tp2(direction, entry, stop, tp1, tp2, path):
    s = spec(direction, entry, stop, tp1, tp2, qty=4.0)
    for name, frac in (("TP1_SPLIT_V1_25_75", 0.25), ("CURRENT_POLICY", 0.5), ("TP1_SPLIT_V1_75_25", 0.75)):
        ev = run(name, s, path).events
        assert [e["kind"] for e in ev] == ["TP1", "TP2"], name
        assert ev[0]["quantity"] == pytest.approx(4.0 * frac) and ev[1]["quantity"] == pytest.approx(4.0 * (1 - frac))
        assert sum(e["quantity"] for e in ev) == pytest.approx(4.0)


def test_split_variants_change_r_only_through_the_split_and_breakeven_is_unchanged():
    s = spec(qty=4.0)
    path = [obs(1, 100, 111, 99, 110), obs(2, 110, 111, 99.9, 100.0)]      # TP1, then back to entry: breakeven stop
    kinds = {n: [e["kind"] for e in run(n, s, path).events] for n in ("CURRENT_POLICY", "TP1_SPLIT_V1_25_75", "TP1_SPLIT_V1_75_25")}
    assert set(map(tuple, kinds.values())) == {("TP1", "BREAKEVEN_STOP")}
    r = {n: rp.summarize(s, run(n, s, path))["counterfactual_R"] for n in kinds}
    assert r["TP1_SPLIT_V1_75_25"] > r["CURRENT_POLICY"] > r["TP1_SPLIT_V1_25_75"]   # more banked at TP1 is better when TP2 never comes


@pytest.mark.parametrize("direction", ["long", "short"])
def test_timeout_variants_exit_at_their_own_hours_and_baseline_keeps_120h(direction):
    long = direction == "long"
    s = spec(direction, 100.0, 90.0 if long else 110.0, 110.0 if long else 90.0, 120.0 if long else 80.0, qty=1.0)
    # a flat path of 5m candles for 130 hours, never touching stop or targets
    path = [obs(i, 100, 101, 99, 100.5, last=(i % 12 == 0 or i == 1560)) for i in range(1, 1561)]
    exits = {n: run(n, s, path) for n in ("TIMEOUT_V1_H48", "TIMEOUT_V1_H72", "CURRENT_POLICY")}
    for name, hours in (("TIMEOUT_V1_H48", 48), ("TIMEOUT_V1_H72", 72), ("CURRENT_POLICY", 120)):
        r = exits[name]
        assert r.status == "CLOSED" and r.exit_reason == "TIMEOUT", name
        assert hours * H <= r.closed_at_ms < (hours + 1) * H + M5, (name, r.closed_at_ms / H)


def test_a_timeout_variant_that_would_outlive_the_real_path_stays_open_never_a_fabricated_exit():
    s = spec(qty=1.0)
    path = [obs(i, 100, 101, 99, 100.5, last=(i % 12 == 0)) for i in range(1, 121)]    # only 10 hours of real path
    r = run("TIMEOUT_V1_H72", s, path)
    assert r.status == "OPEN"
    assert rp.summarize(s, r)["status"] == "OPEN"


def test_variants_never_intervene_beyond_their_one_number():
    """A variant with the baseline's own value is indistinguishable from CURRENT_POLICY on any path."""
    same = pol.Policy("X", "3O", pol.structural_variant, {"tp1_fraction": lifecycle.TP1_FRACTION, "max_hold_h": lifecycle.MAX_HOLD_MS // H}, "identity")
    for seed in range(15):
        rnd = random.Random(seed)
        price, path = 100.0, []
        for i in range(1, 400):
            o = price
            c = o * (1 + rnd.uniform(-0.012, 0.012))
            path.append(obs(i, o, max(o, c) * 1.002, min(o, c) * 0.998, c, last=(i % 12 == 0)))
            price = c
        s = spec(qty=1.0, stop=94.0, tp1=106.0, tp2=112.0)
        a = rp.replay(s, path, pol.REGISTRY["CURRENT_POLICY"])
        b = rp.replay(s, path, same)
        assert dataclasses.asdict(a) == dataclasses.asdict(b), seed


@pytest.mark.parametrize("seed", range(10))
def test_variants_are_deterministic_incremental_and_never_grow_the_position(seed):
    rnd = random.Random(seed + 500)
    price, path = 100.0, []
    for i in range(1, 300):
        o = price
        c = o * (1 + rnd.uniform(-0.015, 0.015))
        path.append(obs(i, o, max(o, c) * 1.003, min(o, c) * 0.997, c, last=(i % 12 == 0)))
        price = c
    s = spec(qty=1.0, stop=94.0, tp1=106.0, tp2=112.0)
    for name in VARIANTS:
        full = rp.replay(s, path, pol.REGISTRY[name])
        assert dataclasses.asdict(full) == dataclasses.asdict(rp.replay(s, path, pol.REGISTRY[name]))
        part = rp.replay(s, path[:137], pol.REGISTRY[name])
        rp.replay(s, path[137:], pol.REGISTRY[name], part)
        assert dataclasses.asdict(part) == dataclasses.asdict(full), name
        assert full.qty_left <= s.quantity + 1e-12


def test_production_lifecycle_defaults_are_unchanged():
    assert lifecycle.TP1_FRACTION == 0.5 and lifecycle.MAX_HOLD_MS == 120 * H
    ev = lifecycle.evaluate_tick("long", 100.0, 90.0, 110.0, 120.0, 4.0, 4.0, False, 0, 111.0, M5)
    assert ev[0].kind == "TP1" and ev[0].quantity == 2.0
    ev25 = lifecycle.evaluate_tick("long", 100.0, 90.0, 110.0, 120.0, 4.0, 4.0, False, 0, 111.0, M5, tp1_fraction=0.25)
    assert ev25[0].quantity == 1.0


# ---- through the REAL engine and its shadow store ------------------------------------------------------------------
def test_variants_are_recorded_as_counterfactuals_beside_a_real_trade_and_do_not_touch_it(tmp_path):
    from tests.test_exit_manager import open_real, tick, cf
    app, trade = open_real(str(tmp_path / "v.sqlite3"))
    for price in (111.0, 104.0):                 # TP1 fills, then the price falls back below it
        tick(app, price)
    tick(app, 99.0)                              # breakeven stop
    real = app.state.ledger.trade("sig-1")
    assert [e["kind"] for e in real["exits"]] == ["TP1", "BREAKEVEN_STOP"] and real["exits"][0]["quantity"] == pytest.approx(real["quantity"] * 0.5)
    for name, frac in (("TP1_SPLIT_V1_25_75", 0.25), ("TP1_SPLIT_V1_75_25", 0.75), ("CURRENT_POLICY", 0.5)):
        rec = cf(app, "sig-1", name)
        assert rec["status"] == "EXITED" and rec["registry_version"] == pol.POLICY_REGISTRY_VERSION
        assert rec["events"][0]["kind"] == "TP1" and rec["events"][0]["quantity"] == pytest.approx(real["quantity"] * frac)
    # timeouts: the real trade closed long before 48h, so those variants also finish identically to the baseline
    assert cf(app, "sig-1", "TIMEOUT_V1_H48")["counterfactual_R"] == pytest.approx(cf(app, "sig-1")["counterfactual_R"])
    assert app.state.ledger.trade("sig-1")["exits"] == real["exits"]           # the real trade is untouched
