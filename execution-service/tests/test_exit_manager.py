"""Adaptive Exit Manager V1 (MAJOR 3A-3G): position state, candidate policies,
the counterfactual replay engine and its isolation from real trades."""
import dataclasses
import json
import os
import random
import sqlite3
import time
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.exits import policies as pol, replay as rp
from market_edge_exec.exits.model import (Action, FULL_EXIT, HOLD, Observation, PARTIAL_EXIT, TradeSpec, spec_from_trade,
                                          MOVE_TO_BREAKEVEN, TRAIL_STOP)
from market_edge_exec.exits.shadow import ExitShadow
from market_edge_exec.exits.state import RunState, compute_state, effective_stop
from market_edge_exec.paper import lifecycle
from market_edge_exec.risk.engine import RiskLimits

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
WIDE = RiskLimits(max_initial_position_notional_pct=100.0, max_portfolio_exposure_pct=100.0)
LIVE = "HYPERLIQUID_ALLMIDS_LIVE"
M5, H = 300_000, 3_600_000


# ---- helpers -------------------------------------------------------------------
def now_ms():
    return int(time.time() * 1000)


def signal(sid="sig-1", asset="ETH", direction="long", entry=100.0, stop=90.0, tp1=110.0, tp2=120.0, ts=None):
    return {"signal_id": sid, "asset": asset, "direction": direction, "timestamp": ts or now_ms(), "entry": entry, "stop": stop,
            "targets": [tp1, tp2], "strategy_id": "TREND CONTINUATION", "quant_score": 72}


def open_real(db, **kw):
    app = create_app(db_path=db, risk_limits=WIDE)
    t = now_ms() - 60_000
    kw.setdefault("entry", 100.0)
    result = app.state.paper.open_from_signal(signal(ts=t, **kw), "ETH-PERP", kw["entry"], t, now_ms=t, market_price_source=LIVE)
    assert result.accepted, result.reason
    return app, result.trade


def tick(app, price, at=None, **kw):
    return app.state.paper.tick("ETH-PERP", price, at if at is not None else now_ms(), LIVE, **kw)


def candle(t, o, h, l, c):
    return {"time": t, "open": o, "high": h, "low": l, "close": c}


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "exits.sqlite3")


def cf(app, trade_id, name="CURRENT_POLICY"):
    return app.state.paper.exit_shadow.store.load(trade_id)[name]["record"]


def assert_current_matches_real(app, trade_id):
    """The engine's own correctness check: CURRENT_POLICY replays the REAL exits."""
    trade = app.state.ledger.trade(trade_id)
    assert trade["status"] == "CLOSED"
    record = cf(app, trade_id)
    assert [e["kind"] for e in record["events"]] == [e["kind"] for e in trade["exits"]]
    for mine, real in zip(record["events"], trade["exits"]):
        assert mine["quantity"] == real["quantity"] and mine["fill_price"] == real["fill_price"] and mine["pnl"] == real["pnl"]
        assert mine["at_ms"] == real["at_ms"]
    assert record["counterfactual_R"] == pytest.approx(record["real_R"], rel=1e-12, abs=1e-12)
    assert record["counterfactual_exit_time"] == trade["closed_at_ms"] and record["reason"] == trade["exit_reason"]
    assert record["counterfactual_fees"] == pytest.approx(trade["fees"], rel=1e-12)
    assert record["status"] == "EXITED"


# ---- position state engine: worked examples --------------------------------------
def spec(direction="long", entry=100.0, stop=90.0, tp1=110.0, tp2=120.0, qty=2.0, opened=0):
    return TradeSpec("t", direction, entry, stop, tp1, tp2, qty, opened, lifecycle.fee(entry, qty))


def test_state_long_worked_example():
    s = spec()
    run = RunState(qty_left=2.0, best_price=108.0, worst_price=97.0, best_at_ms=2 * H, last_price=105.0, last_known_ms=5 * H,
                   closes=[100.0, 102.0, 104.0, 103.0, 105.0, 104.5, 105.0], ranges=[2.0, 3.0, 4.0])
    st = compute_state(s, run)
    assert st.unrealized_R == pytest.approx(0.5) and st.mfe_R == pytest.approx(0.8) and st.mae_R == pytest.approx(0.3)
    assert st.distance_from_peak_R == pytest.approx(0.3) and st.time_since_mfe_ms == 3 * H and st.elapsed_ms == 5 * H
    assert st.active_stop == 90.0 and st.stop_distance_R == pytest.approx(1.5)
    assert st.tp1_distance_R == pytest.approx(0.5) and st.tp2_distance_R == pytest.approx(1.5)
    assert st.volatility == pytest.approx(3.0) and st.volatility_R == pytest.approx(0.3)
    assert st.momentum_R == pytest.approx((105.0 - 103.0) / 10.0) and st.adverse_closes == 0 and st.remaining_frac == 1.0


def test_state_short_worked_example_and_post_tp1_breakeven():
    s = spec("short", entry=100.0, stop=110.0, tp1=90.0, tp2=80.0)
    run = RunState(qty_left=1.0, best_price=91.0, worst_price=102.0, best_at_ms=H, last_price=94.0, last_known_ms=3 * H, tp1_hit=True,
                   closes=[95.0, 94.0, 93.0, 94.0])
    st = compute_state(s, run)
    assert st.unrealized_R == pytest.approx(0.6) and st.mfe_R == pytest.approx(0.9) and st.mae_R == pytest.approx(0.2)
    assert st.active_stop == 100.0, "after TP1 the active stop is the breakeven price"
    assert st.remaining_frac == 0.5 and st.adverse_closes == 1   # 93 -> 94 closed against a short
    assert st.momentum_R == pytest.approx((95.0 - 94.0) / 10.0)


def test_effective_stop_only_tightens():
    s = spec()
    run = RunState(qty_left=2.0, best_price=100.0, worst_price=100.0, best_at_ms=0, last_price=100.0, last_known_ms=0)
    run.cf_stop = 85.0   # looser than the hard stop: ignored
    assert effective_stop(s, run) == 90.0
    run.cf_stop = 96.0
    assert effective_stop(s, run) == 96.0
    run.tp1_hit = True   # breakeven (100) is now tighter than 96
    assert effective_stop(s, run) == 100.0


# ---- policies ----------------------------------------------------------------------
def obs(i, o, h, l, c, seq=None, last=True):
    return Observation(seq=seq or i, kind="CANDLE", at_ms=i * M5, eval_ms=(i + 1) * M5, price=c, high=h, low=l, open=o, batch=i, last=last)


def run_policy(name, observations, s=None):
    s = s or spec(qty=1.0)
    return s, rp.replay(s, observations, pol.REGISTRY[name])


def test_registry_is_versioned_and_frozen():
    names = list(pol.REGISTRY)
    assert names[0] == "CURRENT_POLICY" and len(names) == len(set(names)) == 22   # 18 (V1) + 4 structural variants (Task O)
    for expected in ("BREAKEVEN_V1_R0.5", "BREAKEVEN_V1_R0.75", "BREAKEVEN_V1_R1.0", "MFE_TRAIL_25", "MFE_TRAIL_33", "MFE_TRAIL_50"):
        assert expected in pol.REGISTRY
    with pytest.raises(TypeError):
        pol.REGISTRY["MFE_TRAIL_25"].params["giveback"] = 0.9
    assert {p.study for p in pol.REGISTRY.values()} == {"3G-baseline", "3A", "3B", "3C", "3D", "3E", "3F", "3O"}


def test_breakeven_below_threshold_holds_and_at_threshold_moves_long():
    st = spec(qty=1.0)
    below = RunState(qty_left=1, best_price=104.9, worst_price=100, best_at_ms=0, last_price=104, last_known_ms=M5)
    at = RunState(qty_left=1, best_price=105.0, worst_price=100, best_at_ms=0, last_price=104, last_known_ms=M5)
    p = pol.REGISTRY["BREAKEVEN_V1_R0.5"]
    assert p.fn(compute_state(st, below), p.params).kind == HOLD
    a = p.fn(compute_state(st, at), p.params)
    assert a.kind == MOVE_TO_BREAKEVEN and a.stop == 100.0
    costs = pol.REGISTRY["BREAKEVEN_V1_R0.5_COSTS"]
    assert costs.fn(compute_state(st, at), costs.params).stop == pytest.approx(100.0 * (1 + pol.COST_FRACTION))


def test_breakeven_short_moves_stop_down_to_entry():
    st = spec("short", entry=100.0, stop=110.0, tp1=90.0, tp2=80.0, qty=1.0)
    run = RunState(qty_left=1, best_price=94.0, worst_price=100, best_at_ms=0, last_price=95, last_known_ms=M5)
    p = pol.REGISTRY["BREAKEVEN_V1_R0.5"]
    a = p.fn(compute_state(st, run), p.params)
    assert a.kind == MOVE_TO_BREAKEVEN and a.stop == 100.0 and a.stop < st.stop
    c = pol.REGISTRY["BREAKEVEN_V1_R0.5_COSTS"]
    assert c.fn(compute_state(st, run), c.params).stop == pytest.approx(100.0 * (1 - pol.COST_FRACTION))


def test_breakeven_replay_exits_early_where_current_rides_to_tp1():
    # +0.6R peak, dip back to entry, then the trade goes on to TP1: BREAKEVEN gives up the later gain.
    path = [obs(1, 100, 106, 100.5, 105), obs(2, 105, 105.5, 99.5, 101), obs(3, 101, 111, 100.8, 110.5), obs(4, 110.5, 121, 110, 120)]
    s, be = run_policy("BREAKEVEN_V1_R0.5", path)
    _, cur = run_policy("CURRENT_POLICY", path)
    assert be.events[0]["kind"] == rp.POLICY_STOP and be.status == "CLOSED" and be.events[0]["level"] == 100.0
    assert [e["kind"] for e in cur.events] == ["TP1", "TP2"]
    sb, sc = rp.summarize(s, be), rp.summarize(s, cur)
    assert sb["counterfactual_R"] < 0 < sc["counterfactual_R"] and sb["giveback_R"] > 0


def test_policy_stop_that_gaps_fills_at_the_open_not_the_better_level():
    # stop is set at entry after candle 1; candle 2 OPENS below it.
    path = [obs(1, 100, 106, 100.5, 105), obs(2, 98, 99, 96, 97)]
    s, run = run_policy("BREAKEVEN_V1_R0.5", path)
    assert run.events[0]["kind"] == rp.POLICY_STOP
    assert run.events[0]["fill_price"] == pytest.approx(lifecycle.slipped(98.0, "sell"))


def test_mfe_trail_locks_share_of_peak():
    st = spec(qty=1.0)
    run = RunState(qty_left=1, best_price=108.0, worst_price=100, best_at_ms=0, last_price=107, last_known_ms=M5)
    p = pol.REGISTRY["MFE_TRAIL_25"]
    a = p.fn(compute_state(st, run), p.params)
    assert a.kind == TRAIL_STOP and a.stop == pytest.approx(100 + 0.75 * 8)
    p50 = pol.REGISTRY["MFE_TRAIL_50"]
    assert p50.fn(compute_state(st, run), p50.params).stop == pytest.approx(104.0)


def test_vol_trail_needs_observed_volatility():
    st = spec(qty=1.0)
    run = RunState(qty_left=1, best_price=108.0, worst_price=100, best_at_ms=0, last_price=107, last_known_ms=M5, ranges=[2.0, 2.0])
    p = pol.REGISTRY["VOL_TRAIL_V1_K2"]
    assert p.fn(compute_state(st, run), p.params).kind == HOLD   # only 2 candles: no guessed volatility
    run.ranges = [2.0, 3.0, 4.0]
    assert p.fn(compute_state(st, run), p.params).stop == pytest.approx(108.0 - 2 * 3.0)


def test_post_tp1_protect_only_after_tp1():
    st = spec(qty=2.0)
    run = RunState(qty_left=1, best_price=112.0, worst_price=100, best_at_ms=0, last_price=111, last_known_ms=M5)
    p = pol.REGISTRY["POST_TP1_PROTECT_V1_L50"]
    assert p.fn(compute_state(st, run), p.params).kind == HOLD
    run.tp1_hit = True
    assert p.fn(compute_state(st, run), p.params).stop == pytest.approx(105.0)


def test_momentum_decay_exits_winner_after_adverse_closes():
    path = [obs(1, 100, 108, 100, 107), obs(2, 107, 107, 105, 106), obs(3, 106, 106, 104, 105), obs(4, 105, 105, 103, 104), obs(5, 104, 104, 103, 103.5)]
    s, run = run_policy("MOMENTUM_DECAY_V1_N3", path)
    assert run.status == "CLOSED" and run.exit_reason == rp.POLICY_EXIT and run.obs_count == 4   # exits once, on the 3rd adverse close
    assert rp.summarize(s, run)["counterfactual_R"] > 0
    # never exits a loser
    losing = [obs(1, 100, 105.5, 100, 105), obs(2, 105, 105, 97, 98), obs(3, 98, 98, 95, 96), obs(4, 96, 96, 94, 95)]
    _, r2 = run_policy("MOMENTUM_DECAY_V1_N2", losing)
    assert not any(e["kind"] == rp.POLICY_EXIT for e in r2.events)


def test_time_decay_tightens_then_exits_stalled_winner():
    st = spec(qty=1.0)
    p = pol.REGISTRY["TIME_DECAY_V1_H12"]
    run = RunState(qty_left=1, best_price=108.0, worst_price=100, best_at_ms=0, last_price=107, last_known_ms=13 * H)
    a = p.fn(compute_state(st, run), p.params)
    assert a.kind == "TIGHTEN_STOP" and a.stop == pytest.approx(104.0)
    run.last_known_ms, run.last_price = 25 * H, 103.0
    assert p.fn(compute_state(st, run), p.params).kind == FULL_EXIT
    run.last_known_ms = 5 * H
    assert p.fn(compute_state(st, run), p.params).kind == HOLD


def test_partial_exit_happens_at_most_once():
    custom = pol.Policy("TEST_PARTIAL", "test", lambda st, p: Action(PARTIAL_EXIT, fraction=0.3), {}, "test")
    s = spec(qty=1.0)
    run = rp.replay(s, [obs(1, 100, 101, 100, 101), obs(2, 101, 102, 100.5, 101.5), obs(3, 101.5, 102, 101, 101.8)], custom)
    partials = [e for e in run.events if e["kind"] == rp.POLICY_PARTIAL]
    assert len(partials) == 1 and partials[0]["quantity"] == pytest.approx(0.3) and run.qty_left == pytest.approx(0.7)


def test_stop_proposed_through_the_market_is_an_exit_now():
    custom = pol.Policy("TEST_THROUGH", "test", lambda st, p: Action(TRAIL_STOP, stop=st.price + 1.0), {}, "test")
    run = rp.replay(spec(qty=1.0), [obs(1, 100, 103, 100, 102)], custom)
    assert run.status == "CLOSED" and run.exit_reason == rp.POLICY_EXIT


# ---- replay engine properties --------------------------------------------------------
def random_path(seed, n=60):
    rng = random.Random(seed)
    price, out = 100.0, []
    for i in range(1, n + 1):
        o = price
        c = o * (1 + rng.uniform(-0.012, 0.014))
        h, l = max(o, c) * (1 + rng.uniform(0, 0.006)), min(o, c) * (1 - rng.uniform(0, 0.006))
        out.append(obs(i, o, h, l, c))
        price = c
    return out


@pytest.mark.parametrize("seed", range(12))
def test_no_policy_ever_loosens_the_hard_stop_or_grows_the_position(seed):
    s = spec(entry=100.0, stop=94.0, tp1=106.0, tp2=112.0, qty=1.0)
    path = random_path(seed)
    for policy in pol.REGISTRY.values():
        run = rp.new_run(s)
        for o in path:
            rp.step(s, run, o, policy)
            base = s.entry if run.tp1_hit else s.stop
            assert effective_stop(s, run) >= base - 1e-12   # long: never below the fixed lifecycle's own stop
            assert run.qty_left <= s.quantity + 1e-12
        if run.status == "OPEN":
            continue
        assert run.exit_reason in ("STOP", "BREAKEVEN_STOP", "TP1", "TP2", "TIMEOUT", rp.POLICY_STOP, rp.POLICY_EXIT, rp.POLICY_PARTIAL)


@pytest.mark.parametrize("seed", range(8))
def test_replay_is_deterministic_and_incremental_equals_full(seed):
    s = spec(entry=100.0, stop=94.0, tp1=106.0, tp2=112.0, qty=1.0)
    path = random_path(seed + 100)
    for policy in pol.REGISTRY.values():
        full = rp.replay(s, path, policy)
        again = rp.replay(s, path, policy)
        assert dataclasses.asdict(full) == dataclasses.asdict(again)
        for cut in (1, 7, len(path) // 2, len(path) - 1):
            first = rp.replay(s, path[:cut], policy)
            resumed = RunState(**json.loads(json.dumps(dataclasses.asdict(first))))   # survives persistence
            rp.replay(s, path[cut:], policy, resumed)
            assert dataclasses.asdict(resumed) == dataclasses.asdict(full), (policy.version, cut)
        replayed_twice = rp.replay(s, path + path, policy)   # observations already seen (same seq) are not re-applied
        assert rp.summarize(s, replayed_twice)["events"] == rp.summarize(s, full)["events"]


def test_short_direction_policies_run_and_stay_sane():
    s = spec("short", entry=100.0, stop=106.0, tp1=94.0, tp2=88.0, qty=1.0)
    path = [obs(i, 100 - i, 100 - i + 1.5, 100 - i - 1.5, 100 - i - 0.5) for i in range(1, 6)] + [obs(6, 95, 99, 94.5, 98.5), obs(7, 98.5, 103, 98, 102)]
    for policy in pol.REGISTRY.values():
        run = rp.replay(s, path, policy)
        summary = rp.summarize(s, run)
        assert summary["MFE"] > 0 and summary["counterfactual_fees"] >= s.entry_fee
        if run.status == "CLOSED":
            assert summary["counterfactual_exit_price"] is not None


# ---- through the REAL engine: CURRENT_POLICY reproduces the real exits -------------------------
def test_current_policy_reproduces_real_tp1_tp2_from_ticks(db):
    app, trade = open_real(db)
    for price in (104.0, 112.0, 108.0, 121.0):
        tick(app, price)
    assert_current_matches_real(app, "sig-1")
    assert [e["kind"] for e in app.state.ledger.trade("sig-1")["exits"]] == ["TP1", "TP2"]


def test_current_policy_reproduces_real_stop_gap_fill_from_ticks(db):
    app, _ = open_real(db)
    tick(app, 95.0)
    tick(app, 88.5)   # already through the stop: real fill is the observed price
    assert_current_matches_real(app, "sig-1")
    assert cf(app, "sig-1")["reason"] == "STOP"


def test_current_policy_reproduces_real_short_from_ticks(db):
    app, _ = open_real(db, direction="short", stop=110.0, tp1=90.0, tp2=80.0)
    for price in (96.0, 89.0, 92.0, 111.0):
        tick(app, price)
    assert_current_matches_real(app, "sig-1")


def test_current_policy_reproduces_real_candle_sweep_including_breakeven(db):
    app, trade = open_real(db)
    t0 = trade["opened_at_ms"]
    app.state.paper.mark("ETH-PERP", [candle(t0 + M5, 100, 111, 100.5, 108), candle(t0 + 2 * M5, 108, 109, 99.0, 100.2)], now_ms=t0 + 3 * M5)
    assert_current_matches_real(app, "sig-1")
    assert [e["kind"] for e in app.state.ledger.trade("sig-1")["exits"]] == ["TP1", "BREAKEVEN_STOP"]


def test_current_policy_reproduces_real_timeout_and_mixed_paths(db):
    app, trade = open_real(db)
    t0 = trade["opened_at_ms"]
    tick(app, 103.0)
    app.state.paper.mark("ETH-PERP", [candle(t0 + M5, 100, 104, 99.5, 103), candle(t0 + 2 * M5, 103, 105, 102, 104)], now_ms=t0 + 121 * H)
    assert app.state.ledger.trade("sig-1")["exit_reason"] == "TIMEOUT"
    assert_current_matches_real(app, "sig-1")


def test_a_3a_policy_replays_end_to_end_through_the_real_engine(db):
    app, trade = open_real(db)
    t0 = trade["opened_at_ms"]
    # +0.6R, back to entry, then TP1: the real trade banks TP1; BREAKEVEN stopped earlier at ~0.
    app.state.paper.mark("ETH-PERP", [candle(t0 + M5, 100, 106, 100.5, 105), candle(t0 + 2 * M5, 105, 105.5, 99.6, 101),
                                      candle(t0 + 3 * M5, 101, 111, 100.8, 110.5), candle(t0 + 4 * M5, 110.5, 121, 110, 120)], now_ms=t0 + 5 * M5)
    real = cf(app, "sig-1", "CURRENT_POLICY")
    be = cf(app, "sig-1", "BREAKEVEN_V1_R0.5")
    assert be["status"] == "EXITED" and be["reason"] == rp.POLICY_STOP and be["real_R"] == pytest.approx(real["real_R"])
    assert be["counterfactual_R"] < real["counterfactual_R"] and be["real_reached_tp1"] and be["real_reached_tp2"]
    assert set(be) >= {"counterfactual_exit_time", "counterfactual_exit_price", "counterfactual_R", "counterfactual_fees",
                       "counterfactual_slippage", "MFE", "MAE", "giveback_R", "reason", "policy_version"}
    assert len(app.state.paper.exit_shadow.store.load("sig-1")) == len(pol.REGISTRY)


# ---- safety invariants ---------------------------------------------------------------
def dump_real(app, db_path):
    with closing(sqlite3.connect(db_path)) as conn:
        return {t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall()
                for t in ("paper_trades", "paper_trade_events", "paper_equity", "paper_account", "paper_hindsight", "intents", "orders", "positions")
                if conn.execute("SELECT 1 FROM sqlite_master WHERE name=?", (t,)).fetchone()}


def test_replay_never_mutates_the_real_trade_byte_for_byte(db):
    app, _ = open_real(db)
    for price in (104.0, 112.0, 108.0, 121.0):
        tick(app, price)
    before, totals = dump_real(app, db), app.state.ledger.totals()
    trade = app.state.ledger.trade("sig-1")

    # a shadow whose connection is only allowed to write exit_* tables: any other write raises
    def guarded():
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        writes = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE}
        conn.set_authorizer(lambda action, a1, a2, a3, a4: sqlite3.SQLITE_DENY if action in writes and not str(a1).startswith("exit_") else sqlite3.SQLITE_OK)
        return conn

    class Ledger:
        _connect = staticmethod(guarded)

    shadow = ExitShadow(Ledger)
    shadow.record_tick(trade, 130.0, now_ms(), 131.0, 129.0, now_ms())
    shadow.record_candles(trade, [candle(now_ms(), 100, 140, 90, 120)], now_ms())
    shadow.update(trade)                       # already finalized rows are left alone
    fresh = ExitShadow(Ledger, {"CURRENT_POLICY": pol.REGISTRY["CURRENT_POLICY"], "MFE_TRAIL_25": pol.REGISTRY["MFE_TRAIL_25"]})
    fresh.store.append_observations("other", [])
    assert dump_real(app, db) == before and app.state.ledger.totals() == totals
    assert app.state.ledger.trade("sig-1") == trade


def test_finalized_counterfactuals_and_observations_are_immutable(db):
    app, _ = open_real(db)
    for price in (112.0, 121.0):
        tick(app, price)
    with closing(sqlite3.connect(db)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM exit_policy_counterfactuals WHERE finalized=1").fetchone()[0] == len(pol.REGISTRY)
        with pytest.raises(sqlite3.DatabaseError, match="EXIT_COUNTERFACTUAL_FINALIZED"):
            conn.execute("UPDATE exit_policy_counterfactuals SET status='X'")
        with pytest.raises(sqlite3.DatabaseError, match="EXIT_COUNTERFACTUAL_FINALIZED"):
            conn.execute("DELETE FROM exit_policy_counterfactuals")
        with pytest.raises(sqlite3.DatabaseError, match="EXIT_OBSERVATION_IMMUTABLE"):
            conn.execute("UPDATE exit_path_observations SET price=1")
        with pytest.raises(sqlite3.DatabaseError, match="EXIT_OBSERVATION_IMMUTABLE"):
            conn.execute("DELETE FROM exit_path_observations")


def test_open_trade_counterfactuals_update_incrementally_and_are_idempotent(db):
    app, _ = open_real(db)
    tick(app, 106.0)
    tick(app, 105.0)
    rows = app.state.paper.exit_shadow.store.load("sig-1")
    assert all(not r["finalized"] and r["record"]["status"] in ("OPEN", "EXITED") for r in rows.values())
    assert rows["CURRENT_POLICY"]["record"]["status"] == "OPEN" and rows["CURRENT_POLICY"]["record"]["observations"] == 2
    trade = app.state.ledger.trade("sig-1")
    before = app.state.paper.exit_shadow.store.load("sig-1")
    app.state.paper.exit_shadow.update(trade)   # no new observations: nothing changes, nothing duplicates
    after = app.state.paper.exit_shadow.store.load("sig-1")
    assert {k: v["record"] for k, v in before.items()} == {k: v["record"] for k, v in after.items()}
    tick(app, 121.0)   # TP1 and TP2 in one observation: closes the trade
    tick(app, 112.0)   # a closed trade has no open position: nothing is observed
    assert_current_matches_real(app, "sig-1")
    assert app.state.paper.exit_shadow.store.observation_count("sig-1") == 3


def test_a_research_failure_never_affects_a_real_exit(db):
    app, _ = open_real(db)

    def boom(*a, **k):
        raise RuntimeError("research store on fire")

    app.state.paper.exit_shadow.store.append_observations = boom
    app.state.paper.exit_shadow.store.save = boom
    tick(app, 112.0)
    tick(app, 121.0)
    real = app.state.ledger.trade("sig-1")
    assert real["status"] == "CLOSED" and [e["kind"] for e in real["exits"]] == ["TP1", "TP2"]


def test_exit_shadow_can_be_switched_off(db, monkeypatch):
    monkeypatch.setenv("MARKET_EDGE_EXIT_SHADOW", "0")
    app, _ = open_real(db)
    tick(app, 112.0)
    assert app.state.paper.exit_shadow is None and app.state.ledger.trade("sig-1")["tp1_hit"] is True
    with closing(sqlite3.connect(db)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM exit_path_observations").fetchone()[0] == 0


def test_stale_or_invalid_prices_are_not_recorded_as_observations(db):
    app, _ = open_real(db)
    tick(app, 105.0, at=now_ms() - 3_600_000)   # stale: the engine skips it, so the replay must too
    tick(app, float("nan"))
    tick(app, 105.0)
    assert app.state.paper.exit_shadow.store.observation_count("sig-1") == 1


# ---- read-only API ---------------------------------------------------------------------
def test_exit_policy_api_is_read_only_and_labelled(db):
    app, _ = open_real(db)
    for price in (112.0, 121.0):
        tick(app, price)
    client = TestClient(app)
    reg = client.get("/research/exit-policies", headers=HEADERS).json()
    assert reg["authoritative"] is False and len(reg["policies"]) == len(pol.REGISTRY) and reg["records"]["counterfactuals"] == len(pol.REGISTRY)
    one = client.get("/research/exit-policies/trade", params={"trade_id": "sig-1"}, headers=HEADERS).json()
    assert "NOT AN ACTUAL FILL" in one["label"] and one["counterfactuals"]["CURRENT_POLICY"]["finalized"] is True
    ev = client.get("/research/exit-policies/evaluation", headers=HEADERS).json()
    assert ev["promotion"].startswith("NONE") and all(p["verdict"] == "INSUFFICIENT_EVIDENCE" for p in ev["policies"].values())
    assert client.get("/research/exit-policies", headers={}).status_code == 401
    assert client.post("/research/exit-policies", headers=HEADERS).status_code == 405
