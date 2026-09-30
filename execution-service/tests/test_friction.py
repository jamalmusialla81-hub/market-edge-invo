"""TASK G: friction measurement records expected vs actual, flags default_used, and changes no fill, fee or size."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.paper import friction, lifecycle
from market_edge_exec.risk import sizing_v2 as S
from tests.test_risk_sizing_v2_paper import HEADERS, post, risk_inputs, now_ms

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
POLICY = S.DEFAULT_POLICY
EXP = lifecycle.FEE_PCT + lifecycle.SLIPPAGE_PCT


def depth(now, mid=100.0, half=0.01, size=50.0, levels=5, step=0.05):
    return S.DepthInput("HYPERLIQUID", [[mid - half - i * step, size] for i in range(levels)],
                        [[mid + half + i * step, size] for i in range(levels)], now - 500)


# ---- pure computations -------------------------------------------------------
def test_entry_measured_friction_matches_a_hand_computed_book_walk():
    now = now_ms()
    d = S.DepthInput("HYPERLIQUID", [[99.9, 10], [99.8, 10]], [[100.1, 1.0], [100.3, 10]], now - 500)
    # long, notional 200.2: takes 1.0 @100.1 then ~0.9990 @100.3
    qty, mark = 2.0, 100.0
    rec = friction.entry_friction("long", mark, 100.03, qty, now, now - 2_000, now - 5_000, d, POLICY)
    mid = 100.0
    need = 100.03 * qty / mid
    vwap = (100.1 * 1.0 + 100.3 * (need - 1.0)) / need
    assert rec["slippage_provenance"] == "measured" and rec["default_reason"] is None
    assert rec["fill_vwap"] == pytest.approx(vwap)
    assert rec["actual"]["slippage_pct"] == pytest.approx((vwap - mid) / mid)
    assert rec["actual"]["total_pct"] == pytest.approx(lifecycle.FEE_PCT + (vwap - mid) / mid)
    assert rec["difference_pct"] == pytest.approx(rec["actual"]["total_pct"] - EXP)
    assert rec["spread_bps"] == pytest.approx(0.2 / 100.0 * 10_000)
    assert rec["expected"]["total_pct"] == pytest.approx(EXP) and rec["expected"]["source"] == "LIFECYCLE_FIXED_MODEL"
    assert rec["fee"]["provenance"] == "default_used"            # the fee tier is never presented as measured
    assert rec["latency"]["mark_age_ms"] == 2_000 and rec["latency"]["signal_to_entry_ms"] == 5_000 and rec["latency"]["submit_to_fill_ms"] is None
    assert rec["market_impact_bps"] == pytest.approx((vwap - 100.1) / mid * 10_000)


def _depth_case(kind, now):
    return {"missing": None,
            "stale": S.DepthInput("HYPERLIQUID", [[99.9, 10]], [[100.1, 10]], 1),
            "venue": S.DepthInput("BINANCE", [[99.9, 10]], [[100.1, 10]], now),
            "crossed": S.DepthInput("HYPERLIQUID", [[99.9, 10]], [[99.0, 10]], now),
            "garbage": S.DepthInput("HYPERLIQUID", [[99.9, "x"]], [[100.1, 10]], now)}[kind]


@pytest.mark.parametrize("kind,why", [("missing", "missing"), ("stale", "stale depth"), ("venue", "wrong venue"),
                                      ("crossed", "invalid depth"), ("garbage", "invalid depth")])
def test_entry_without_validated_depth_is_default_used_never_flattering(kind, why):
    now = now_ms()
    rec = friction.entry_friction("long", 100.0, 100.03, 1.0, now, now, now, _depth_case(kind, now), POLICY)
    assert rec["slippage_provenance"] == "default_used" and why in rec["default_reason"]
    assert rec["difference_pct"] is None and rec["fill_vwap"] is None and rec["spread_bps"] is None
    assert rec["actual"]["slippage_provenance"] == "default_used"
    assert rec["actual"]["total_pct"] >= rec["expected"]["total_pct"]   # the default is never below the assumption


def test_order_larger_than_the_book_is_default_used():
    now = now_ms()
    d = S.DepthInput("HYPERLIQUID", [[99.9, 1]], [[100.1, 0.5]], now - 500)
    rec = friction.entry_friction("long", 100.0, 100.03, 5.0, now, now, now, d, POLICY)
    assert rec["slippage_provenance"] == "default_used" and "larger than the visible book" in rec["default_reason"]


def test_short_entry_walks_the_bids():
    now = now_ms()
    d = S.DepthInput("HYPERLIQUID", [[99.9, 10]], [[100.1, 10]], now - 500)
    rec = friction.entry_friction("short", 100.0, 99.97, 1.0, now, now, now, d, POLICY)
    assert rec["fill_vwap"] == pytest.approx(99.9) and rec["actual"]["slippage_pct"] == pytest.approx(0.001)


def test_exit_stop_overshoot_is_measured_from_the_observed_price():
    level, observed = 95.0, 94.0
    fill = lifecycle.slipped(observed, "sell")
    rec = friction.exit_friction("long", "STOP", level, fill, "WS_TRADE", observed, observation_lag_ms=800, since_previous_observation_ms=4_000)
    assert rec["slippage_provenance"] == "measured"
    assert rec["stop_overshoot_pct"] == pytest.approx((95 - 94) / 95)
    assert rec["actual"]["slippage_pct"] == pytest.approx((95 - fill) / 95)
    assert rec["difference_pct"] == pytest.approx(rec["actual"]["total_pct"] - EXP) and rec["difference_pct"] > 0
    assert rec["monitor"] == {"observation_lag_ms": 800, "since_previous_observation_ms": 4_000}


def test_exit_target_fill_at_level_has_no_overshoot_and_short_direction_is_mirrored():
    fill = lifecycle.slipped(110.0, "sell")
    rec = friction.exit_friction("long", "TP1", 110.0, fill, "POLL_HEARTBEAT", 111.0)
    assert rec["stop_overshoot_pct"] == 0.0 and rec["difference_pct"] == pytest.approx(0.0, abs=1e-12)
    short = friction.exit_friction("short", "STOP", 105.0, lifecycle.slipped(106.0, "buy"), "WS_TRADE", 106.0)
    assert short["stop_overshoot_pct"] == pytest.approx(1 / 105) and short["difference_pct"] > 0


def test_candle_path_exit_has_no_observed_price_so_it_is_default_used():
    rec = friction.exit_friction("long", "STOP", 95.0, lifecycle.slipped(95.0, "sell"), "CANDLE_5M")
    assert rec["slippage_provenance"] == "default_used" and rec["difference_pct"] is None and rec["stop_overshoot_pct"] is None
    assert "candle-path" in rec["default_reason"]


def test_summary_sums_measured_legs_only_and_lists_the_rest():
    entry = {"expected": friction.expected_per_side(), "actual": {"total_pct": 0.002}, "slippage_provenance": "measured", "difference_pct": 0.002 - EXP}
    exit_default = {"expected": friction.expected_per_side(), "actual": {"total_pct": EXP}, "slippage_provenance": "default_used", "difference_pct": None}
    trade = {"entry_fill": 100.0, "quantity": 2.0, "friction_entry": entry,
             "exits": [{"kind": "STOP", "fill_price": 95.0, "quantity": 2.0, "friction": exit_default}]}
    s = friction.summarize(trade)
    assert s["legs"] == 2 and s["measured_legs"] == ["ENTRY"] and s["default_used_legs"] == ["STOP"]
    assert s["expected_friction"] == pytest.approx(EXP * 200 + EXP * 190)
    assert s["actual_friction"] == pytest.approx(0.002 * 200 + EXP * 190)
    assert s["difference"] == pytest.approx((0.002 - EXP) * 200)


# ---- through the real paper engine ---------------------------------------------
@pytest.fixture
def app_client(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), sizing_mode="SHADOW")
    return app, TestClient(app)


def test_engine_records_measured_entry_friction_without_changing_the_fill(app_client):
    app, client = app_client
    r = post(client, "f1", stop_pct=0.10)
    assert r["accepted"], r
    t = r["trade"]
    assert t["entry_fill"] == pytest.approx(lifecycle.slipped(100.0, "buy"))       # the fixed simulation is unchanged
    assert t["fees"] == pytest.approx(lifecycle.fee(t["entry_fill"], t["quantity"]))
    f = t["friction_entry"]
    assert f["slippage_provenance"] == "measured" and f["expected"]["total_pct"] == pytest.approx(EXP)
    assert f["actual"]["total_pct"] >= lifecycle.FEE_PCT and f["difference_pct"] == pytest.approx(f["actual"]["total_pct"] - EXP)
    assert f["proposed_notional"] == pytest.approx(t["quantity"] * 100.0)


def test_engine_flags_default_used_when_live_depth_is_unavailable(app_client):
    app, client = app_client
    r = post(client, "f2", stop_pct=0.10, inputs=None)
    assert r["accepted"], r
    f = r["trade"]["friction_entry"]
    assert f["slippage_provenance"] == "default_used" and "missing" in f["default_reason"] and f["difference_pct"] is None
    assert r["trade"]["entry_fill"] == pytest.approx(lifecycle.slipped(100.0, "buy"))


def test_engine_records_exit_friction_and_trade_summary_and_persists_them(app_client):
    app, client = app_client
    r = post(client, "f3", stop_pct=0.10)
    t0 = r["trade"]
    stop = t0["stop"]
    observed = stop - 0.5
    res = app.state.paper.tick("SOL-PERP", observed, now_ms(), "TEST", trigger="WS_TRADE")
    assert res.exits and res.exits[0]["kind"] == "STOP"
    trade = app.state.ledger.trade("f3")
    ex = trade["exits"][0]
    assert ex["fill_price"] == pytest.approx(lifecycle.slipped(observed, "sell"))    # exit fill unchanged
    f = ex["friction"]
    assert f["slippage_provenance"] == "measured" and f["trigger"] == "WS_TRADE" and f["stop_overshoot_pct"] == pytest.approx(0.5 / stop)
    assert f["monitor"]["observation_lag_ms"] >= 0
    s = trade["friction"]
    assert s["legs"] == 2 and set(s["measured_legs"]) == {"ENTRY", "STOP"}
    assert s["difference"] == pytest.approx(f["difference_pct"] * ex["fill_price"] * ex["quantity"] + trade["friction_entry"]["difference_pct"] * trade["entry_fill"] * trade["quantity"])
    assert trade["status"] == "CLOSED"


def test_engine_candle_exit_is_default_used(app_client):
    app, client = app_client
    r = post(client, "f4", stop_pct=0.10)
    t0 = r["trade"]
    candle = {"time": t0["opened_at_ms"] + 300_000, "open": 100, "high": 100, "low": t0["stop"] - 1, "close": t0["stop"] - 1}
    res = app.state.paper.mark("SOL-PERP", [candle], now_ms())
    assert res.exits
    f = app.state.ledger.trade("f4")["exits"][0]["friction"]
    assert f["slippage_provenance"] == "default_used" and f["trigger"] == "CANDLE_5M" and f["difference_pct"] is None
