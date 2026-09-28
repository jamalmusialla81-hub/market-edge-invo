"""Persistent forward-paper session: full lifecycle through the real
router/portfolio/ledger, plus failure hardening (all must fail closed)."""
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.risk.engine import RiskLimits

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
H = 3_600_000
# Lifecycle tests below exercise entries/exits/restarts/reconciliation, not
# sizing -- they use a wide RiskLimits so the 5%-per-position / 20%-aggregate
# exposure policy (tested directly in test_risk_aggregate_and_leverage.py and
# test_exposure_cap_counts_open_trades_across_instruments below) doesn't
# shrink their $100-max_loss trades and change unrelated assertions.
WIDE_LIMITS = RiskLimits(max_initial_position_notional_pct=100.0, max_portfolio_exposure_pct=100.0)


def make_signal(sid="sig-1", asset="ETH", direction="long", entry=100.0, stop=90.0, tp1=110.0, tp2=120.0, ts=None, strategy="TREND CONTINUATION"):
    return {"signal_id": sid, "asset": asset, "direction": direction, "timestamp": ts or int(time.time() * 1000),
            "entry": entry, "stop": stop, "targets": [tp1, tp2], "strategy_id": strategy, "quant_score": 72}


def candle(t, high, low, close=None):
    return {"time": t, "open": low, "high": high, "low": low, "close": close if close is not None else (high + low) / 2}


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "paper.sqlite3")


def open_trade(app, sid="sig-1", mark=100.0, leverage=1.0, **kw):
    now = int(time.time() * 1000)
    return app.state.paper.open_from_signal(make_signal(sid, **kw), f"{kw.get('asset', 'ETH')}-PERP", mark, now, requested_leverage=leverage, now_ms=now)


def test_accepted_trade_records_price_provenance_and_age(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    now = int(time.time() * 1000)
    mark_at_ms = now - 45_000  # a 45s-old price, well under the 120s freshness threshold
    signal = make_signal(ts=now)
    result = app.state.paper.open_from_signal(signal, "ETH-PERP", 100.0, mark_at_ms, now_ms=now,
                                              market_price_source="HYPERLIQUID_ALLMIDS_LIVE")
    assert result.accepted, result.reason
    trade = result.trade
    assert trade["signal_timestamp"] == signal["timestamp"]
    assert trade["market_price_timestamp"] == mark_at_ms
    assert trade["market_price_source"] == "HYPERLIQUID_ALLMIDS_LIVE"
    assert trade["market_price_age_ms"] == pytest.approx(45_000, abs=1000)


def test_price_older_than_120s_fails_closed_never_falls_back(db):
    # Data-integrity audit (2026-09-27): a stale price is NO_TRADE, never a
    # silently reused old one.
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    now = int(time.time() * 1000)
    too_old = now - 121_000
    result = app.state.paper.open_from_signal(make_signal(), "ETH-PERP", 100.0, too_old, now_ms=now)
    assert not result.accepted and result.reason == "STALE_MARKET_DATA"
    missing = app.state.paper.open_from_signal(make_signal("sig-2"), "ETH-PERP", None, None, now_ms=now)
    assert not missing.accepted and missing.reason == "NO_MARKET_PRICE"


def test_full_lifecycle_tp1_then_tp2_realizes_profit_and_reconciles(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    result = open_trade(app)
    assert result.accepted, result.reason
    trade = result.trade
    assert trade["risk_amount"] == pytest.approx(100.0)  # 1% of 10k
    assert trade["max_loss"] == pytest.approx(100.0)
    t0 = trade["opened_at_ms"]
    marked = app.state.paper.mark("ETH-PERP", [candle(t0 + H, 111, 101), candle(t0 + 2 * H, 121, 105)])
    assert [e["kind"] for e in marked.exits] == ["TP1", "TP2"]
    closed = app.state.ledger.trade("sig-1")
    assert closed["status"] == "CLOSED" and closed["remaining_qty"] == 0
    assert closed["realized_pnl"] > 0 and closed["fees"] > 0
    assert app.state.portfolio.position("ETH-PERP") is None
    client = TestClient(app)
    rec = client.post("/reconcile", json={}, headers=HEADERS).json()
    assert rec["reconciled"] is True and rec["halted"] is False
    report = client.get("/paper/report", headers=HEADERS).json()
    assert report["execution_mode"] == "PAPER" and report["includes_backtest"] is False
    assert report["trades_closed"] == 1 and report["wins"] == 1 and report["win_rate_pct"] == 100.0
    assert report["ending_equity"] > report["starting_equity"]


def test_stop_loss_costs_about_1r(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    trade = open_trade(app).trade
    app.state.paper.mark("ETH-PERP", [candle(trade["opened_at_ms"] + H, 101, 89)])
    closed = app.state.ledger.trade("sig-1")
    assert closed["exit_reason"] == "STOP"
    loss = closed["realized_pnl"] - closed["fees"]
    assert -110 < loss < -95  # ~1R plus fees and slippage


def test_same_instrument_cannot_pyramid(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    assert open_trade(app, "sig-1").accepted
    second = open_trade(app, "sig-2")
    assert not second.accepted and second.reason == "DUPLICATE_INSTRUMENT"


def test_exposure_cap_counts_open_trades_across_instruments(db):
    app = create_app(db_path=db)
    # Default policy: 1% risk / 10% stop alone would size to 10% notional,
    # but the 5% per-position ceiling caps each to 5%; four positions (also
    # exactly MAX_CONCURRENT_POSITIONS) fill the 20% aggregate cap.
    for sid, asset in [("a", "ETH"), ("b", "BTC"), ("c", "SOL"), ("d", "AVAX")]:
        result = open_trade(app, sid, asset=asset)
        assert result.accepted, result.reason
        # Each slot is ~5% of equity at the moment it opens; equity itself
        # drifts down slightly trade to trade from entry fees, so this is a
        # tolerance, not an exact 500.
        assert result.trade["notional"] == pytest.approx(500, rel=0.01)
    fifth = open_trade(app, "e", asset="LINK")
    assert not fifth.accepted and fifth.reason == "MAX_CONCURRENT_POSITIONS_EXCEEDED"
    assert app.state.ledger.account_state().open_notional <= 2_000 + 1e-6  # never overshoots the 20% cap
    assert app.state.ledger.account_state().open_notional == pytest.approx(2_000, rel=0.01)


def test_closing_a_position_releases_its_slot_and_exposure_for_a_new_trade(db):
    # Lifecycle coverage Jakob asked for: position close -> exposure
    # released -> new trade admitted, at the real 4-slot / 20% policy.
    app = create_app(db_path=db)
    for sid, asset in [("a", "ETH"), ("b", "BTC"), ("c", "SOL"), ("d", "AVAX")]:
        assert open_trade(app, sid, asset=asset).accepted
    blocked = open_trade(app, "e", asset="LINK")
    assert not blocked.accepted and blocked.reason == "MAX_CONCURRENT_POSITIONS_EXCEEDED"

    t0 = app.state.ledger.trade("a")["opened_at_ms"]
    app.state.paper.mark("ETH-PERP", [candle(t0 + H, 101, 89)])  # stop out "a"
    closed = app.state.ledger.trade("a")
    assert closed["status"] == "CLOSED" and closed["exit_reason"] == "STOP"
    assert app.state.ledger.account_state().open_positions == 3
    assert app.state.ledger.account_state().open_notional == pytest.approx(1_500, rel=0.01)

    admitted = open_trade(app, "e", asset="LINK")
    assert admitted.accepted, admitted.reason
    assert app.state.ledger.account_state().open_positions == 4
    rec = TestClient(app).post("/reconcile", json={}, headers=HEADERS).json()
    assert rec["reconciled"] is True and rec["halted"] is False


def test_simultaneous_signals_cannot_independently_pass_the_exposure_check(db, monkeypatch):
    # Jakob (2026-09-27): exposure reservation must be atomic. FastAPI runs
    # sync endpoints in a threadpool, so two /paper/signal calls can
    # interleave; without the entry lock both could read the same
    # account_state() snapshot and both pass the cap. Widen the race window
    # by making account_state() (read inside the lock) briefly yield.
    app = create_app(db_path=db)
    for sid, asset in [("a", "ETH"), ("b", "BTC"), ("c", "SOL")]:
        assert open_trade(app, sid, asset=asset).accepted  # 3 of 4 slots used, one 5% slot (=$500) left

    real_account_state = app.state.ledger.account_state

    def slow_account_state(*args, **kwargs):
        result = real_account_state(*args, **kwargs)
        time.sleep(0.05)
        return result

    monkeypatch.setattr(app.state.ledger, "account_state", slow_account_state)

    results = {}

    def fire(sid, asset):
        results[sid] = open_trade(app, sid, asset=asset)

    threads = [threading.Thread(target=fire, args=("d", "AVAX")), threading.Thread(target=fire, args=("e", "LINK"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    accepted = [r for r in results.values() if r.accepted]
    rejected = [r for r in results.values() if not r.accepted]
    assert len(accepted) == 1, "exactly one of the two racing signals may claim the last exposure slot"
    assert len(rejected) == 1
    assert rejected[0].reason in ("MAX_CONCURRENT_POSITIONS_EXCEEDED", "PORTFOLIO_EXPOSURE_CAP", "POSITION_EXPOSURE_CAP")
    account = app.state.ledger.account_state()
    assert account.open_notional <= 2_000 + 1e-6  # never overshoots the 20% cap
    assert account.open_notional == pytest.approx(2_000, rel=0.01)
    assert account.open_positions == 4


def test_racing_signals_cannot_both_claim_the_same_aggregate_room(db, monkeypatch):
    # Same race as above, but with the concurrency limit out of the way so
    # the only thing standing between the two signals and a 25% book is the
    # aggregate exposure reservation itself.
    app = create_app(db_path=db, risk_limits=RiskLimits(max_concurrent_positions=10))
    for sid, asset in [("a", "ETH"), ("b", "BTC"), ("c", "SOL")]:
        assert open_trade(app, sid, asset=asset).accepted  # ~$1,500 open; ~$500 of the 20% cap left
    real_account_state = app.state.ledger.account_state

    def slow_account_state(*args, **kwargs):
        result = real_account_state(*args, **kwargs)
        time.sleep(0.05)
        return result

    monkeypatch.setattr(app.state.ledger, "account_state", slow_account_state)
    results = {}
    threads = [threading.Thread(target=lambda s=s, a=a: results.__setitem__(s, open_trade(app, s, asset=a)))
               for s, a in [("d", "AVAX"), ("e", "LINK"), ("f", "DOGE")]]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    accepted = [r for r in results.values() if r.accepted]
    assert len(accepted) == 1, [r.reason for r in results.values()]
    assert all(r.reason == "PORTFOLIO_EXPOSURE_CAP" for r in results.values() if not r.accepted)
    account = real_account_state()
    assert account.open_notional <= 2_000 + 1e-6 and account.open_positions == 4


def test_price_provenance_is_recorded_through_the_http_api(db):
    client = TestClient(create_app(db_path=db))
    now = int(time.time() * 1000)
    body = client.post("/paper/signal", headers=HEADERS, json={
        "signal": make_signal("p1"), "instrument": "ETH-PERP", "coin": "ETH", "mark_price": 100.0, "mark_at_ms": now - 5_000,
        "requested_leverage": 1, "market_price_source": "HYPERLIQUID_ALLMIDS_LIVE"}).json()
    assert body["accepted"], body
    assert body["trade"]["market_price_timestamp"] == now - 5_000
    assert body["trade"]["market_price_source"] == "HYPERLIQUID_ALLMIDS_LIVE"
    assert 5_000 <= body["trade"]["market_price_age_ms"] < 60_000
    missing = client.post("/paper/signal", headers=HEADERS, json={
        "signal": make_signal("p2", asset="BTC"), "instrument": "BTC-PERP", "coin": "BTC", "mark_price": None, "mark_at_ms": None,
        "requested_leverage": 1, "market_price_source": "HYPERLIQUID_ALLMIDS_LIVE"}).json()
    assert missing["accepted"] is False and missing["reason"] == "NO_MARKET_PRICE"


def test_duplicate_signal_id_rejected(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    assert open_trade(app, "dup").accepted
    app.state.paper.mark("ETH-PERP", [candle(int(time.time() * 1000) + H, 101, 89)])  # close it
    again = open_trade(app, "dup")
    assert not again.accepted and again.reason == "DUPLICATE_SIGNAL"


def test_stale_signal_and_stale_market_data_rejected(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    now = int(time.time() * 1000)
    stale = app.state.paper.open_from_signal(make_signal("old", ts=now - 3600_000), "ETH-PERP", 100.0, now, now_ms=now)
    assert stale.reason == "STALE_SIGNAL"
    old_mark = app.state.paper.open_from_signal(make_signal("oldmark"), "ETH-PERP", 100.0, now - 600_000, now_ms=now)
    assert old_mark.reason == "STALE_MARKET_DATA"


def test_stop_already_breached_and_target_already_reached_rejected(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    assert open_trade(app, "x", mark=89.0).reason == "STOP_ALREADY_BREACHED"
    assert open_trade(app, "y", mark=111.0).reason == "TARGET_ALREADY_REACHED"


def test_no_trade_is_recorded(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    app.state.paper.record_no_trade("NO_VALID_CANDIDATE")
    assert app.state.ledger.signal_history()[-1]["outcome"] == "NO_TRADE"


# ---- failure hardening -------------------------------------------------

def test_restart_mid_trade_resumes_from_persisted_state(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    trade = open_trade(app).trade
    t0 = trade["opened_at_ms"]
    app.state.paper.mark("ETH-PERP", [candle(t0 + H, 111, 101)])  # TP1 only
    equity_before = app.state.ledger.totals()["equity"]

    restarted = create_app(db_path=db, risk_limits=WIDE_LIMITS)  # service restart + DB reopen
    resumed = restarted.state.ledger.trade("sig-1")
    assert resumed["status"] == "PARTIAL" and resumed["tp1_hit"] is True
    assert restarted.state.ledger.totals()["equity"] == pytest.approx(equity_before)
    assert restarted.state.portfolio.position("ETH-PERP").quantity == pytest.approx(resumed["remaining_qty"], rel=1e-6)
    restarted.state.paper.mark("ETH-PERP", [candle(t0 + 2 * H, 104, 99.9)])  # breakeven stop
    assert restarted.state.ledger.trade("sig-1")["exit_reason"] == "BREAKEVEN_STOP"


def test_duplicate_and_out_of_order_candle_callbacks_do_not_double_close(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    t0 = open_trade(app).trade["opened_at_ms"]
    batch = [candle(t0 + H, 111, 101)]
    first = app.state.paper.mark("ETH-PERP", batch)
    again = app.state.paper.mark("ETH-PERP", batch)  # duplicate callback
    older = app.state.paper.mark("ETH-PERP", [candle(t0 + H // 2, 130, 101)])  # out of order, older than last check
    assert [e["kind"] for e in first.exits] == ["TP1"]
    assert again.exits == [] and older.exits == []
    trade = app.state.ledger.trade("sig-1")
    assert trade["remaining_qty"] == pytest.approx(trade["quantity"] / 2)


def test_kill_switch_survives_restart_blocks_entries_but_lets_stop_close(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    t0 = open_trade(app, "a").trade["opened_at_ms"]
    client = TestClient(app)
    client.post("/kill", json={"reason": "TEST"}, headers=HEADERS)

    restarted = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    assert restarted.state.router.killed is True
    blocked = open_trade(restarted, "b", asset="BTC")
    assert not blocked.accepted and blocked.reason == "KILL_SWITCH_ACTIVE"
    restarted.state.paper.mark("ETH-PERP", [candle(t0 + H, 101, 89)])
    assert restarted.state.ledger.trade("a")["exit_reason"] == "STOP"  # risk-reducing exit still went through


class _TimeoutBackend:
    def submit(self, intent):
        raise TimeoutError("simulated backend timeout")


def test_backend_timeout_on_entry_fails_closed(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    app.state.router.backends["NAUTILUS_NATIVE"] = _TimeoutBackend()
    result = open_trade(app, "t1")
    assert not result.accepted and "BACKEND_SUBMIT_FAILED" in result.reason
    assert app.state.ledger.trade("t1") is None
    assert any(o["signal_id"] == "t1" and o["status"] == "SUBMIT_FAILED_UNKNOWN" for o in app.state.store.orders())
    retry = open_trade(app, "t1")
    assert retry.reason == "DUPLICATE_SIGNAL"


def test_exit_backend_failure_halts_and_keeps_trade_open(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    t0 = open_trade(app).trade["opened_at_ms"]
    app.state.router.backends["NAUTILUS_NATIVE"] = _TimeoutBackend()
    app.state.paper.mark("ETH-PERP", [candle(t0 + H, 101, 89)])
    assert app.state.router.killed is True
    assert app.state.ledger.trade("sig-1")["status"] == "OPEN"  # never marked closed without a fill


def test_ledger_portfolio_divergence_halts_on_reconcile(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    open_trade(app)
    app.state.portfolio._positions["ETH-PERP"].quantity *= 2  # noqa: SLF001 -- simulated divergence
    rec = TestClient(app).post("/reconcile", json={}, headers=HEADERS).json()
    assert rec["reconciled"] is False and rec["halted"] is True


def test_leverage_rotation_logs_full_risk_fields_and_keeps_loss_constant(db):
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    losses = []
    for i, (lev, asset) in enumerate([(1, "A"), (3, "B")]):
        trade = open_trade(app, f"lev-{i}", leverage=lev, asset=asset).trade
        for field in ("approved_leverage", "notional", "margin_used", "stop_distance", "risk_amount", "max_loss",
                      "liquidation_estimate", "liquidation_buffer_pct"):
            assert trade[field] is not None
        assert trade["margin_used"] == pytest.approx(trade["notional"] / trade["approved_leverage"])
        losses.append(trade["max_loss"])
    assert losses[0] == pytest.approx(losses[1], rel=0.02)  # equity moves slightly with fees


def test_position_opened_outside_the_paper_session_blocks_entry_on_that_instrument(db):
    # CI Part F: a BTC fill via /execution/signal, then a paper BTC entry,
    # merged into one portfolio position and tripped reconciliation.
    app = create_app(db_path=db, risk_limits=WIDE_LIMITS)
    client = TestClient(app)
    outside = {"signal_id": "outside-1", "instrument": "ETH-PERP", "side": "buy", "quantity": 1.0, "order_type": "MARKET",
               "strategy_id": "alpha", "limit_price": 100.0, "stop": 90.0, "leverage": 1}
    assert client.post("/execution/intent", json=outside, headers=HEADERS).status_code == 200
    result = open_trade(app)
    assert not result.accepted and result.reason == "DUPLICATE_INSTRUMENT"
    assert client.post("/reconcile", json={}, headers=HEADERS).json()["reconciled"] is True
