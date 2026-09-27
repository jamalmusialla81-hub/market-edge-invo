"""Endpoints the desktop app reads and controls through: read-only ledger
views, persisted/validated risk settings, pause/resume, clearing a halt only
after a clean reconciliation, and system status. All go through the real
router/portfolio/ledger -- nothing here is mocked."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
H = 3_600_000


def make_signal(sid="sig-1", asset="ETH", direction="long", entry=100.0, stop=90.0, tp1=110.0, tp2=120.0, ts=None):
    return {"signal_id": sid, "asset": asset, "direction": direction, "timestamp": ts or int(time.time() * 1000),
            "entry": entry, "stop": stop, "targets": [tp1, tp2], "strategy_id": "TREND CONTINUATION", "quant_score": 72}


def post_signal(client, sid="sig-1", asset="ETH", mark=100.0, mark_age_ms=0, **kw):
    now = int(time.time() * 1000)
    return client.post("/paper/signal", headers=HEADERS, json={
        "signal": make_signal(sid, asset=asset, **kw), "instrument": f"{asset}-PERP", "coin": asset,
        "mark_price": mark, "mark_at_ms": now - mark_age_ms, "requested_leverage": 1,
        "meta": {"rank": 1, "quant_score": 70, "ml_score": 0.61, "combined_score": 72.5, "rr1": 1.0},
    }).json()


def candle(t, high, low, close=None):
    return {"time": t, "open": low, "high": high, "low": low, "close": close if close is not None else (high + low) / 2}


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "desktop.sqlite3")


@pytest.fixture
def client(db):
    return TestClient(create_app(db_path=db))


@pytest.mark.parametrize("method,path", [
    ("get", "/paper/account"), ("get", "/paper/positions"), ("get", "/paper/trades"), ("get", "/paper/signals"),
    ("get", "/paper/performance"), ("get", "/risk/config"), ("get", "/risk/usage"), ("get", "/system/status"),
    ("post", "/control/pause"), ("post", "/control/resume"), ("post", "/control/clear-halt"), ("post", "/system/shutdown"),
])
def test_every_desktop_endpoint_requires_the_api_key(client, method, path):
    kwargs = {"json": {}} if method == "post" else {}
    assert getattr(client, method)(path, **kwargs).status_code == 401


def test_empty_session_reports_real_zeroes_not_demo_values(client):
    account = client.get("/paper/account", headers=HEADERS).json()
    assert account["starting_equity"] == 10_000 and account["equity"] == 10_000 and account["open_positions"] == 0
    assert client.get("/paper/positions", headers=HEADERS).json() == {"positions": []}
    assert client.get("/paper/trades", headers=HEADERS).json() == {"trades": []}
    assert client.get("/paper/signals", headers=HEADERS).json() == {"signals": []}
    perf = client.get("/paper/performance", headers=HEADERS).json()
    assert perf["number_of_trades"] == 0 and perf["equity_curve"] == [] and perf["win_rate_pct"] is None


def test_signal_position_trade_and_performance_views_follow_the_ledger(client):
    opened = post_signal(client)
    assert opened["accepted"], opened
    signals = client.get("/paper/signals", headers=HEADERS).json()["signals"]
    assert signals[0]["signal_id"] == "sig-1" and signals[0]["accepted"] is True
    assert signals[0]["rank"] == 1 and signals[0]["combined_score"] == 72.5 and signals[0]["rr"] == 1.0
    assert signals[0]["tp1"] == 110.0 and signals[0]["tp2"] == 120.0 and signals[0]["freshness_s"] >= 0

    positions = client.get("/paper/positions", headers=HEADERS).json()["positions"]
    assert len(positions) == 1
    p = positions[0]
    assert p["direction"] == "long" and p["backend"] == "NAUTILUS_NATIVE" and p["risk_amount"] == pytest.approx(100.0)
    assert p["liquidation_estimate"] is not None and p["margin"] > 0

    t0 = opened["trade"]["opened_at_ms"]
    marked = client.post("/paper/mark", headers=HEADERS, json={"instrument": "ETH-PERP", "candles": [candle(t0 + H, 111, 101), candle(t0 + 2 * H, 121, 105)]}).json()
    assert [e["kind"] for e in marked["exits"]] == ["TP1", "TP2"]

    assert client.get("/paper/positions", headers=HEADERS).json()["positions"] == []
    trade = client.get("/paper/trades", headers=HEADERS).json()["trades"][0]
    assert trade["status"] == "CLOSED" and trade["exit_reason"] == "TP2" and trade["exit"] > trade["entry"]
    assert trade["r_multiple"] > 1.0 and trade["fees"] > 0

    perf = client.get("/paper/performance", headers=HEADERS).json()
    assert perf["number_of_trades"] == 1 and perf["wins"] == 1 and perf["average_win"] > 0 and perf["average_r"] > 1
    assert perf["equity_curve"] and perf["drawdown_curve"] and len(perf["cumulative_pnl"]) == 1
    assert perf["leverage_distribution"] == {"1.0": 1}
    account = client.get("/paper/account", headers=HEADERS).json()
    assert account["equity"] > account["starting_equity"] and account["total_pnl"] > 0


def test_risk_settings_are_validated_by_the_backend(client):
    for bad in ({"leverage_ceiling": 20}, {"max_risk_per_trade_pct": 5}, {"max_concurrent_positions": 2.5},
                {"not_a_setting": 1}, {"daily_loss_limit_pct": "3"}, {}):
        assert client.put("/risk/config", headers=HEADERS, json=bad).status_code == 422, bad
    assert client.get("/risk/config", headers=HEADERS).json()["settings"]["leverage_ceiling"] == 10.0


def test_risk_settings_persist_across_restart_and_apply_to_sizing(db):
    first = TestClient(create_app(db_path=db))
    updated = first.put("/risk/config", headers=HEADERS, json={"max_risk_per_trade_pct": 0.5, "max_concurrent_positions": 3}).json()
    assert updated["settings"]["max_risk_per_trade_pct"] == 0.5
    second = TestClient(create_app(db_path=db))  # fresh process view of the same SQLite file
    assert second.get("/risk/config", headers=HEADERS).json()["settings"]["max_concurrent_positions"] == 3
    opened = post_signal(second)
    assert opened["accepted"]
    assert opened["trade"]["risk_amount"] == pytest.approx(50.0)  # 0.5% of 10k, size = budget / stop distance
    usage = {u["key"]: u for u in second.get("/risk/usage", headers=HEADERS).json()["usage"]}
    assert usage["max_concurrent_positions"]["current"] == 1 and usage["max_concurrent_positions"]["limit"] == 3
    assert usage["max_risk_per_trade_pct"]["current"] == pytest.approx(0.5, rel=1e-3)


def test_stale_data_timeout_setting_applies_to_entries(client):
    client.put("/risk/config", headers=HEADERS, json={"stale_data_timeout_s": 30})
    rejected = post_signal(client, mark_age_ms=60_000)
    assert rejected["accepted"] is False and rejected["reason"] == "STALE_MARKET_DATA"


def test_starting_equity_is_editable_only_before_any_trade(client):
    assert client.put("/risk/config", headers=HEADERS, json={"starting_equity": 25_000}).status_code == 200
    assert client.get("/paper/account", headers=HEADERS).json()["starting_equity"] == 25_000
    assert post_signal(client)["accepted"]
    assert client.put("/risk/config", headers=HEADERS, json={"starting_equity": 50_000}).status_code == 409


def test_pause_blocks_new_entries_but_exits_still_process(client):
    opened = post_signal(client)
    assert client.post("/control/pause", headers=HEADERS, json={}).json()["entries_paused"] is True
    blocked = post_signal(client, sid="sig-2", asset="BTC")
    assert blocked["accepted"] is False and blocked["reason"] == "ENTRIES_PAUSED"
    t0 = opened["trade"]["opened_at_ms"]
    marked = client.post("/paper/mark", headers=HEADERS, json={"instrument": "ETH-PERP", "candles": [candle(t0 + H, 95, 89)]}).json()
    assert [e["kind"] for e in marked["exits"]] == ["STOP"]
    assert client.post("/control/resume", headers=HEADERS).json()["entries_paused"] is False
    assert post_signal(client, sid="sig-3", asset="BTC")["accepted"]
    assert client.get("/system/status", headers=HEADERS).json()["entries_paused"] is False


def test_kill_switch_then_clear_halt_requires_confirmation_and_clean_reconcile(client):
    assert post_signal(client)["accepted"]
    client.post("/kill", headers=HEADERS, json={"reason": "MANUAL_KILL_SWITCH"})
    assert post_signal(client, sid="sig-2", asset="BTC")["reason"] == "KILL_SWITCH_ACTIVE"
    assert client.post("/control/resume", headers=HEADERS).json()["halted"] == "MANUAL_KILL_SWITCH"  # resume never clears a halt
    assert client.post("/control/clear-halt", headers=HEADERS, json={}).status_code == 422
    cleared = client.post("/control/clear-halt", headers=HEADERS, json={"confirm": "CLEAR_HALT"}).json()
    assert cleared["halted"] is None and cleared["previous_reason"] == "MANUAL_KILL_SWITCH" and cleared["reconcile"]["reconciled"]
    assert post_signal(client, sid="sig-3", asset="BTC")["accepted"]


def test_clear_halt_refuses_when_reconciliation_fails(db):
    app = create_app(db_path=db, hummingbot_mode="mock")
    client = TestClient(app)
    app.state.hummingbot._positions["ETH-PERP"] = 1.0  # noqa: SLF001 -- divergence Nautilus never recorded
    assert client.post("/reconcile", headers=HEADERS, json={}).json()["halted"] is True
    response = client.post("/control/clear-halt", headers=HEADERS, json={"confirm": "CLEAR_HALT"})
    assert response.status_code == 409
    assert client.get("/system/status", headers=HEADERS).json()["halted"]


def test_system_status_reports_real_components(client):
    client.post("/reconcile", headers=HEADERS, json={})
    status = client.get("/system/status", headers=HEADERS).json()
    assert status["paper_only"] is True and status["execution_mode"] == "PAPER"
    assert status["nautilus"]["ok"] is True and status["nautilus"]["version"]
    assert status["sqlite"]["ok"] is True and status["sqlite"]["quick_check"] == "ok"
    assert status["hummingbot"]["mode"] == "disabled"
    assert status["last_reconcile"]["reconciled"] is True


def test_shutdown_is_refused_unless_the_process_is_managed(client):
    assert client.post("/system/shutdown", headers=HEADERS).status_code == 409
