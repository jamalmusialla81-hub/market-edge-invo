"""Universal shadow learning: observation != execution. Every test here runs
against a real ShadowStore (its own SQLite file) and, where it matters, the
real paper app, to prove shadow rows never touch paper capital."""
import ast
import os
import pathlib
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow import resolve as R
from market_edge_exec.shadow import stats
from market_edge_exec.shadow.store import ShadowStore

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
BAR = C.BAR_MS
T0 = 1_790_000_000_000 - 1_790_000_000_000 % BAR + 60_000   # a scan one minute into a 5m bar
VERSIONS = {"generator_version": "scan-core@test", "feature_version": "shadow-features-v1", "model_version": "quant-only"}


def candidate(direction="long", strategy="TREND CONTINUATION", entry=100.0, stop=98.0, tp1=102.0, tp2=104.0, rank=1, pick=True, scan_rank=1):
    return {"direction": direction, "strategy": strategy, "entry": entry, "stop": stop, "tp1": tp1, "tp2": tp2, "rr1": 1.0,
            "quant_score": 70, "production_rank": rank if pick else None, "is_production_pick": pick, "scan_candidate_rank": scan_rank}


def decision(price=100.0, age_ms=60_000, cand=None, atr=0.5):
    d = {"market": {"price": price, "data_age_ms": age_ms, "venue": "HYPERLIQUID"},
         "features": {"h1": {"atr": atr, "rsi": 55.0, "ret_1": 0.001}}, "regime": "UPTREND"}
    if cand is not None:
        d["candidate"] = cand
    return d


def scan_payload(scan_id="scan-1", ts=T0, observations=None, execution=None, submitted_signal_id=None):
    return {"scan": {"scan_id": scan_id, "decision_ts": ts, "scan_status": "BEST_TRADE_NOW", "n_markets": 2,
                     "submitted_signal_id": submitted_signal_id, "execution": execution or {"decision": "NO_SIGNAL"}, **VERSIONS},
            "observations": observations or []}


def bars_path(start, closes, spread=0.2):
    """5m bars from `start`, each opening at the previous close."""
    out, prev = [], closes[0]
    for i, c in enumerate(closes):
        out.append({"time": start + i * BAR, "open": prev, "high": max(prev, c) + spread, "low": min(prev, c) - spread, "close": c})
        prev = c
    return out


@pytest.fixture
def store(tmp_path):
    return ShadowStore(str(tmp_path / "shadow.sqlite3"))


def obs_rows(store):
    return {(o["asset"], o["kind"], o["direction"], o["strategy"]): o for o in store.observations(limit=1000)}


# ---- recording: everything, not only the selected trade --------------------
def test_rejected_entries_paused_signal_is_still_a_shadow_observation(store):
    p = scan_payload(submitted_signal_id="scan-1-BTC", execution={"decision": "REJECTED", "reason": "ENTRIES_PAUSED", "signal_id": "scan-1-BTC"},
                     observations=[{"kind": "CANDIDATE", "asset": "BTC", "submitted": True, "decision": decision(cand=candidate())}])
    store.record_scan(p)
    row = obs_rows(store)[("BTC", "CANDIDATE", "long", "TREND CONTINUATION")]
    assert row["execution_status"] == "REJECTED" and row["execution_rejection_reason"] == "ENTRIES_PAUSED"
    assert row["research_candidate_valid"] == 1 and row["resolution_status"] == "PENDING"


@pytest.mark.parametrize("reason", ["POSITION_EXPOSURE_CAP", "PORTFOLIO_EXPOSURE_CAP", "MAX_CONCURRENT_POSITIONS_EXCEEDED",
                                    "DUPLICATE_INSTRUMENT", "STALE_MARKET_DATA", "NO_MARKET_PRICE"])
def test_every_execution_rejection_reason_is_kept_separate_from_research_validity(store, reason):
    store.record_scan(scan_payload(submitted_signal_id="s", execution={"decision": "REJECTED", "reason": reason},
                                   observations=[{"kind": "CANDIDATE", "asset": "ETH", "submitted": True, "decision": decision(cand=candidate())}]))
    row = store.observations()[0]
    assert (row["execution_status"], row["execution_rejection_reason"], row["research_candidate_valid"]) == ("REJECTED", reason, 1)


def test_rank_2_and_3_and_other_side_candidates_are_all_tracked(store):
    obs = [{"kind": "CANDIDATE", "asset": "BTC", "submitted": True, "decision": decision(cand=candidate(rank=1))},
           {"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate("short", "MEAN REVERSION", stop=102.0, tp1=98.0, tp2=96.0, pick=False, scan_rank=4)),
            "not_submitted_reason": "NOT_ASSET_PICK"},
           {"kind": "CANDIDATE", "asset": "ETH", "decision": decision(cand=candidate(rank=2, scan_rank=2)), "not_submitted_reason": "RANK_BELOW_SELECTED"},
           {"kind": "CANDIDATE", "asset": "SOL", "decision": decision(cand=candidate(rank=3, scan_rank=3)), "not_submitted_reason": "RANK_BELOW_SELECTED"}]
    store.record_scan(scan_payload(submitted_signal_id="scan-1-BTC", execution={"decision": "EXECUTED", "signal_id": "scan-1-BTC", "trade": {"notional": 500}},
                                   observations=obs))
    rows = obs_rows(store)
    assert rows[("ETH", "CANDIDATE", "long", "TREND CONTINUATION")]["production_rank"] == 2
    assert rows[("SOL", "CANDIDATE", "long", "TREND CONTINUATION")]["production_rank"] == 3
    assert rows[("BTC", "CANDIDATE", "short", "MEAN REVERSION")]["execution_status"] == "NOT_SUBMITTED"
    assert rows[("BTC", "CANDIDATE", "long", "TREND CONTINUATION")]["execution_status"] == "EXECUTED"
    assert store.summary(since_ms=0)["paper_executed"] == 1


def test_no_trade_scan_and_no_trade_market_states_are_recorded(store):
    obs = [{"kind": "MARKET_STATE", "asset": a, "production_state": "NO_TRADE", "decision": decision()} for a in ("BTC", "ETH")]
    store.record_scan(scan_payload(observations=obs))
    s = store.summary(since_ms=0)
    assert s["scans"] == 1 and s["no_trade_scans"] == 1 and s["no_trade_states"] == 2
    assert {o["execution_status"] for o in store.observations()} == {"NOT_APPLICABLE"}


def test_recording_the_same_scan_twice_is_idempotent(store):
    p = scan_payload(observations=[{"kind": "MARKET_STATE", "asset": "BTC", "decision": decision()}])
    assert store.record_scan(p)["inserted"] == 1
    assert store.record_scan(p)["duplicate"] is True
    assert len(store.observations()) == 1


# ---- integrity ------------------------------------------------------------
def test_decision_snapshot_is_immutable_and_hash_verified(store):
    store.record_scan(scan_payload(observations=[{"kind": "MARKET_STATE", "asset": "BTC", "decision": decision()}]))
    oid = store.observations()[0]["observation_id"]
    conn = sqlite3.connect(store.path)
    for sql in ("UPDATE shadow_observations SET execution_status='EXECUTED'", "DELETE FROM shadow_observations",
                "UPDATE shadow_scans SET scan_state='X'"):
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            conn.execute(sql)
    conn.close()
    assert store.observation(oid)["decision_hash_ok"] is True


def test_future_labels_are_unavailable_before_the_window_closes(store):
    store.record_scan(scan_payload(observations=[{"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate())}]))
    oid = store.observations()[0]["observation_id"]
    first = R.first_bar_open(T0)
    path = bars_path(first, [100.0] * 30)
    # 90 minutes after the scan: even the 2h batch window is still open.
    store.resolve("BTC", path[:18], "HYPERLIQUID", "5m", now_ms=T0 + 90 * 60_000)
    got = store.observation(oid)
    assert got["FUTURE_LABEL_DATA"] == {} and got["POST_OUTCOME_RESEARCH_ONLY"] is None
    assert store.pending(now_ms=T0 + 90 * 60_000) == []


def test_hindsight_fields_are_rejected_as_model_features(store):
    for bad in (["features.h1.rsi", "optimal_entry"], ["mfe_r"], ["best_achievable_r"], ["policy_r"], ["classification"],
                ["features.future_close"], ["executable_within_stop_r"]):
        with pytest.raises(C.LeakageError):
            store.training_rows(bad)
    store.training_rows(["features.h1.rsi", "features.h1.atr", "regime"])   # decision-time paths are fine


def test_hindsight_field_inside_decision_time_data_is_refused_at_ingest(tmp_path):
    client = TestClient(create_app(db_path=str(tmp_path / "p.sqlite3")))
    d = decision(cand=candidate())
    d["features"]["mfe_24h"] = 0.03
    r = client.post("/shadow/scan", headers=HEADERS, json=scan_payload(observations=[{"kind": "CANDIDATE", "asset": "BTC", "decision": d}]))
    assert r.status_code == 422 and r.json()["detail"]["reason"] == "LEAKAGE_GUARD"
    assert client.get("/shadow/observations", headers=HEADERS).json()["observations"] == []


def test_every_emitted_label_key_is_known_to_the_leakage_guard():
    first = R.first_bar_open(T0)
    bars = bars_path(first, [100 + i * .05 for i in range(300)])
    d = decision(cand=candidate())
    lab = R.candidate_horizon(d, bars, T0, 300 * BAR)
    ms = R.market_state_horizon(bars, T0, 300 * BAR)
    h = R.hindsight("CANDIDATE", d, bars, "NOT_SUBMITTED", lab)
    for key in [*lab, *ms, *h]:
        assert C.is_hindsight_name(key), key


# ---- labels ----------------------------------------------------------------
def test_mfe_mae_and_touch_order_are_computed_from_the_same_venue_path():
    first = R.first_bar_open(T0)
    # open 100 -> dips to 99.0 at bar 2 -> rallies to 103.5 at bar 5 -> closes 103
    bars = [{"time": first + i * BAR, "open": o, "high": h, "low": l, "close": c} for i, (o, h, l, c) in enumerate(
        [(100, 100.3, 99.8, 100), (100, 100.1, 99.5, 99.6), (99.6, 99.7, 99.0, 99.2), (99.2, 101, 99.1, 100.9),
         (100.9, 102.2, 100.8, 102), (102, 103.5, 101.9, 103)])]
    lab = R.candidate_horizon(decision(cand=candidate()), bars, T0, 6 * BAR)
    assert lab["mfe_pct"] == pytest.approx(0.035) and lab["mae_pct"] == pytest.approx(0.01)
    assert lab["time_to_mfe_ms"] == 5 * BAR and lab["time_to_mae_ms"] == 2 * BAR
    assert lab["stop_hit"] is False and lab["tp1_hit_at"] == first + 4 * BAR and lab["tp2_hit"] is False
    assert lab["first_touch_order"] == "TP1"
    risk = lifecycle_entry(100) - 98.0
    assert lab["mfe_r"] == pytest.approx(3.5 / risk, rel=1e-3)
    # TP1 took half at 102 (stop -> breakeven); the rest is marked to the last close.
    assert lab["policy_status"] == "OPEN_AT_HORIZON" and lab["policy_r"] > 0


def lifecycle_entry(price):
    from market_edge_exec.paper import lifecycle
    return lifecycle.slipped(price, "buy")


def test_stop_first_ambiguity_is_preserved_not_resolved_optimistically():
    first = R.first_bar_open(T0)
    bars = [{"time": first, "open": 100, "high": 100.2, "low": 99.9, "close": 100},
            {"time": first + BAR, "open": 100, "high": 102.5, "low": 97.5, "close": 100}]   # spans stop 98 and TP1 102
    lab = R.candidate_horizon(decision(cand=candidate()), bars, T0, 2 * BAR)
    assert lab["first_touch_order"] == "STOP_TP1_SAME_BAR_AMBIGUOUS" and lab["stop_tp_same_bar_ambiguous"] is True
    assert lab["policy_status"] == "CLOSED_STOP" and lab["policy_r"] < -1   # stop-first, costs included
    assert R.classify("CANDIDATE", "NOT_SUBMITTED", None, lab, {}) == "AMBIGUOUS"


def test_outcomes_must_come_from_the_same_venue_and_interval(store):
    for venue, interval in (("BINANCE", "5m"), ("HYPERLIQUID", "1m"), (None, None)):
        with pytest.raises(ValueError, match="SHADOW_OUTCOMES_REQUIRE_HYPERLIQUID_5m"):
            store.resolve("BTC", [], venue, interval, now_ms=T0)


def test_stale_snapshot_is_not_resolvable_and_gaps_are_never_filled(store):
    store.record_scan(scan_payload(observations=[
        {"kind": "CANDIDATE", "asset": "BTC", "decision": decision(age_ms=C.MAX_SNAPSHOT_AGE_MS + 1, cand=candidate())},
        {"kind": "CANDIDATE", "asset": "ETH", "decision": decision(price=None, cand=candidate())},
        {"kind": "CANDIDATE", "asset": "SOL", "decision": decision(cand=candidate())}]))
    rows = {o["asset"]: o for o in store.observations()}
    assert (rows["BTC"]["research_candidate_valid"], rows["BTC"]["invalid_reason"], rows["BTC"]["resolution_status"]) == (0, "STALE_SNAPSHOT", "NOT_RESOLVABLE_INVALID_SNAPSHOT")
    assert rows["ETH"]["invalid_reason"] == "NO_MARKET_PRICE"
    first = R.first_bar_open(T0)
    path = bars_path(first, [100.0] * 40)
    del path[10]                                   # one missing bar inside the 1h/2h windows
    now = T0 + 3 * C.HOUR
    store.resolve("SOL", path, "HYPERLIQUID", "5m", now_ms=now)
    b1 = store.observation(rows["SOL"]["observation_id"])["FUTURE_LABEL_DATA"]["B1"]
    assert b1["label_status"] == "PARTIAL_UNRESOLVED"
    assert b1["labels"]["15m"]["label_status"] == "OK" and b1["labels"]["30m"]["label_status"] == "OK"
    assert b1["labels"]["1h"]["label_status"] == "UNRESOLVED_MISSING_CANDLE" and b1["labels"]["2h"]["missing_bars"] == 1


def test_candles_that_do_not_cover_a_window_leave_it_pending_not_unresolved(store):
    store.record_scan(scan_payload(observations=[{"kind": "MARKET_STATE", "asset": "BTC", "decision": decision()}]))
    first = R.first_bar_open(T0)
    late = bars_path(first + 6 * BAR, [100.0] * 40)          # starts after the first bar
    store.resolve("BTC", late, "HYPERLIQUID", "5m", now_ms=T0 + 3 * C.HOUR)
    assert store.observations()[0]["resolution_status"] == "PENDING"
    store.resolve("BTC", bars_path(first, [100.0] * 40), "HYPERLIQUID", "5m", now_ms=T0 + 3 * C.HOUR)
    assert store.observations()[0]["resolution_status"] == "PARTIAL"


def test_full_resolution_writes_all_batches_hindsight_and_classification(store):
    store.record_scan(scan_payload(observations=[
        {"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate())},
        {"kind": "MARKET_STATE", "asset": "BTC", "production_state": "NO_TRADE", "decision": decision()}]))
    first = R.first_bar_open(T0)
    n = C.FULL_WINDOW_MS // BAR + 2
    closes = [100 + min(i, 60) * 0.1 for i in range(n)]          # steady rally to 106, then flat
    store.resolve("BTC", bars_path(first, closes, spread=0.05), "HYPERLIQUID", "5m", now_ms=T0 + C.FULL_WINDOW_MS + C.HOUR)
    rows = {o["kind"]: o for o in store.observations()}
    cand = store.observation(rows["CANDIDATE"]["observation_id"])
    assert rows["CANDIDATE"]["resolution_status"] == "RESOLVED" and set(cand["FUTURE_LABEL_DATA"]) == {"B1", "B2", "B3", "B4"}
    h = cand["POST_OUTCOME_RESEARCH_ONLY"]
    assert h["classification"] == "GOOD_TRADE_MISSED" and h["classification_status"] == "DIAGNOSTIC_UNVALIDATED"
    assert h["best_direction"] == "long" and h["optimal_long_net_pct"] < h["theoretical_long_move_pct"]   # executable < theoretical
    assert 0 < h["strategy_efficiency"] <= 1.0 + 1e-9
    assert len(cand["FUTURE_LABEL_DATA"]["B4"]["labels"]["72h"]["excursion_path"]) == 72
    state = store.observation(rows["MARKET_STATE"]["observation_id"])["POST_OUTCOME_RESEARCH_ONLY"]
    assert state["classification"] == "MISSED_OPPORTUNITY" and state["long_opportunity"] is True
    s = store.summary(since_ms=0)
    assert s["missed_opportunities"] == 2 and s["resolved"] == 2
    rows_ = store.training_rows(["features.h1.rsi"])["rows"]
    assert len(rows_) == 1 and rows_[0]["target"] == h["current_policy_outcome_r"]


def test_flat_market_is_a_correct_no_trade():
    first = R.first_bar_open(T0)
    bars = bars_path(first, [100.0] * 300, spread=0.05)
    h = R.hindsight("MARKET_STATE", {"features": {"h1": {"atr": 0.5}}, "production_state": "NO_TRADE"}, bars, "NOT_APPLICABLE", None)
    assert h["classification"] == "NO_TRADE_CORRECT" and h["best_direction"] == "NONE"


# ---- correlation -----------------------------------------------------------
def test_overlapping_observations_are_clustered_not_counted_as_independent(store):
    for i, ts in enumerate([T0, T0 + BAR, T0 + 2 * BAR, T0 + 3 * C.HOUR]):
        store.record_scan(scan_payload(scan_id=f"scan-{i}", ts=ts, observations=[{"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate())}]))
    rows = sorted(store.observations(), key=lambda o: o["decision_ts"])
    assert rows[0]["observation_cluster_id"] == rows[1]["observation_cluster_id"] == rows[2]["observation_cluster_id"]
    assert rows[3]["observation_cluster_id"] != rows[0]["observation_cluster_id"]
    assert rows[0]["overlap_fraction"] == 0 and rows[1]["overlap_fraction"] == pytest.approx(1 - BAR / C.OVERLAP_WINDOW_MS)
    assert len({r["market_episode_id"] for r in rows}) >= 1
    ev = [{"cluster": r["observation_cluster_id"], "v": 1.0 if j < 3 else -1.0} for j, r in enumerate(rows)]
    assert stats.effective_sample(ev) == {"rows": 4, "groups": 2, "group_key": "cluster", "rows_per_group": 2.0}
    boot = stats.grouped_bootstrap(ev, lambda r: r["v"])
    assert boot["groups"] == 2 and boot["mean"] == 0.0     # 3 correlated wins count once, not three times


# ---- isolation from paper capital and execution ----------------------------
def test_shadow_observations_cannot_touch_paper_equity_exposure_or_orders(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"))
    client = TestClient(app)
    before_acct = client.get("/paper/account", headers=HEADERS).json()
    before_intents = sqlite3.connect(str(tmp_path / "p.sqlite3")).execute("SELECT COUNT(*) FROM intents").fetchone()[0]
    obs = [{"kind": "CANDIDATE", "asset": a, "decision": decision(cand=candidate())} for a in ("BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX")]
    assert client.post("/shadow/scan", headers=HEADERS, json=scan_payload(observations=obs)).status_code == 200
    first = R.first_bar_open(T0)
    path = bars_path(first, [100 + i * .05 for i in range(C.FULL_WINDOW_MS // BAR + 2)])
    for a in ("BTC", "ETH", "SOL"):
        client.post("/shadow/resolve", headers=HEADERS, json={"coin": a, "venue": "HYPERLIQUID", "interval": "5m", "candles": path,
                                                             "now_ms": T0 + C.FULL_WINDOW_MS + C.HOUR})
    after_acct = client.get("/paper/account", headers=HEADERS).json()
    for key in ("equity", "balance", "open_positions", "open_notional", "realized_pnl", "unrealized_pnl", "fees"):
        assert after_acct[key] == before_acct[key], key
    assert sqlite3.connect(str(tmp_path / "p.sqlite3")).execute("SELECT COUNT(*) FROM intents").fetchone()[0] == before_intents
    assert client.get("/paper/positions", headers=HEADERS).json()["positions"] == []
    assert app.state.shadow.path != str(tmp_path / "p.sqlite3")      # its own database file
    s = client.get("/shadow/summary", headers=HEADERS, params={"since_ms": 0}).json()
    assert s["candidate_observations"] == 6 and s["resolved"] == 3


FORBIDDEN = ("market_edge_exec.routing", "market_edge_exec.risk", "market_edge_exec.nautilus", "market_edge_exec.hummingbot",
             "market_edge_exec.persistence", "market_edge_exec.paper.engine", "market_edge_exec.paper.ledger",
             "market_edge_exec.signal_bridge", "market_edge_exec.api", "market_edge_exec.control", "httpx", "requests", "urllib", "socket")


def test_shadow_package_cannot_reach_execution_or_the_network():
    pkg = pathlib.Path(C.__file__).parent
    for path in pkg.glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else (
                [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            for name in names:
                assert not any(name == f or name.startswith(f + ".") for f in FORBIDDEN), f"{path.name} imports {name}"
