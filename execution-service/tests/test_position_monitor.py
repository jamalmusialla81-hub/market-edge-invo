"""Open-position monitor (fast loop) through the real router/portfolio/ledger:
live price updates, MFE/MAE, exactly-once TP1/TP2/stop, restart safety, fail
closed on stale/missing data, and the Trade Detail view (decision-time record,
chart levels/markers, candles, hindsight overlay kept separate)."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.paper.candles import chart_window
from market_edge_exec.risk.engine import RiskLimits

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
WIDE_LIMITS = RiskLimits(max_initial_position_notional_pct=100.0, max_portfolio_exposure_pct=100.0)
LIVE = "HYPERLIQUID_ALLMIDS_LIVE"


def now_ms():
    return int(time.time() * 1000)


def make_signal(sid="sig-1", asset="ETH", direction="long", entry=100.0, stop=90.0, tp1=110.0, tp2=120.0, ts=None):
    return {"signal_id": sid, "asset": asset, "direction": direction, "timestamp": ts or now_ms(), "entry": entry, "stop": stop,
            "targets": [tp1, tp2], "strategy_id": "TREND CONTINUATION", "quant_score": 72}


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "monitor.sqlite3")


def opened(db, candle_fetcher=None, **kw):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS, candle_fetcher=candle_fetcher)
    t = now_ms() - 60_000
    mark = 100.0
    result = app.state.paper.open_from_signal(make_signal(ts=t, **kw), f"{kw.get('asset', 'ETH')}-PERP", mark, t, now_ms=t,
                                              meta={"rank": 1, "scan_id": "scan-xyz", "quant_score": 71, "ml_score": 0.6, "rr1": 1.0,
                                                    "rr2": 2.0, "model_version": "m-7", "feature_version": "f-3"},
                                              market_price_source=LIVE)
    assert result.accepted, result.reason
    return app, result.trade


def tick(app, price, at=None, instrument="ETH-PERP", trigger="POLL_HEARTBEAT", **kw):
    return app.state.paper.tick(instrument, price, at if at is not None else now_ms(), LIVE, trigger=trigger, **kw)


def exit_intents(app, sid="sig-1"):
    return [o for o in app.state.store.orders() if str(o.get("signal_id", "")).startswith(f"{sid}:")]


# ---- live price, MFE/MAE ---------------------------------------------------
def test_tick_updates_current_price_source_timestamp_and_age(db):
    app, _ = opened(db)
    at = now_ms() - 2_000
    result = tick(app, 104.0, at)
    assert result.skipped is None and result.monitor_status == "LIVE" and result.exits == []
    trade = app.state.ledger.trade("sig-1")
    assert trade["last_price"] == 104.0 and trade["last_price_at_ms"] == at and trade["last_price_source"] == LIVE
    pos = TestClient(app).get("/paper/positions", headers=HEADERS).json()["positions"][0]
    assert pos["current_price"] == 104.0 and pos["monitor_status"] == "LIVE"
    assert 1.5 <= pos["price_age_s"] < 30
    assert pos["unrealized_pnl"] == pytest.approx((104.0 - trade["entry_fill"]) * trade["quantity"])
    assert pos["unrealized_r"] == pytest.approx(pos["unrealized_pnl"] / trade["risk_amount"])
    assert pos["distance_to_stop"]["price"] == pytest.approx(104.0 - 90.0)
    assert pos["distance_to_tp1"]["price"] == pytest.approx(110.0 - 104.0)
    assert pos["distance_to_tp2"]["price"] == pytest.approx(120.0 - 104.0)
    assert pos["position_age_s"] >= 59


def test_mfe_mae_track_extremes_long(db):
    app, trade = opened(db)
    entry = trade["entry_fill"]
    tick(app, 106.0)
    tick(app, 95.0)
    tick(app, 101.0, observed_high=107.5, observed_low=94.0)  # real prints between polls
    t = app.state.ledger.trade("sig-1")
    assert t["best_price"] == 107.5 and t["worst_price"] == 94.0
    live = TestClient(app).get("/paper/trade", params={"trade_id": "sig-1"}, headers=HEADERS).json()["live"]
    assert live["mfe"]["price"] == pytest.approx(107.5 - entry)
    assert live["mae"]["price"] == pytest.approx(94.0 - entry)
    assert live["mfe"]["r"] == pytest.approx((107.5 - entry) / abs(entry - 90.0))
    assert live["mae"]["r"] < 0


def test_mfe_mae_track_extremes_short(db):
    app, trade = opened(db, direction="short", stop=110.0, tp1=90.0, tp2=80.0)
    tick(app, 96.0)
    tick(app, 104.0)
    t = app.state.ledger.trade("sig-1")
    assert t["best_price"] == 96.0 and t["worst_price"] == 104.0


def test_observed_extremes_never_trigger_only_price_does(db):
    # An observed low through the stop widens MAE, but does not fire the
    # stop by itself: trigger evaluation judges only the posted price.
    app, _ = opened(db)
    result = tick(app, 101.0, observed_low=89.0)
    assert result.exits == []
    assert app.state.ledger.trade("sig-1")["worst_price"] == 89.0


# ---- exactly-once milestones ----------------------------------------------
def test_tp1_fires_exactly_once_and_persists_milestones(db):
    app, trade = opened(db)
    first = tick(app, 110.5, trigger="WS_TRADE")
    assert [e["kind"] for e in first.exits] == ["TP1"]
    assert first.exits[0]["trigger"] == "WS_TRADE"
    again = tick(app, 111.0)
    assert again.exits == []
    t = app.state.ledger.trade("sig-1")
    assert t["tp1_hit"] and t["status"] == "PARTIAL" and t["stop_status"] == "BREAKEVEN"
    assert t["tp1_fill_price"] == pytest.approx(110.0 * (1 - 0.0003)) and t["tp1_fill_at_ms"]
    assert t["remaining_qty"] == pytest.approx(trade["quantity"] / 2)
    assert [o["signal_id"] for o in exit_intents(app)] == ["sig-1:TP1"]


def test_tp2_fires_exactly_once(db):
    app, _ = opened(db)
    result = tick(app, 121.0)
    assert [e["kind"] for e in result.exits] == ["TP1", "TP2"]
    assert tick(app, 125.0).skipped == "NO_OPEN_TRADE"
    t = app.state.ledger.trade("sig-1")
    assert t["status"] == "CLOSED" and t["tp2_status"] == "HIT" and t["exit_reason"] == "TP2"
    assert sorted(o["signal_id"] for o in exit_intents(app)) == ["sig-1:TP1", "sig-1:TP2"]


def test_stop_fires_exactly_once_and_gapped_stop_fills_at_observed_price(db):
    app, _ = opened(db)
    result = tick(app, 88.0)  # through the 90 stop
    assert [e["kind"] for e in result.exits] == ["STOP"]
    assert result.exits[0]["fill_price"] == pytest.approx(88.0 * (1 - 0.0003))  # never the better 90
    assert tick(app, 87.0).exits == []
    t = app.state.ledger.trade("sig-1")
    assert t["status"] == "CLOSED" and t["stop_status"] == "HIT"
    assert [o["signal_id"] for o in exit_intents(app)] == ["sig-1:STOP"]


def test_breakeven_stop_after_tp1(db):
    app, trade = opened(db)
    tick(app, 110.0)
    result = tick(app, trade["entry_fill"] - 0.5)
    assert [e["kind"] for e in result.exits] == ["BREAKEVEN_STOP"]


def test_candle_sweep_after_tick_does_not_repeat_tp1(db):
    app, trade = opened(db)
    at = now_ms()
    tick(app, 110.2, at)
    t0 = trade["opened_at_ms"]
    marked = app.state.paper.mark("ETH-PERP", [{"time": t0 + 1, "open": 105, "high": 111, "low": 104, "close": 108}])
    assert "TP1" not in [e["kind"] for e in marked.exits]
    assert [o["signal_id"] for o in exit_intents(app)] == ["sig-1:TP1"]


def test_late_print_older_than_last_exit_cannot_fire(db):
    app, _ = opened(db)
    at = now_ms()
    tick(app, 110.0, at)  # TP1
    stale_order = tick(app, 80.0, at - 5_000)  # an older print arriving late
    assert stale_order.exits == []
    assert app.state.ledger.trade("sig-1")["status"] == "PARTIAL"


def test_timeout_fires_from_live_price(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    t = now_ms() - 121 * 3_600_000
    assert app.state.paper.open_from_signal(make_signal(ts=t), "ETH-PERP", 100.0, t, now_ms=t).accepted
    result = tick(app, 101.0)
    assert [e["kind"] for e in result.exits] == ["TIMEOUT"]


# ---- restart ---------------------------------------------------------------
def test_restart_does_not_duplicate_fills_or_reset_excursions(db):
    app, trade = opened(db)
    tick(app, 110.3)          # TP1
    tick(app, 112.0)          # new high
    before = app.state.ledger.trade("sig-1")
    restarted = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    again = tick(restarted, 110.3)
    assert again.exits == []
    after = restarted.state.ledger.trade("sig-1")
    assert after["best_price"] == 112.0 and after["worst_price"] == before["worst_price"]
    assert after["tp1_hit"] and after["tp1_fill_at_ms"] == before["tp1_fill_at_ms"]
    assert after["remaining_qty"] == pytest.approx(trade["quantity"] / 2)
    assert [o["signal_id"] for o in exit_intents(restarted)] == ["sig-1:TP1"]
    # and the second milestone still fires exactly once after the restart
    assert [e["kind"] for e in tick(restarted, 120.5).exits] == ["TP2"]
    assert TestClient(restarted).post("/reconcile", headers=HEADERS).json()["reconciled"] is True


# ---- fail closed -----------------------------------------------------------
def test_stale_price_fails_closed(db):
    app, _ = opened(db)
    old = now_ms() - 45_000  # older than the 30s monitor limit
    result = tick(app, 80.0, old)  # would be a stop if it were believed
    assert result.skipped == "STALE_MARKET_DATA" and result.exits == []
    t = app.state.ledger.trade("sig-1")
    assert t["status"] == "OPEN" and t["last_price"] is None and t["monitor_status"] == "STALE"
    assert t["worst_price"] == t["entry_fill"]  # a stale price does not touch MAE either


def test_missing_or_invalid_price_fails_closed(db):
    app, _ = opened(db)
    for bad in (None, 0, -1.0, float("nan"), "101"):
        assert tick(app, bad).skipped == "INVALID_PRICE"
    assert app.state.paper.tick("ETH-PERP", 101.0, None, LIVE).skipped == "INVALID_PRICE"
    assert app.state.ledger.trade("sig-1")["last_price"] is None


def test_pre_entry_price_is_not_used(db):
    app, trade = opened(db)
    result = tick(app, 80.0, trade["opened_at_ms"] - 1, now_ms=trade["opened_at_ms"] + 1_000)
    assert result.skipped == "PRE_ENTRY_PRICE" and result.exits == []


def test_offline_heartbeat_flags_position_and_preserves_it(db):
    app, _ = opened(db)
    client = TestClient(app)
    tick(app, 103.0)
    r = client.post("/paper/monitor/heartbeat", headers=HEADERS, json={
        "state": "ACTIVE", "market_ok": False, "error": "allMids: HTTP 503", "offline_instruments": ["ETH-PERP"]}).json()
    assert r["flagged_offline"] == 1
    pos = client.get("/paper/positions", headers=HEADERS).json()["positions"][0]
    assert pos["monitor_status"] == "MARKET_DATA_OFFLINE" and "503" in pos["monitor_detail"]
    assert pos["current_price"] == 103.0  # last REAL price, with its age -- not an invented one
    status = client.get("/system/status", headers=HEADERS).json()["position_monitor"]
    assert status["stale_positions"] == 1 and status["market_ok"] is False
    # a fresh price clears it
    tick(app, 104.0)
    assert client.get("/paper/positions", headers=HEADERS).json()["positions"][0]["monitor_status"] == "LIVE"


def test_no_contaminated_fallback_old_live_price_reads_stale_not_live(db):
    app, _ = opened(db)
    tick(app, 103.0, now_ms() - 20_000)
    later = now_ms() + 60_000  # the monitor went quiet
    from market_edge_exec.paper.trade_detail import live_metrics
    live = live_metrics(app.state.ledger.trade("sig-1"), later, app.state.paper.monitor_max_price_age_s())
    assert live["monitor"]["status"] == "STALE"
    assert live["monitor"]["price_source"] == LIVE and live["monitor"]["price_age_s"] > 30


def test_tick_never_opens_a_trade(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    client = TestClient(app)
    r = client.post("/paper/tick", headers=HEADERS, json={"instrument": "BTC-PERP", "price": 60000.0, "at_ms": now_ms(), "source": LIVE}).json()
    assert r["skipped"] == "NO_OPEN_TRADE"
    assert app.state.ledger.trades() == [] and app.state.store.orders() == []


def test_open_endpoint_exposes_geometry_for_crossing_detection(db):
    app, _ = opened(db)
    row = TestClient(app).get("/paper/open", headers=HEADERS).json()["trades"][0]
    for key in ("direction", "entry_fill", "stop", "tp1", "tp2", "tp1_hit", "coin"):
        assert key in row


# ---- trade detail ----------------------------------------------------------
def test_trade_detail_decision_context_levels_and_entry_marker(db):
    app, trade = opened(db)
    d = TestClient(app).get("/paper/trade", params={"trade_id": "sig-1"}, headers=HEADERS).json()
    dec = d["decision"]
    assert dec["original_stop"] == 90.0 and dec["original_tp1"] == 110.0 and dec["original_tp2"] == 120.0
    assert dec["original_rr1"] == 1.0 and dec["scan_id"] == "scan-xyz" and dec["model_version"] == "m-7"
    assert dec["feature_version"] == "f-3" and dec["market_price_source"] == LIVE and dec["quant_score"] == 71
    assert {lv["kind"] for lv in d["levels"]} == {"ENTRY", "STOP", "TP1", "TP2"}
    assert all("LONG" in lv["label"] for lv in d["levels"])
    assert d["markers"] == [{"kind": "ENTRY", "at_ms": trade["opened_at_ms"], "price": trade["entry_fill"], "side": "BUY",
                             "label": "LONG ENTRY (BUY)", "quantity": trade["quantity"]}]
    assert TestClient(app).get("/paper/trade", params={"trade_id": "nope"}, headers=HEADERS).status_code == 404


def test_closed_trade_shows_actual_exit_markers_short(db):
    app, _ = opened(db, direction="short", stop=110.0, tp1=90.0, tp2=80.0)
    tick(app, 89.5)
    tick(app, 79.0)
    d = TestClient(app).get("/paper/trade", params={"trade_id": "sig-1"}, headers=HEADERS).json()
    assert [m["kind"] for m in d["markers"]] == ["ENTRY", "TP1", "TP2"]
    assert d["markers"][0]["label"] == "SHORT ENTRY (SELL)" and d["markers"][1]["side"] == "BUY"
    assert d["status"] == "CLOSED" and d["live"]["milestones"]["tp2_status"] == "HIT"


def test_hindsight_unavailable_before_resolution_and_separate_after(db):
    app, _ = opened(db)
    client = TestClient(app)
    d = client.get("/paper/trade", params={"trade_id": "sig-1"}, headers=HEADERS).json()
    assert d["hindsight"]["available"] is False and d["hindsight"]["reason"] == "OUTCOME_NOT_RESOLVED"
    labels = {"optimal_entry": 97.0, "optimal_tp1": 113.0, "optimal_tp2": 125.0, "optimal_exit": 124.0}
    assert client.post("/paper/hindsight", headers=HEADERS, json={"trade_id": "sig-1", "labels": labels}).status_code == 409
    tick(app, 88.0)  # resolves (stop)
    closed = client.get("/paper/trade", params={"trade_id": "sig-1"}, headers=HEADERS).json()
    assert closed["hindsight"]["available"] is False and closed["hindsight"]["reason"] == "NO_RESOLVED_RESEARCH_LABEL"
    before = app.state.ledger.trade("sig-1")
    r = client.post("/paper/hindsight", headers=HEADERS, json={"trade_id": "sig-1", "labels": labels, "source": "USL-shadow"})
    assert r.status_code == 200
    after = client.get("/paper/trade", params={"trade_id": "sig-1"}, headers=HEADERS).json()
    h = after["hindsight"]
    assert h["available"] and h["post_outcome"] is True and h["known_at_decision_time"] is False
    assert "HINDSIGHT" in h["label"] and h["levels"]["optimal_tp1"] == 113.0
    # decision-time record is untouched and carries no hindsight field
    assert after["decision"] == closed["decision"]
    assert not any(k.startswith("optimal") for k in after["decision"])
    assert app.state.ledger.trade("sig-1") == before


# ---- candles -----------------------------------------------------------------
def test_candles_window_and_no_fabrication(db):
    calls = []

    def fetcher(coin, interval, start, end):
        calls.append((coin, interval, start, end))
        step = 300_000
        first = (start // step + 1) * step
        # a real gap in the source stays a gap
        return [{"t": t, "o": "100", "h": "101", "l": "99", "c": "100.5", "v": "3"} for t in range(first, end, step) if (t // step) % 7 != 3]

    app, trade = opened(db, candle_fetcher=fetcher)
    client = TestClient(app)
    r = client.get("/paper/trade/candles", params={"trade_id": "sig-1", "interval": "5m"}, headers=HEADERS).json()
    assert r["available"] and r["source"] == "HYPERLIQUID_CANDLESNAPSHOT"
    coin, interval, start, end = calls[0]
    assert coin == "ETH" and interval == "5m" and start == trade["opened_at_ms"] - 4 * 3_600_000
    times = [c["time"] for c in r["candles"]]
    assert all(b - a in (300_000, 600_000) for a, b in zip(times, times[1:]))  # gaps not filled
    assert any(b - a == 600_000 for a, b in zip(times, times[1:]))
    assert client.get("/paper/trade/candles", params={"trade_id": "sig-1", "interval": "3m"}, headers=HEADERS).json()["available"] is False


def test_candles_source_failure_is_reported_not_substituted(db):
    def broken(*_):
        raise RuntimeError("HTTP 503")

    app, _ = opened(db, candle_fetcher=broken)
    r = TestClient(app).get("/paper/trade/candles", params={"trade_id": "sig-1"}, headers=HEADERS).json()
    assert r["available"] is False and "503" in r["reason"] and r["candles"] == []


def test_chart_window_closed_trade_has_post_exit_context_and_limits_range():
    h = 3_600_000
    w = chart_window("5m", 10 * h, 14 * h, 100 * h)
    assert w["ok"] and w["start_ms"] == 6 * h and w["end_ms"] == 16 * h
    too_long = chart_window("1m", 0, None, 5001 * 60_000)
    assert not too_long["ok"] and too_long["reason"] == "RANGE_TOO_LARGE_FOR_INTERVAL"


def test_just_opened_position_awaiting_price_is_not_reported_stale_yet(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    t = now_ms()
    assert app.state.paper.open_from_signal(make_signal(ts=t), "ETH-PERP", 100.0, t, now_ms=t).accepted
    status = TestClient(app).get("/paper/monitor", headers=HEADERS).json()
    assert status["position_statuses"] == ["AWAITING_PRICE"] and status["stale_positions"] == 0
