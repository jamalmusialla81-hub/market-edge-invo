"""TASK H: named stop-overshoot fields on every stop exit, measurement only."""
import hashlib
import os

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.analysis import stop_overshoot as report
from market_edge_exec.api.app import create_app
from market_edge_exec.paper import friction, lifecycle
from tests.test_risk_sizing_v2_paper import post, now_ms

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"


def test_fixture_stop_with_a_known_gap_computes_every_field():
    # long, stop 95, entry 100 => R = 5 per unit; the first observed price past the stop is 94 (1 below)
    fill = lifecycle.slipped(94.0, "sell")
    r = friction.stop_overshoot("long", "STOP", 95.0, fill, "WS_TRADE", 5.0, 94.0, 7_500)
    assert r["intended_stop"] == 95.0 and r["first_observed_post_stop_price"] == 94.0 and r["fill_price"] == fill
    assert r["overshoot_bps"] == pytest.approx(1 / 95 * 10_000) and r["overshoot_R"] == pytest.approx(1 / 5)
    assert r["fill_overshoot_bps"] == pytest.approx((95 - fill) / 95 * 10_000) and r["fill_overshoot_bps"] > r["overshoot_bps"]
    assert r["fill_overshoot_R"] == pytest.approx((95 - fill) / 5)
    assert r["detection_source"] == "WS_TRADE" and r["time_since_last_observation_ms"] == 7_500 and r["observed"] is True
    assert "websocket_or_poll" not in r and r["unavailable_reason"] is None


def test_short_stop_is_mirrored_and_a_touch_without_gap_is_zero():
    r = friction.stop_overshoot("short", "STOP", 105.0, lifecycle.slipped(106.0, "buy"), "POLL_HEARTBEAT", 5.0, 106.0, 30_000)
    assert r["overshoot_bps"] == pytest.approx(1 / 105 * 10_000) and r["overshoot_R"] == pytest.approx(0.2)
    exact = friction.stop_overshoot("long", "STOP", 95.0, lifecycle.slipped(95.0, "sell"), "WS_TRADE", 5.0, 95.0, 100)
    assert exact["overshoot_bps"] == 0.0 and exact["overshoot_R"] == 0.0 and exact["fill_overshoot_bps"] > 0   # only the fixed slippage remains


def test_no_observed_price_is_null_never_a_guess():
    r = friction.stop_overshoot("long", "STOP", 95.0, lifecycle.slipped(95.0, "sell"), "CANDLE_5M", 5.0)
    assert r["first_observed_post_stop_price"] is None and r["overshoot_bps"] is None and r["overshoot_R"] is None
    assert r["observed"] is False and "not guessed" in r["unavailable_reason"]
    assert r["fill_overshoot_bps"] is not None                      # the fill itself is still recorded


def test_non_stop_exits_get_no_record_and_bad_risk_gives_null_R():
    assert friction.stop_overshoot("long", "TP1", 110.0, 109.9, "WS_TRADE", 5.0) is None
    assert friction.stop_overshoot("long", "TIMEOUT", 100.0, 99.9, "WS_TRADE", 5.0) is None
    r = friction.stop_overshoot("long", "STOP", 95.0, 94.0, "WS_TRADE", 0.0, 94.0)
    assert r["overshoot_bps"] > 0 and r["overshoot_R"] is None


@pytest.fixture
def app_client(tmp_path):
    db = str(tmp_path / "p.sqlite3")
    app = create_app(db_path=db, sizing_mode="SHADOW")
    return app, TestClient(app), db


def _stop_exit(app, sid, asset, trigger, gap, first_tick=True):
    t = post(TestClient(app), sid, asset=asset, stop_pct=0.10)["trade"]
    instrument = f"{asset}-PERP"
    opened = t["opened_at_ms"]
    if first_tick:   # a heartbeat above the stop, so the next observation has a real previous observation
        app.state.paper.tick(instrument, 99.0, opened + 1_000, "TEST", trigger=trigger, now_ms=opened + 1_000)
    observed = t["stop"] - gap
    res = app.state.paper.tick(instrument, observed, opened + 5_000, "TEST", trigger=trigger, now_ms=opened + 5_000)
    assert res.exits and res.exits[0]["kind"] == "STOP"
    return t, observed, app.state.ledger.trade(sid)["exits"][0]


def test_detection_source_reflects_websocket_versus_poll_and_previous_observation(app_client):
    app, _, _ = app_client
    t, observed, ws = _stop_exit(app, "ws1", "SOL", "WS_TRADE", 0.7)
    rec = ws["stop_overshoot"]
    assert rec["detection_source"] == "WS_TRADE" and rec["first_observed_post_stop_price"] == pytest.approx(observed)
    assert rec["intended_stop"] == pytest.approx(t["stop"]) and rec["overshoot_bps"] == pytest.approx(0.7 / t["stop"] * 10_000)
    assert rec["overshoot_R"] == pytest.approx(0.7 / abs(t["entry_fill"] - t["stop"]))
    assert rec["time_since_last_observation_ms"] == pytest.approx(4_000, abs=50)
    assert ws["fill_price"] == pytest.approx(lifecycle.slipped(observed, "sell"))   # the stop fill itself is unchanged
    _, _, poll = _stop_exit(app, "po1", "DOGE", "POLL_HEARTBEAT", 0.7)
    assert poll["stop_overshoot"]["detection_source"] == "POLL_HEARTBEAT"


def test_first_ever_observation_has_null_gap_and_candle_stop_has_no_observed_price(app_client):
    app, client, _ = app_client
    _, _, ex = _stop_exit(app, "n1", "SOL", "WS_TRADE", 0.2, first_tick=False)
    assert ex["stop_overshoot"]["time_since_last_observation_ms"] is None
    t = post(client, "c1", asset="DOGE", stop_pct=0.10)["trade"]
    candle = {"time": t["opened_at_ms"] + 300_000, "open": 100, "high": 100, "low": t["stop"] - 1, "close": t["stop"] - 1}
    assert app.state.paper.mark("DOGE-PERP", [candle], now_ms()).exits
    rec = app.state.ledger.trade("c1")["exits"][0]["stop_overshoot"]
    assert rec["detection_source"] == "CANDLE_5M" and rec["overshoot_bps"] is None and rec["observed"] is False


def test_target_exits_carry_no_stop_overshoot(app_client):
    app, client, _ = app_client
    t = post(client, "tp", asset="SOL", stop_pct=0.10)["trade"]
    res = app.state.paper.tick("SOL-PERP", t["tp1"] + 0.5, now_ms(), "TEST", trigger="WS_TRADE")
    assert res.exits and res.exits[0]["kind"] == "TP1"
    assert "stop_overshoot" not in app.state.ledger.trade("tp")["exits"][0]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def test_report_summarises_by_asset_source_and_gap_and_never_writes(app_client, capsys):
    app, _, db = app_client
    _stop_exit(app, "r1", "SOL", "WS_TRADE", 0.5)
    _stop_exit(app, "r2", "DOGE", "POLL_HEARTBEAT", 0.0)
    before = sha(db)
    rep = report.report(db)
    assert rep["overall"]["exits"] == 2 and rep["overall"]["observed"] == 2 and rep["overall"]["with_overshoot"] == 1
    assert set(rep["by"]["asset"]) == {"SOL", "DOGE"} and set(rep["by"]["detection_source"]) == {"WS_TRADE", "POLL_HEARTBEAT"}
    assert rep["overall"]["estimate_allowed"] is False            # 2 exits: inspection only
    assert report.main([db]) == 0 and "inspection only" in capsys.readouterr().out
    assert sha(db) == before
