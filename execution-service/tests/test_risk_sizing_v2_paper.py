"""Risk Sizing V2 wired into the real paper engine and API: rollout modes,
immutable decision records, portfolio/cluster planned risk across trades,
restart, TP1 current-risk, drawdown pause, after-trade outcomes, and the
shadow counterfactual that consumes no capital."""
import math
import os
import sqlite3
import threading
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.risk import sizing_v2 as S

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
DAY = S.DAY_MS
H = 3_600_000


def now_ms():
    return int(time.time() * 1000)


def risk_inputs(mark=100.0, depth_size=50.0, now=None):
    now = now or now_ms()
    closes, p = [], 100.0
    for i in range(260):
        p *= 1 + 0.01 * math.sin(i * 1.7)
        closes.append(p)
    return {"vol": {"venue": "HYPERLIQUID", "interval": "1d", "closes": closes, "last_bar_open_ms": now - now % DAY - DAY},
            "depth": {"venue": "HYPERLIQUID", "at_ms": now - 500,
                      "bids": [[mark * (1 - 0.0001 - i * 0.0005), depth_size] for i in range(20)],
                      "asks": [[mark * (1 + 0.0001 + i * 0.0005), depth_size] for i in range(20)]},
            "venue_rules": {"min_notional": 10.0, "qty_decimals": 5}}


def signal(sid, asset="SOL", direction="long", entry=100.0, stop_pct=0.10):
    stop = entry * (1 - stop_pct) if direction == "long" else entry * (1 + stop_pct)
    tp1 = entry * (1 + stop_pct) if direction == "long" else entry * (1 - stop_pct)
    tp2 = entry * (1 + 2 * stop_pct) if direction == "long" else entry * (1 - 2 * stop_pct)
    return {"signal_id": sid, "asset": asset, "direction": direction, "timestamp": now_ms(), "entry": entry, "stop": stop,
            "targets": [tp1, tp2], "strategy_id": "TREND CONTINUATION", "quant_score": 72}


def post(client, sid, asset="SOL", stop_pct=0.10, inputs="default", mark=100.0, **kw):
    body = {"signal": signal(sid, asset, stop_pct=stop_pct, **kw), "instrument": f"{asset}-PERP", "coin": asset,
            "mark_price": mark, "mark_at_ms": now_ms(), "requested_leverage": 1, "market_price_source": "TEST"}
    if inputs is not None:
        body["risk_inputs"] = risk_inputs(mark) if inputs == "default" else inputs
    return client.post("/paper/signal", headers=HEADERS, json=body).json()


@pytest.fixture
def paper(tmp_path):
    db = str(tmp_path / "p.sqlite3")
    app = create_app(db_path=db, sizing_mode="PAPER")
    return app, TestClient(app), db


@pytest.fixture
def shadow_mode(tmp_path):
    db = str(tmp_path / "s.sqlite3")
    app = create_app(db_path=db, sizing_mode="SHADOW")
    return app, TestClient(app), db


# ---- rollout modes -------------------------------------------------------------
def test_default_mode_is_shadow_and_existing_sizing_stays_authoritative(shadow_mode, monkeypatch):
    app, client, _ = shadow_mode
    monkeypatch.delenv("RISK_SIZING_V2_MODE", raising=False)
    assert create_app(db_path=str(app.state.ledger.path) + ".2").state.paper.sizing_mode == "SHADOW"
    r = post(client, "s1", stop_pct=0.10)
    assert r["accepted"], r
    trade = r["trade"]
    recs = app.state.ledger.sizing_records("s1")
    roles = {x["role"]: x for x in recs}
    assert set(roles) == {"AUTHORITATIVE", "COUNTERFACTUAL"}
    auth, cf = roles["AUTHORITATIVE"]["record"], roles["COUNTERFACTUAL"]["record"]
    assert auth["sizing_rule_version"] == "RISK-V1-LEGACY" and auth["final_quantity"] == trade["quantity"]
    assert cf["sizing_rule_version"] == "RISK-SIZING-V2.0" and cf["used_for_execution"] is False and cf["research_only"] is True
    assert cf["final_quantity"] != trade["quantity"]       # hypothetical V2 size is NOT the executed size
    assert trade["sizing_mode"] == "SHADOW" and trade["risk_policy_version"] == "RISK-V1-LEGACY"


def test_paper_mode_makes_v2_authoritative(paper):
    app, client, _ = paper
    tight = post(client, "p1", asset="SOL", stop_pct=0.01)
    assert tight["accepted"], tight
    t = tight["trade"]
    assert t["notional"] <= 500.0 + 1e-6 and t["sizing_binding_constraint"] == "POSITION_NOTIONAL_CAP"
    assert t["planned_loss_pct_equity"] < 0.005                     # 5% is a ceiling: never enlarged to use 0.50%
    wide = post(client, "p2", asset="DOGE", stop_pct=0.20)
    w = wide["trade"]
    assert wide["accepted"] and w["planned_loss_dollars"] == pytest.approx(50.0, rel=1e-3) and w["notional"] < 250
    rec = app.state.ledger.authoritative_sizing("p1")
    assert rec["used_for_execution"] is True and rec["final_quantity"] == t["quantity"] and rec["mode"] == "PAPER"
    assert t["approved_leverage"] == 1.0


@pytest.mark.parametrize("inputs,reason", [
    (None, "NO_VOLATILITY_STATE"),
    ({"depth": risk_inputs()["depth"]}, "NO_VOLATILITY_STATE"),
    ({"vol": risk_inputs()["vol"]}, "NO_LIQUIDITY_STATE"),
])
def test_paper_mode_fails_closed_without_safety_inputs(paper, inputs, reason):
    app, client, _ = paper
    r = post(client, "f1", inputs=inputs)
    assert (r["accepted"], r["reason"]) == (False, reason)
    assert app.state.ledger.sizing_records("f1")[0]["record"]["rejection_reason"] == reason
    assert client.get("/paper/positions", headers=HEADERS).json()["positions"] == []


# ---- portfolio / cluster planned risk, restart, race --------------------------------
def test_cluster_cap_holds_across_trades_and_survives_restart(paper, tmp_path):
    app, client, db = paper
    assert post(client, "c1", asset="SOL", stop_pct=0.10)["accepted"]       # 0.5% in L1_PLATFORMS
    assert post(client, "c2", asset="AVAX", stop_pct=0.10)["accepted"]      # 0.5% -> cluster full (1%)
    third = post(client, "c3", asset="ADA", stop_pct=0.10)
    assert (third["accepted"], third["reason"]) == (False, "CLUSTER_PLANNED_RISK_CAP")
    before = client.get("/risk/sizing", headers=HEADERS).json()
    restarted = TestClient(create_app(db_path=db, sizing_mode="PAPER"))     # new process view of the same database
    after = restarted.get("/risk/sizing", headers=HEADERS).json()
    assert after["open_planned_risk_dollars"] == pytest.approx(before["open_planned_risk_dollars"])
    assert after["cluster_planned_risk"]["L1_PLATFORMS"]["dollars"] == pytest.approx(100.0, rel=0.02)
    again = post(restarted, "c4", asset="ADA", stop_pct=0.10)
    assert (again["accepted"], again["reason"]) == (False, "CLUSTER_PLANNED_RISK_CAP")
    other = post(restarted, "c5", asset="DOGE", stop_pct=0.10)               # a different cluster still has room
    assert other["accepted"], other


def test_open_planned_risk_never_exceeds_2pct(paper):
    app, client, _ = paper
    for sid, asset in (("r1", "BTC"), ("r2", "SOL"), ("r3", "DOGE"), ("r4", "UNI")):
        assert post(client, sid, asset=asset, stop_pct=0.10)["accepted"]
    s = client.get("/risk/sizing", headers=HEADERS).json()
    assert s["open_planned_risk_pct"] <= 0.02 + 1e-9 and s["open_positions"] == 4
    fifth = post(client, "r5", asset="FET", stop_pct=0.10)
    assert fifth["accepted"] is False


def test_racing_signals_cannot_both_take_the_last_cluster_budget(paper, monkeypatch):
    app, client, _ = paper
    assert post(client, "x1", asset="SOL", stop_pct=0.10)["accepted"]
    real = app.state.ledger.account_state

    def slow(*a, **k):
        out = real(*a, **k)
        time.sleep(0.05)
        return out
    monkeypatch.setattr(app.state.ledger, "account_state", slow)
    results = {}
    threads = [threading.Thread(target=lambda s=s, a=a: results.__setitem__(s, post(client, s, asset=a, stop_pct=0.10)))
               for s, a in (("x2", "AVAX"), ("x3", "ADA"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(r["accepted"] for r in results.values()) == [False, True]
    s = client.get("/risk/sizing", headers=HEADERS).json()
    assert s["cluster_planned_risk"]["L1_PLATFORMS"]["dollars"] <= 100.0 + 1e-6


# ---- drawdown pause -------------------------------------------------------------
def test_15pct_drawdown_pauses_new_entries_but_open_positions_keep_being_managed(paper):
    app, client, db = paper
    assert post(client, "d1", asset="SOL", stop_pct=0.10)["accepted"]
    with sqlite3.connect(db) as conn:          # a real 16% drawdown on the account's equity curve
        conn.execute("UPDATE paper_account SET starting_equity = 8400 WHERE id = 1")
        conn.execute("INSERT INTO paper_equity (at_ms, equity, payload) VALUES (?, 10000, '{}')", (now_ms() - 60_000,))
    s = client.get("/risk/sizing", headers=HEADERS).json()
    assert s["drawdown_pause"] is True and s["drawdown_pct"] >= 0.15
    blocked = post(client, "d2", asset="DOGE", stop_pct=0.10)
    assert (blocked["accepted"], blocked["reason"]) == (False, "DRAWDOWN_RISK_PAUSE")
    t0 = app.state.ledger.trade("d1")["opened_at_ms"]
    marked = client.post("/paper/mark", headers=HEADERS, json={"instrument": "SOL-PERP", "candles": [
        {"time": t0 - t0 % 300_000 + 300_000, "open": 100, "high": 100.5, "low": 89.0, "close": 90}]}).json()
    assert [e["kind"] for e in marked["exits"]] == ["STOP"]                 # the stop still works
    shadow_mode_app = create_app(db_path=db, sizing_mode="SHADOW")         # the pause is not a PAPER-only feature
    assert TestClient(shadow_mode_app).post("/paper/signal", headers=HEADERS, json={
        "signal": signal("d3", "UNI"), "instrument": "UNI-PERP", "coin": "UNI", "mark_price": 100.0, "mark_at_ms": now_ms(),
        "requested_leverage": 1, "risk_inputs": risk_inputs()}).json()["reason"] == "DRAWDOWN_RISK_PAUSE"


# ---- TP1, immutability, outcomes --------------------------------------------------
def test_tp1_reduces_current_risk_without_touching_the_original_snapshot(paper):
    app, client, db = paper
    t = post(client, "t1", asset="SOL", stop_pct=0.10)["trade"]
    original = app.state.ledger.sizing_records("t1")[0]
    before = client.get("/risk/sizing", headers=HEADERS).json()["positions"][0]
    t0 = t["opened_at_ms"]
    client.post("/paper/mark", headers=HEADERS, json={"instrument": "SOL-PERP", "candles": [
        {"time": t0 - t0 % 300_000 + 300_000, "open": 100, "high": 110.5, "low": 99.5, "close": 110}]})
    after = client.get("/risk/sizing", headers=HEADERS).json()["positions"][0]
    assert after["planned_loss_dollars"] < before["planned_loss_dollars"] / 5          # stop at breakeven: costs only
    assert after["active_stop"] == pytest.approx(t["entry_fill"])
    assert after["original_planned_loss_dollars"] == pytest.approx(original["record"]["planned_loss_dollars"])
    again = app.state.ledger.sizing_records("t1")[0]
    assert again["record"] == original["record"] and again["record_hash_ok"] is True
    assert app.state.ledger.trade("t1")["planned_loss_dollars"] == pytest.approx(original["record"]["planned_loss_dollars"])


def test_sizing_records_are_immutable_and_outcomes_are_separate(paper):
    app, client, db = paper
    t = post(client, "o1", asset="SOL", stop_pct=0.10)["trade"]
    conn = sqlite3.connect(db)
    for sql in ("UPDATE risk_sizing_decisions SET approved=0", "DELETE FROM risk_sizing_decisions"):
        with pytest.raises(sqlite3.DatabaseError, match="SIZING_RECORD_IMMUTABLE"):
            conn.execute(sql)
    conn.close()
    t0 = t["opened_at_ms"]
    client.post("/paper/mark", headers=HEADERS, json={"instrument": "SOL-PERP", "candles": [
        {"time": t0 - t0 % 300_000 + 300_000, "open": 100, "high": 100.2, "low": 89.0, "close": 89.5}]})
    out = app.state.ledger.sizing_outcome("o1")
    assert out["exit_reason"] == "STOP" and out["realised_R"] == pytest.approx(-1.0, abs=0.35)
    assert out["realised_stop_slippage"] > 0 and out["realised_fees"] > 0 and out["mae_price"] > 0
    rec = app.state.ledger.authoritative_sizing("o1")
    outcome_fields = {"realised_fees", "realised_entry_slippage", "realised_exit_slippage", "realised_stop_slippage",
                      "realised_max_loss", "realised_R", "realised_net_pnl", "mfe_price", "mae_price", "mfe_R", "mae_R"}
    assert not outcome_fields & set(rec)                                 # outcomes never enter the decision record
    assert "realised_vol" in rec                                         # (decision-time volatility input, not an outcome)
    with pytest.raises(sqlite3.DatabaseError, match="SIZING_RECORD_IMMUTABLE"):
        sqlite3.connect(db).execute("UPDATE risk_sizing_outcomes SET record='{}'")


def test_sizing_records_are_in_the_backed_up_paper_database(paper, tmp_path):
    from market_edge_exec.persistence import migrations
    app, client, db = paper
    t = post(client, "b1", asset="SOL", stop_pct=0.10)["trade"]
    t0 = t["opened_at_ms"]
    client.post("/paper/mark", headers=HEADERS, json={"instrument": "SOL-PERP", "candles": [
        {"time": t0 - t0 % 300_000 + 300_000, "open": 100, "high": 100.2, "low": 89.0, "close": 89.5}]})
    copy = migrations.backup_database(db, str(tmp_path / "backup.sqlite3"))   # what the desktop backup runs (backup-db)
    info = migrations.inspect_database(copy)                                  # what restore validates
    assert info["ok"] and info["counts"]["risk_sizing_decisions"] == 1 and info["counts"]["risk_sizing_outcomes"] == 1
    assert info["risk_policy_versions"] == ["RISK-SIZING-V2.0"]
    with sqlite3.connect(copy) as c:
        record = c.execute("SELECT record FROM risk_sizing_decisions").fetchone()[0]
        assert '"cluster_id": "L1_PLATFORMS"' in record and '"planned_loss_dollars"' in record
        with pytest.raises(sqlite3.DatabaseError, match="SIZING_RECORD_IMMUTABLE"):   # still immutable in the copy
            c.execute("DELETE FROM risk_sizing_decisions")


# ---- shadow counterfactual -------------------------------------------------------
def test_shadow_counterfactual_sizing_consumes_no_capital(paper):
    app, client, db = paper
    assert post(client, "k1", asset="SOL", stop_pct=0.10)["accepted"]
    acct = client.get("/paper/account", headers=HEADERS).json()
    records = app.state.ledger.sizing_counts()
    ts = now_ms()
    obs = [{"kind": "CANDIDATE", "asset": a, "coin": a, "decision": {
        "market": {"price": 100.0, "data_age_ms": 60_000}, "candidate": {"direction": "long", "strategy": "TREND CONTINUATION",
                                                                          "entry": 100.0, "stop": 95.0, "tp1": 105.0, "tp2": 110.0}}}
           for a in ("AVAX", "ADA", "BTC", "DOGE", "PEPE", "UNI")]
    payload = {"scan": {"scan_id": "scan-cf", "decision_ts": ts, "generator_version": "g", "feature_version": "f",
                        "execution": {"decision": "NO_SIGNAL"}, "risk_inputs": {a: {"vol": risk_inputs()["vol"]} for a in ("AVAX", "ADA", "BTC", "DOGE", "PEPE", "UNI")}},
               "observations": obs}
    assert client.post("/shadow/scan", headers=HEADERS, json=payload).status_code == 200
    rows = app.state.shadow.observations(limit=100)
    assert len(rows) == 6
    for row in rows:
        cf = app.state.shadow.observation(row["observation_id"])["DECISION_TIME_DATA"]["counterfactual_sizing"]
        assert cf["consumes_capital"] is False and cf["used_for_execution"] is False and cf["sizing_rule_version"] == "RISK-SIZING-V2.0"
        assert cf["approved"] and cf["final_notional"] <= 500 + 1e-9
        assert cf["liquidity_status"].startswith("UNAVAILABLE")
    avax = next(app.state.shadow.observation(r["observation_id"]) for r in rows if r["asset"] == "AVAX")
    assert avax["DECISION_TIME_DATA"]["counterfactual_sizing"]["existing_cluster_planned_risk"] > 0   # sees SOL's real open risk
    after = client.get("/paper/account", headers=HEADERS).json()
    for key in ("equity", "open_positions", "open_notional", "realized_pnl"):
        assert after[key] == acct[key]
    assert app.state.ledger.sizing_counts() == records                     # no reservation or record in the paper ledger
    assert client.get("/risk/sizing", headers=HEADERS).json()["open_positions"] == 1


def test_risk_sizing_status_reports_policy_and_positions(paper):
    app, client, _ = paper
    post(client, "u1", asset="SOL", stop_pct=0.10)
    s = client.get("/risk/sizing", headers=HEADERS).json()
    assert s["mode"] == "PAPER" and s["kelly"] == "OFF" and s["live"] == "DISABLED"
    p = s["policy"]
    assert (p["base_risk_pct"], p["max_position_notional_pct"], p["max_portfolio_gross_pct"], p["max_open_planned_risk_pct"],
            p["max_cluster_planned_risk_pct"], p["max_positions"], p["max_leverage"]) == (0.005, 0.05, 0.20, 0.02, 0.01, 4, 1.0)
    pos = s["positions"][0]
    for key in ("notional", "notional_pct_equity", "planned_loss_dollars", "planned_loss_pct_equity", "stop_distance_pct",
                "cluster_id", "binding_constraint", "position_leverage"):
        assert pos[key] is not None, key
    assert s["gross_exposure_multiple"] == pytest.approx(pos["notional"] / s["equity"], rel=0.01)
