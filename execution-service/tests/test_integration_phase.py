"""Final integration phase: the pieces that only exist once shadow learning,
the open-position monitor / Trade Detail and backup meet.

- an executed paper trade links to its shadow observation by stable ids
- the hindsight overlay comes from the linked observation only after the
  trade closed AND the 72h window resolved; the original decision record
  never changes
- shadow recording (incl. research-supplement scans outside the production
  universe) cannot touch paper capital, exposure, orders or LIVE
- chart candles (lowest priority) are cached and back off after HTTP 429
- the shadow research database has its own consistent backup/validate path
"""
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import PAPER_ONLY, create_app
from market_edge_exec.paper.candles import CachedCandleFetcher, trade_candles
from market_edge_exec.risk.engine import RiskLimits
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow import resolve as R
from market_edge_exec.shadow import store as shadow_store

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
WIDE_LIMITS = RiskLimits(max_initial_position_notional_pct=100.0, max_portfolio_exposure_pct=100.0)
LIVE = "HYPERLIQUID_ALLMIDS_LIVE"
BAR = C.BAR_MS
T0 = 1_790_000_000_000 - 1_790_000_000_000 % BAR + 60_000
VERSIONS = {"generator_version": "scan-core@test", "feature_version": "shadow-features-v1", "model_version": "QUANT_ONLY"}
SERVICE = pathlib.Path(__file__).resolve().parents[1]


def now_ms():
    return int(time.time() * 1000)


def open_trade(app, sid="sig-1"):
    t = now_ms() - 60_000
    signal = {"signal_id": sid, "asset": "ETH", "direction": "long", "timestamp": t, "entry": 100.0, "stop": 90.0,
              "targets": [110.0, 120.0], "strategy_id": "TREND CONTINUATION", "quant_score": 72}
    result = app.state.paper.open_from_signal(signal, "ETH-PERP", 100.0, t, now_ms=t,
                                              meta={"rank": 1, "scan_id": "scan-link", "quant_score": 72, "rr1": 1.0, "rr2": 2.0},
                                              market_price_source=LIVE)
    assert result.accepted, result.reason
    return result.trade


def shadow_scan(signal_id=None, decision="EXECUTED", scan_id="scan-link", ts=T0, scope=None, asset="ETH"):
    cand = {"direction": "long", "strategy": "TREND CONTINUATION", "entry": 100.0, "stop": 98.0, "tp1": 102.0, "tp2": 104.0,
            "rr1": 1.0, "quant_score": 72, "production_rank": 1, "is_production_pick": True, "scan_candidate_rank": 1}
    dec = {"market": {"price": 100.0, "data_age_ms": 60_000, "venue": "HYPERLIQUID"}, "features": {"h1": {"atr": 0.5}}, "candidate": cand}
    scan = {"scan_id": scan_id, "decision_ts": ts, "scan_status": "BEST_TRADE_NOW", "n_markets": 1, "submitted_signal_id": signal_id,
            "execution": {"decision": decision, "signal_id": signal_id, "trade": {"signal_id": signal_id}} if signal_id else {"decision": "NO_SIGNAL"},
            **VERSIONS}
    if scope:
        scan["scan_scope"] = scope
    return {"scan": scan, "observations": [
        {"kind": "CANDIDATE", "asset": asset, "coin": asset, "submitted": bool(signal_id), "production_state": "RANKED_WITH_GEOMETRY", "decision": dec},
        {"kind": "MARKET_STATE", "asset": asset, "coin": asset, "production_state": "NO_TRADE",
         "decision": {k: v for k, v in dec.items() if k != "candidate"}}]}


def full_window_bars(start):
    n = C.FULL_WINDOW_MS // BAR + 2
    out, prev = [], 100.0
    for i in range(n):
        c = 100 + min(i, 60) * 0.1
        out.append({"time": start + i * BAR, "open": prev, "high": max(prev, c) + 0.05, "low": min(prev, c) - 0.05, "close": c})
        prev = c
    return out


# ---- shadow <-> trade detail -------------------------------------------------
def test_trade_detail_links_shadow_observation_and_hindsight_waits_for_close_and_resolution(tmp_path):
    app = create_app(db_path=str(tmp_path / "paper.sqlite3"), risk_limits=WIDE_LIMITS, candle_fetcher=lambda *a: [])
    client = TestClient(app)
    trade = open_trade(app)
    app.state.shadow.record_scan(shadow_scan(signal_id="sig-1"))

    d = client.get("/paper/trade", params={"trade_id": trade["trade_id"]}, headers=HEADERS).json()
    link = d["shadow"]
    assert link["linked"] is True and link["observation_id"].startswith("obs-") and link["scan_id"] == "scan-link"
    obs = app.state.shadow.observation(link["observation_id"])
    assert obs["execution_status"] == "EXECUTED" and obs["kind"] == "CANDIDATE"
    # no future label before its window: nothing resolved, all 10 horizons pending
    assert link["resolved_horizons"] == [] and link["pending_horizons"] == list(C.HORIZONS)
    assert d["hindsight"]["available"] is False and d["hindsight"]["reason"] == "OUTCOME_NOT_RESOLVED"
    original = d["decision"]

    # close the trade at the stop: still no hindsight until the 72h window resolves
    app.state.paper.tick("ETH-PERP", 89.0, now_ms(), LIVE, trigger="POLL_HEARTBEAT")
    d = client.get("/paper/trade", params={"trade_id": trade["trade_id"]}, headers=HEADERS).json()
    assert d["status"] == "CLOSED"
    assert d["hindsight"]["available"] is False and d["hindsight"]["reason"] == "NO_RESOLVED_RESEARCH_LABEL"

    app.state.shadow.resolve("ETH", full_window_bars(R.first_bar_open(T0)), "HYPERLIQUID", "5m", now_ms=T0 + C.FULL_WINDOW_MS + C.HOUR)
    d = client.get("/paper/trade", params={"trade_id": trade["trade_id"]}, headers=HEADERS).json()
    assert d["shadow"]["resolved_horizons"] == list(C.HORIZONS) and d["shadow"]["pending_horizons"] == []
    hs = d["hindsight"]
    assert hs["available"] is True and hs["known_at_decision_time"] is False
    assert hs["source"] == f"SHADOW_OBSERVATION:{link['observation_id']}"
    assert set(hs["levels"]) == {"optimal_entry", "optimal_tp1", "optimal_tp2", "optimal_exit"}
    assert hs["diagnostics"]["classification_status"] == "DIAGNOSTIC_UNVALIDATED"
    # research never overwrote the original decision-time record
    assert d["decision"] == {**original, "execution_status": "CLOSED"}
    assert "post_outcome" not in d["shadow"]


def test_trade_without_shadow_observation_reports_unlinked(tmp_path):
    app = create_app(db_path=str(tmp_path / "paper.sqlite3"), risk_limits=WIDE_LIMITS, candle_fetcher=lambda *a: [])
    trade = open_trade(app)
    d = TestClient(app).get("/paper/trade", params={"trade_id": trade["trade_id"]}, headers=HEADERS).json()
    assert d["shadow"] == {"linked": False, "reason": "NO_SHADOW_OBSERVATION_FOR_THIS_SIGNAL"}


def test_research_supplement_scan_cannot_touch_capital_exposure_orders_or_live(tmp_path):
    app = create_app(db_path=str(tmp_path / "paper.sqlite3"), risk_limits=WIDE_LIMITS)
    client = TestClient(app)
    before = client.get("/paper/account", headers=HEADERS).json()
    orders_before = len(app.state.store.orders())
    payload = shadow_scan(scan_id="research-scan-9", scope="RESEARCH_SUPPLEMENT", asset="BCH")
    payload["scan"]["execution"] = {"decision": "NOT_APPLICABLE", "reason": "OUTSIDE_PRODUCTION_UNIVERSE"}
    for o in payload["observations"]:
        o["production_state"] = "OUTSIDE_PRODUCTION_UNIVERSE"
    assert client.post("/shadow/scan", json=payload, headers=HEADERS).json()["inserted"] == 2
    after = client.get("/paper/account", headers=HEADERS).json()
    for key in ("equity", "open_notional", "open_positions", "exposure_pct", "gross_exposure_multiple"):
        assert after[key] == before[key], key
    assert len(app.state.store.orders()) == orders_before
    assert client.get("/paper/open", headers=HEADERS).json()["trades"] == []
    assert PAPER_ONLY is True and client.get("/health").json()["paper_only"] is True
    rows = app.state.shadow.observations()
    assert {r["production_state"] for r in rows} == {"OUTSIDE_PRODUCTION_UNIVERSE"}
    assert {r["execution_status"] for r in rows} == {"NOT_SUBMITTED", "NOT_APPLICABLE"}
    summary = client.get("/shadow/summary", params={"since_ms": 0}, headers=HEADERS).json()
    assert summary["research_supplement_observations"] == 2 and summary["observations_by_asset"] == {"BCH": 2}


def test_gross_exposure_is_open_notional_over_equity_not_position_leverage(tmp_path):
    app = create_app(db_path=str(tmp_path / "paper.sqlite3"), risk_limits=WIDE_LIMITS)
    open_trade(app)
    a = TestClient(app).get("/paper/account", headers=HEADERS).json()
    assert a["gross_exposure_multiple"] == pytest.approx(a["open_notional"] / a["equity"])
    assert a["effective_leverage"] == a["gross_exposure_multiple"]          # old key kept, same value
    assert a["exposure_pct"] == pytest.approx(a["gross_exposure_multiple"] * 100)


# ---- chart candles: lowest-priority requests ---------------------------------
def test_chart_candles_are_cached_and_back_off_after_429():
    clock = [0.0]
    calls = []

    def fetcher(coin, interval, start, end):
        calls.append((coin, interval, start, end))
        if len(calls) == 2:
            raise RuntimeError("Client error '429 Too Many Requests'")
        return [{"t": start, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]

    f = CachedCandleFetcher(fetcher, ttl_s=15, cooldown_s=60, clock=lambda: clock[0])
    f("ETH", "5m", 0, 10_000)
    f("ETH", "5m", 0, 11_000)                         # same TTL bucket: served from memory
    assert len(calls) == 1
    clock[0] = 20.0
    with pytest.raises(RuntimeError, match="429"):
        f("ETH", "5m", 0, 40_000)
    clock[0] = 30.0
    with pytest.raises(RuntimeError, match="RATE_LIMITED_DEFERRED"):
        f("ETH", "5m", 0, 50_000)                     # cooling down: no request made
    assert len(calls) == 2
    clock[0] = 81.0
    f("ETH", "5m", 0, 90_000)
    assert len(calls) == 3
    trade = {"coin": "ETH", "asset": "ETH", "opened_at_ms": 1_790_000_000_000, "closed_at_ms": None}
    blocked = CachedCandleFetcher(lambda *a: (_ for _ in ()).throw(RuntimeError("HTTP 429")), clock=lambda: 0.0)
    out = trade_candles(trade, "5m", 1_790_000_600_000, blocked)
    assert out["available"] is False and "429" in out["reason"] and out["candles"] == []


# ---- shadow database backup / validation ------------------------------------
def run_service(*args):
    proc = subprocess.run([sys.executable, str(SERVICE / "run_server.py"), *args], capture_output=True, text=True, cwd=SERVICE,
                          env={**os.environ, "PYTHONPATH": str(SERVICE)})
    return proc.returncode, json.loads(proc.stdout.strip().splitlines()[-1])


def test_backup_shadow_db_is_a_consistent_validated_copy_and_restores(tmp_path):
    src = tmp_path / "market_edge_shadow_research.sqlite3"
    store = shadow_store.ShadowStore(str(src))
    store.record_scan(shadow_scan(scan_id="scan-a"))
    code, info = run_service("backup-shadow-db", str(src), str(tmp_path / "copy.sqlite3"))
    assert code == 0 and info["ok"] is True, info
    assert info["counts"]["shadow_observations"] == 2 and info["counts"]["shadow_scans"] == 1
    assert info["dataset_versions"] == [C.DATASET_RAW] and info["shadow_schema_version"] == C.SHADOW_SCHEMA_VERSION
    # mutate the live store, then "restore" by swapping in the backup copy
    store.record_scan(shadow_scan(scan_id="scan-b", ts=T0 + 10 * BAR))
    assert store.summary(since_ms=0)["observations"] == 4
    os.replace(tmp_path / "copy.sqlite3", src)
    for side in ("-wal", "-shm"):
        pathlib.Path(f"{src}{side}").unlink(missing_ok=True)
    restored = shadow_store.ShadowStore(str(src))
    assert restored.summary(since_ms=0)["observations"] == 2
    # immutability survives the copy
    with pytest.raises(sqlite3.DatabaseError, match="IMMUTABLE"):
        with sqlite3.connect(src) as conn:
            conn.execute("DELETE FROM shadow_observations")


def test_validate_shadow_db_rejects_foreign_or_paper_databases(tmp_path):
    junk = tmp_path / "junk.sqlite3"
    junk.write_bytes(b"not sqlite at all" * 100)
    code, info = run_service("validate-shadow-db", str(junk))
    assert code == 1 and info["ok"] is False
    paper = tmp_path / "paper.sqlite3"
    create_app(db_path=str(paper), shadow_db_path=str(tmp_path / "s.sqlite3"))
    code, info = run_service("validate-shadow-db", str(paper))
    assert code == 1 and any("MISSING_TABLES" in p for p in info["problems"])


def test_shadow_backup_contains_no_service_secret(tmp_path):
    os.environ["MARKET_EDGE_EXEC_API_KEY"] = "secret-key-do-not-export-1234567890"
    try:
        src = tmp_path / "s.sqlite3"
        shadow_store.ShadowStore(str(src)).record_scan(shadow_scan(scan_id="scan-s"))
        code, _ = run_service("backup-shadow-db", str(src), str(tmp_path / "b.sqlite3"))
        assert code == 0
        assert b"secret-key-do-not-export" not in (tmp_path / "b.sqlite3").read_bytes()
    finally:
        os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
