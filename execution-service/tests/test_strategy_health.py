"""DATA 19 (#67): per-strategy health monitor. Degradation is flagged, healthy data is quiet, no state is changed."""
import inspect
import json
import os
import random
import sqlite3
import time
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.monitoring import strategy_health as H
from market_edge_exec.shadow.store import ShadowStore
from tests.test_drift_monitor import DAY, put

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
HEADERS = {"X-API-Key": "test-key"}
NOW = 1_800_000_000_000 + 60 * DAY
WINDOW, BASE = 14, 42


def trade(i, strategy, closed_ms, r, *, stop=False, tp1=True, tp2=False, slip=1.0):
    risk = 100.0
    exits = [{"kind": "STOP", "quantity": 1, "fill_price": 99, "pnl": r * risk}] if stop else \
        [{"kind": "TP1", "quantity": 1, "fill_price": 101, "pnl": 10}] + ([{"kind": "TP2", "quantity": 1, "fill_price": 102, "pnl": 20}] if tp2 else [])
    return {"trade_id": f"{strategy}-{i}", "signal_id": f"{strategy}-{i}", "strategy": strategy, "status": "CLOSED", "direction": "long",
            "entry_fill": 100.0, "stop": 99.0, "best_price": 100.0 + max(r, 0.2), "risk_amount": risk, "realized_pnl": r * risk,
            "closed_at_ms": closed_ms, "opened_at_ms": closed_ms - 3600_000, "exits": exits, "tp1_hit": tp1 and not stop, "slippage_cost": slip,
            "instrument": "BTC-USD", "quantity": 1}


def paper_db(path, trades):
    with closing(sqlite3.connect(path)) as c:
        c.execute("CREATE TABLE IF NOT EXISTS paper_trades (trade_id TEXT PRIMARY KEY, instrument TEXT, status TEXT, opened_at_ms INTEGER, closed_at_ms INTEGER, payload TEXT)")
        for t in trades:
            c.execute("INSERT INTO paper_trades VALUES (?,?,?,?,?,?)", (t["trade_id"], "BTC", "CLOSED", t["opened_at_ms"], t["closed_at_ms"], json.dumps(t)))
        c.commit()


def series(strategy, start_day, days, per_day, rng, *, mean_r, sd=0.8, stop_p=0.3, slip=1.0, offset=0):
    out, i = [], offset
    for d in range(days):
        for k in range(per_day):
            i += 1
            r = rng.gauss(mean_r, sd)
            stopped = rng.random() < stop_p
            out.append(trade(i, strategy, NOW + (start_day + d) * DAY + k * 60_000, -1.0 if stopped else abs(r) + 0.2, stop=stopped, slip=rng.gauss(slip, 0.2 * slip)))
    return out


def world(tmp_path, healthy=True, seed=1):
    rng = random.Random(seed)
    trades = series("TREND", -(WINDOW + BASE), BASE, 1, rng, mean_r=0.3, stop_p=0.3) * 1
    trades = [t for t in trades] + series("TREND", -WINDOW, WINDOW, 3, rng, mean_r=0.3, stop_p=0.3 if healthy else 0.75, slip=1.0 if healthy else 3.0, offset=1000)
    trades += series("BREAKOUT", -(WINDOW + BASE), BASE, 1, rng, mean_r=0.3, stop_p=0.3, offset=5000)
    trades += series("BREAKOUT", -WINDOW, WINDOW, 2, rng, mean_r=0.3, stop_p=0.3, offset=6000)
    db = str(tmp_path / "p.sqlite3")
    paper_db(db, trades)
    return db


@pytest.fixture
def store(tmp_path):
    return ShadowStore(str(tmp_path / "s.sqlite3"))


def obs(store, strategy, start_day, days, per_day, rng, *, score=60.0, reason_p=0.3, n0=0):
    n = n0
    for d in range(days):
        for k in range(per_day):
            n += 1
            put(store, f"{strategy}-{start_day}-{n}", NOW + (start_day + d) * DAY + k * 60_000, strategy=strategy, score=rng.gauss(score, 5),
                reason="RISK_CAP" if rng.random() < reason_p else None)


def test_healthy_strategies_raise_nothing(tmp_path, store):
    out = H.run(store, world(tmp_path, healthy=True), NOW, WINDOW, BASE)
    # Several metrics are tested, so a single stray FLAG on unchanged data is possible; an ALERT is not what unchanged data should give.
    assert {v["action"] for v in out["strategies"].values()} <= {"NONE", "FLAG"}


def test_a_degrading_strategy_is_flagged_and_the_healthy_one_is_not(tmp_path, store):
    trades_db = world(tmp_path, healthy=False)
    out = H.run(store, trades_db, NOW, WINDOW, BASE)
    trend = out["strategies"]["TREND"]
    assert trend["action"] == "ALERT"
    assert {"expectancy_R", "stop_rate", "slippage"} <= set(trend["alert_metrics"]), trend
    assert out["strategies"]["BREAKOUT"]["action"] in ("NONE", "FLAG")
    assert all(a["level"] in ("ALERT", "FLAG") for a in store.drift_alert_history(H.ALERT_NAME))


def test_rising_drawdown_is_detected():
    calm, deep = [0.5, -1, 0.5, 0.5, -1] * 8, [0.5, -1, -1, -1, -1, 0.5] * 7
    assert H.max_drawdown(deep) > H.max_drawdown(calm) * 2.5
    base = {"trades": {"S": [{"r": r, "stop": False, "tp1": True, "tp2": False, "slippage": 1.0, "giveback_r": 0.1, "regime": None} for r in calm]}, "obs": {}, "days": 42}
    cur = {"trades": {"S": [{"r": r, "stop": False, "tp1": True, "tp2": False, "slippage": 1.0, "giveback_r": 0.1, "regime": None} for r in deep]}, "obs": {}, "days": 14}
    dd = next(f for f in H.compare_strategy("S", base, cur) if f["metric"] == "drawdown_R")
    assert dd["level"] == "ALERT"


def test_thin_data_is_insufficient_not_alarming(tmp_path, store):
    db = str(tmp_path / "p.sqlite3")
    paper_db(db, [trade(i, "NEW", NOW - DAY * (i + 1), -1.0, stop=True) for i in range(5)])
    out = H.run(store, db, NOW, WINDOW, BASE)
    assert out["strategies"]["NEW"]["action"] == "NONE" and "outcomes" in out["strategies"]["NEW"]["insufficient"]


def test_candidate_quality_decay_and_rejection_and_frequency_from_shadow_data(tmp_path, store):
    rng = random.Random(9)
    obs(store, "TREND", -(WINDOW + BASE), BASE, 3, rng, score=65, reason_p=0.2)
    obs(store, "TREND", -WINDOW, WINDOW, 10, rng, score=52, reason_p=0.6, n0=10_000)
    out = H.run(store, None, NOW, WINDOW, BASE)
    metrics = {f["metric"]: f for f in out["findings"] if f["strategy"] == "TREND"}
    assert metrics["candidate_quality"]["level"] == "ALERT"
    assert metrics["rejection_rate"]["level"] == "ALERT"
    assert metrics["frequency"]["level"] == "FLAG"              # frequency never escalates past FLAG


def test_regime_sensitivity_reports_a_losing_regime(tmp_path, store):
    rs = [{"r": r, "stop": False, "tp1": True, "tp2": False, "slippage": 1.0, "giveback_r": 0.1, "regime": g}
          for r, g in [(0.5, "UPTREND")] * 25 + [(-1.0, "RANGE")] * 15]
    base = {"trades": {"S": rs}, "obs": {}, "days": 42}
    cur = {"trades": {"S": rs}, "obs": {}, "days": 14}
    f = next(f for f in H.compare_strategy("S", base, cur) if f["metric"] == "regime_sensitivity")
    assert f["level"] == "FLAG" and f["losing_regimes"] == ["RANGE"]


def test_trade_record_uses_the_trades_own_figures_and_skips_open_or_malformed_trades():
    t = trade(1, "S", NOW, 2.0)
    rec = H.trade_record(t)
    assert rec["r"] == 2.0 and rec["giveback_r"] is not None and rec["tp1"]
    assert H.trade_record({**t, "status": "OPEN"}) is None
    assert H.trade_record({**t, "risk_amount": 0}) is None


def _counts(path):
    with closing(sqlite3.connect(path)) as c:
        return {t: c.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def test_a_check_writes_only_the_alert_table_and_never_touches_the_paper_db(tmp_path, store):
    db = world(tmp_path, healthy=False)
    before, paper_before = _counts(store.path), open(db, "rb").read()
    H.run(store, db, NOW, WINDOW, BASE)
    changed = {t for t, n in _counts(store.path).items() if n != before[t]}
    assert changed == {"drift_alerts"}
    assert open(db, "rb").read() == paper_before


def test_no_code_path_changes_a_strategys_state_risk_or_eligibility():
    src = inspect.getsource(H)
    for banned in ("ControlStore", "set_setting", "PaperEngine", "PaperLedger", "sizing_runtime", "requests", "urllib", "httpx", "REDUCED_RISK", "quant-engine"):
        assert banned not in src
    # the future states are only ever named; no function assigns one
    assert all(v not in {f for f in dir(H) if f.startswith("set_") or f.startswith("pause") or f.startswith("apply")} for v in H.FUTURE_STATES)
    assert not [n for n, o in inspect.getmembers(H, inspect.isfunction) if n.startswith(("set_", "pause", "apply", "reduce", "demote"))]


def test_api(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"))
    client = TestClient(app)
    assert client.get("/research/strategy-health").status_code == 401
    assert client.get("/research/strategy-health?window_days=0", headers=HEADERS).status_code == 422
    out = client.get("/research/strategy-health", headers=HEADERS).json()
    assert out["label"].startswith("RESEARCH ONLY") and out["strategies"] == {} and out["future_states_named_only"]
    assert client.get("/research/strategy-health/alerts", headers=HEADERS).json()["alerts"] == []
