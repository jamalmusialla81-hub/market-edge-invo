"""Persistent forward-paper session: full lifecycle through the real
router/portfolio/ledger, plus failure hardening (all must fail closed)."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
H = 3_600_000


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


def test_full_lifecycle_tp1_then_tp2_realizes_profit_and_reconciles(db):
    app = create_app(db_path=db)
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
    app = create_app(db_path=db)
    trade = open_trade(app).trade
    app.state.paper.mark("ETH-PERP", [candle(trade["opened_at_ms"] + H, 101, 89)])
    closed = app.state.ledger.trade("sig-1")
    assert closed["exit_reason"] == "STOP"
    loss = closed["realized_pnl"] - closed["fees"]
    assert -110 < loss < -95  # ~1R plus fees and slippage


def test_same_instrument_cannot_pyramid(db):
    app = create_app(db_path=db)
    assert open_trade(app, "sig-1").accepted
    second = open_trade(app, "sig-2")
    assert not second.accepted and second.reason == "POSITION_ALREADY_OPEN_ON_INSTRUMENT"


def test_exposure_cap_counts_open_trades_across_instruments(db):
    app = create_app(db_path=db)
    # 10% stops => 10% notional each at 1% risk; the third breaches 20%.
    assert open_trade(app, "a", asset="ETH").accepted
    assert open_trade(app, "b", asset="BTC").accepted
    third = open_trade(app, "c", asset="SOL")
    assert not third.accepted and third.reason == "MAX_PORTFOLIO_EXPOSURE_EXCEEDED"


def test_duplicate_signal_id_rejected(db):
    app = create_app(db_path=db)
    assert open_trade(app, "dup").accepted
    app.state.paper.mark("ETH-PERP", [candle(int(time.time() * 1000) + H, 101, 89)])  # close it
    again = open_trade(app, "dup")
    assert not again.accepted and again.reason == "DUPLICATE_SIGNAL"


def test_stale_signal_and_stale_market_data_rejected(db):
    app = create_app(db_path=db)
    now = int(time.time() * 1000)
    stale = app.state.paper.open_from_signal(make_signal("old", ts=now - 3600_000), "ETH-PERP", 100.0, now, now_ms=now)
    assert stale.reason == "STALE_SIGNAL"
    old_mark = app.state.paper.open_from_signal(make_signal("oldmark"), "ETH-PERP", 100.0, now - 600_000, now_ms=now)
    assert old_mark.reason == "STALE_MARKET_DATA"


def test_stop_already_breached_and_target_already_reached_rejected(db):
    app = create_app(db_path=db)
    assert open_trade(app, "x", mark=89.0).reason == "STOP_ALREADY_BREACHED"
    assert open_trade(app, "y", mark=111.0).reason == "TARGET_ALREADY_REACHED"


def test_no_trade_is_recorded(db):
    app = create_app(db_path=db)
    app.state.paper.record_no_trade("NO_VALID_CANDIDATE")
    assert app.state.ledger.signal_history()[-1]["outcome"] == "NO_TRADE"


# ---- failure hardening -------------------------------------------------

def test_restart_mid_trade_resumes_from_persisted_state(db):
    app = create_app(db_path=db)
    trade = open_trade(app).trade
    t0 = trade["opened_at_ms"]
    app.state.paper.mark("ETH-PERP", [candle(t0 + H, 111, 101)])  # TP1 only
    equity_before = app.state.ledger.totals()["equity"]

    restarted = create_app(db_path=db)  # service restart + DB reopen
    resumed = restarted.state.ledger.trade("sig-1")
    assert resumed["status"] == "PARTIAL" and resumed["tp1_hit"] is True
    assert restarted.state.ledger.totals()["equity"] == pytest.approx(equity_before)
    assert restarted.state.portfolio.position("ETH-PERP").quantity == pytest.approx(resumed["remaining_qty"], rel=1e-6)
    restarted.state.paper.mark("ETH-PERP", [candle(t0 + 2 * H, 104, 99.9)])  # breakeven stop
    assert restarted.state.ledger.trade("sig-1")["exit_reason"] == "BREAKEVEN_STOP"


def test_duplicate_and_out_of_order_candle_callbacks_do_not_double_close(db):
    app = create_app(db_path=db)
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
    app = create_app(db_path=db)
    t0 = open_trade(app, "a").trade["opened_at_ms"]
    client = TestClient(app)
    client.post("/kill", json={"reason": "TEST"}, headers=HEADERS)

    restarted = create_app(db_path=db)
    assert restarted.state.router.killed is True
    blocked = open_trade(restarted, "b", asset="BTC")
    assert not blocked.accepted and blocked.reason == "KILL_SWITCH_ACTIVE"
    restarted.state.paper.mark("ETH-PERP", [candle(t0 + H, 101, 89)])
    assert restarted.state.ledger.trade("a")["exit_reason"] == "STOP"  # risk-reducing exit still went through


class _TimeoutBackend:
    def submit(self, intent):
        raise TimeoutError("simulated backend timeout")


def test_backend_timeout_on_entry_fails_closed(db):
    app = create_app(db_path=db)
    app.state.router.backends["NAUTILUS_NATIVE"] = _TimeoutBackend()
    result = open_trade(app, "t1")
    assert not result.accepted and "BACKEND_SUBMIT_FAILED" in result.reason
    assert app.state.ledger.trade("t1") is None
    assert any(o["signal_id"] == "t1" and o["status"] == "SUBMIT_FAILED_UNKNOWN" for o in app.state.store.orders())
    retry = open_trade(app, "t1")
    assert retry.reason == "DUPLICATE_SIGNAL"


def test_exit_backend_failure_halts_and_keeps_trade_open(db):
    app = create_app(db_path=db)
    t0 = open_trade(app).trade["opened_at_ms"]
    app.state.router.backends["NAUTILUS_NATIVE"] = _TimeoutBackend()
    app.state.paper.mark("ETH-PERP", [candle(t0 + H, 101, 89)])
    assert app.state.router.killed is True
    assert app.state.ledger.trade("sig-1")["status"] == "OPEN"  # never marked closed without a fill


def test_ledger_portfolio_divergence_halts_on_reconcile(db):
    app = create_app(db_path=db)
    open_trade(app)
    app.state.portfolio._positions["ETH-PERP"].quantity *= 2  # noqa: SLF001 -- simulated divergence
    rec = TestClient(app).post("/reconcile", json={}, headers=HEADERS).json()
    assert rec["reconciled"] is False and rec["halted"] is True


def test_leverage_rotation_logs_full_risk_fields_and_keeps_loss_constant(db):
    app = create_app(db_path=db)
    losses = []
    for i, (lev, asset) in enumerate([(1, "A"), (3, "B")]):
        trade = open_trade(app, f"lev-{i}", leverage=lev, asset=asset).trade
        for field in ("approved_leverage", "notional", "margin_used", "stop_distance", "risk_amount", "max_loss",
                      "liquidation_estimate", "liquidation_buffer_pct"):
            assert trade[field] is not None
        assert trade["margin_used"] == pytest.approx(trade["notional"] / trade["approved_leverage"])
        losses.append(trade["max_loss"])
    assert losses[0] == pytest.approx(losses[1], rel=0.02)  # equity moves slightly with fees
