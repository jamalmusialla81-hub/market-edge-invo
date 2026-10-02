"""STATE_AWARE_GIVEBACK_V1 (#121): interpretable, preregistered, tighten-only, shadow only."""
import random

import pytest

from market_edge_exec.exits import policies as pol
from market_edge_exec.exits import prereg
from market_edge_exec.exits import replay as rp
from market_edge_exec.exits.evaluation import evaluate
from market_edge_exec.exits.model import CANDLE_MS, HOLD, FULL_EXIT, TIGHTEN_STOP, Observation, TradeSpec
from market_edge_exec.exits.state import compute_state
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.shadow.store import ShadowStore

FAMILY = [n for n, p in pol.REGISTRY.items() if p.study == "3Q"]
PROTECT = pol.REGISTRY["STATE_AWARE_GIVEBACK_V1_PROTECT_G40_H3"]
EXIT = pol.REGISTRY["STATE_AWARE_GIVEBACK_V1_EXIT_G55_H3"]


def spec(entry=100.0, stop=98.0, tp1=108.0, tp2=112.0, direction="long"):
    """1R = 2 price units; TP1 is 4R away (the 'TP1 far away' shape)."""
    if direction == "short":
        stop, tp1, tp2 = 2 * entry - stop, 2 * entry - tp1, 2 * entry - tp2
    return TradeSpec(trade_id="t", direction=direction, entry=entry, stop=stop, tp1=tp1, tp2=tp2, quantity=0.5, opened_at_ms=0, entry_fee=0.0)


def observations(closes, spread=0.05, start_price=100.0):
    out, prev = [], start_price
    for i, c in enumerate(closes):
        out.append(Observation(seq=i + 1, kind="CANDLE", at_ms=i * CANDLE_MS, eval_ms=(i + 1) * CANDLE_MS, price=c, high=max(prev, c) + spread,
                               low=min(prev, c) - spread, open=prev, batch=i + 1, last=True))
        prev = c
    return out


def climb(to, bars, frm=100.0):
    return [frm + (to - frm) * (i + 1) / bars for i in range(bars)]


def states(sp, closes, policy=PROTECT, start_price=100.0):
    """Feed the replay one observation at a time and return the policy's Action after each."""
    run, actions = rp.new_run(sp), []
    for obs in observations(closes, start_price=start_price):
        rp.step(sp, run, obs, policy)
        actions.append(pol.state_aware_giveback(compute_state(sp, run), policy.params) if run.status == "OPEN" else None)
    return run, actions


# ---- the two motivating cases (normalised R; no real asset's prices are encoded) ----------------------------------
def test_case_a_a_recent_peak_with_healthy_momentum_is_held():
    # +1.1R peak, now +1.02R: 7% of the peak given back, the peak is minutes old, momentum still up
    closes = climb(102.2, 40) + [102.1, 102.05, 102.04, 102.06, 102.04]
    _, actions = states(spec(), closes)
    assert all(a.kind == HOLD for a in actions[:-1] if a) and actions[-1].kind == HOLD


def test_case_b_a_stalled_fading_winner_is_protected_and_the_stop_only_tightens():
    # peak +1.1R, then five hours of drift down toward +0.45R with negative momentum
    closes = climb(102.2, 40) + [102.2 - (102.2 - 100.9) * (i + 1) / 60 for i in range(60)]
    run, actions = states(spec(), closes)
    first = next(i for i, a in enumerate(actions) if a and a.kind == TIGHTEN_STOP)
    assert first >= 40 + 36                               # not before the 3h stall (36 bars) after the peak
    price_then = closes[first]
    assert 98.0 < actions[first].stop < price_then
    stops = [c[2] for c in run.stop_changes]
    assert stops and stops == sorted(stops) and stops[0] > 98.0      # ratchets up only, above the hard stop
    assert run.status == "CLOSED" and run.exit_reason == "POLICY_STOP"    # the fade then took the protective stop, not the 98 stop


def test_the_exit_variant_leaves_the_winner_instead_of_moving_the_stop():
    closes = climb(102.2, 40) + [102.2 - (102.2 - 100.9) * (i + 1) / 60 for i in range(60)]
    run = rp.replay(spec(), observations(closes), EXIT)
    assert run.exit_reason == "POLICY_EXIT" and run.status == "CLOSED"


def test_a_short_trade_mirrors_the_long_case():
    sp = TradeSpec(trade_id="t", direction="short", entry=200.0, stop=204.0, tp1=184.0, tp2=176.0, quantity=0.25, opened_at_ms=0, entry_fee=0.0)   # 1R = 4
    up = [200.0 - 4.0 * 1.1 * (i + 1) / 40 for i in range(40)]                      # +1.1R in favour (price falls)
    down = [up[-1] + 4.0 * 0.65 * (i + 1) / 60 for i in range(60)]                  # then fades back up
    run, actions = states(sp, up + down, policy=PROTECT, start_price=200.0)
    first = next(i for i, a in enumerate(actions) if a and a.kind == TIGHTEN_STOP)
    assert (up + down)[first] < actions[first].stop < 204.0
    stops = [c[2] for c in run.stop_changes]
    assert stops and stops == sorted(stops, reverse=True) and stops[0] < 204.0      # a short's stop only moves down
    assert run.exit_reason == "POLICY_STOP"


def test_no_momentum_or_volatility_means_no_decision():
    sp = spec()
    run = rp.new_run(sp)
    for obs in observations([101.0, 102.2]):               # fewer than 4 closes: momentum unknown
        rp.step(sp, run, obs, PROTECT)
    assert compute_state(sp, run).momentum_R is None
    assert pol.state_aware_giveback(compute_state(sp, run), PROTECT.params).kind == HOLD


# ---- guarantees --------------------------------------------------------------------------------------------------
def random_walk(seed, n=600):
    rng, price, out = random.Random(seed), 100.0, []
    for _ in range(n):
        price = max(90.0, price + rng.gauss(0.02, 0.35))
        out.append(round(price, 4))
    return out


@pytest.mark.parametrize("seed", range(12))
def test_never_widens_a_stop_never_exits_later_and_is_deterministic(seed):
    sp, obs = spec(tp1=140.0, tp2=150.0), observations(random_walk(seed))
    base = rp.replay(sp, obs, pol.REGISTRY[pol.BASELINE])
    for name in FAMILY:
        run = rp.replay(sp, obs, pol.REGISTRY[name])
        again = rp.replay(sp, obs, pol.REGISTRY[name])
        assert rp.summarize(sp, run) == rp.summarize(sp, again)
        stops = [c[2] for c in run.stop_changes]
        assert stops == sorted(stops) and all(s > sp.stop for s in stops)
        if run.status == "CLOSED" and base.status == "CLOSED":
            assert run.closed_at_ms <= base.closed_at_ms


def test_variants_are_a_small_frozen_named_grid_and_no_earlier_policy_changed():
    assert len(FAMILY) == 6 == len(pol.STATE_AWARE_GRID["variants"])
    for name in FAMILY:
        params = pol.REGISTRY[name].params
        assert name == f"STATE_AWARE_GIVEBACK_V1_{params['mode']}_G{int(round(params['giveback_fraction'] * 100))}_H{params['stall_h']}"
        with pytest.raises(TypeError):
            params["mode"] = "EXIT"
    older = [n for n, p in pol.REGISTRY.items() if p.study != "3Q"]
    assert len(older) == 22 and older[0] == pol.BASELINE                       # the 18 + 4 already registered are untouched


def test_early_exit_regret_is_reported_beside_the_gate():
    sp = spec()
    records = []
    for i in range(3):     # three trades whose path fades, so the policy leaves earlier than the baseline stop
        closes = climb(102.2, 40) + [102.2 - (102.2 - 96.0) * (j + 1) / 120 for j in range(120)]
        for name in (pol.BASELINE, "STATE_AWARE_GIVEBACK_V1_EXIT_G55_H3"):
            run = rp.replay(sp, observations(closes), pol.REGISTRY[name])
            rec = rp.summarize(sp, run)
            rec.update({"trade_id": f"t{i}", "policy_version": name, "asset": "X", "direction": "long", "opened_at_ms": i * 90_000_000,
                        "stop_distance_pct": 2.0, "real_R": None})
            records.append(rec)
    m = evaluate(records)["policies"]["STATE_AWARE_GIVEBACK_V1_EXIT_G55_H3"]
    regret = m["early_exit_regret"]
    assert set(regret) == {"profit_saved_R", "upside_sacrificed_R", "net_exit_value_R", "worst_single_sacrifice_R"}
    assert regret["profit_saved_R"] > 0 and regret["net_exit_value_R"] == pytest.approx(m["delta_mean_R"])
    assert regret["profit_saved_R"] - regret["upside_sacrificed_R"] == pytest.approx(regret["net_exit_value_R"])
    assert m["verdict"] == "INSUFFICIENT_EVIDENCE"


def test_the_grid_is_preregistered_once_including_every_variant(tmp_path):
    registry = ExperimentRegistry(ShadowStore(str(tmp_path / "s.sqlite3")))
    first = prereg.register(registry)
    second = prereg.register(registry)
    assert first["created"] is True and second["created"] is False and first["experiment_id"] == second["experiment_id"] == prereg.EXPERIMENT_ID
    event = registry.history(prereg.EXPERIMENT_ID)
    assert event["status"] == "PLANNED"
    assert prereg.config()["hyperparameters"]["variant_names"] == FAMILY
