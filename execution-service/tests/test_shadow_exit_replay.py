"""Executable Shadow exit replay (#120): eligibility, the entry model, full-path replay, cohorts and independence."""
import os
import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.exits import policies as pol
from market_edge_exec.exits import shadow_replay as SR
from market_edge_exec.paper import lifecycle
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow import resolve as R
from market_edge_exec.shadow.store import ShadowStore

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
BAR = C.BAR_MS
T0 = 1_790_000_000_000 - 1_790_000_000_000 % BAR + 60_000
FIRST = R.first_bar_open(T0)
VERSIONS = {"generator_version": "scan-core@test", "feature_version": "shadow-features-v1", "model_version": "quant-only"}


def candidate(direction="long", strategy="TREND CONTINUATION", entry=100.0, stop=98.0, tp1=102.0, tp2=104.0, pick=True):
    return {"direction": direction, "strategy": strategy, "entry": entry, "stop": stop, "tp1": tp1, "tp2": tp2, "rr1": 1.0,
            "quant_score": 70, "production_rank": 1 if pick else None, "is_production_pick": pick, "scan_candidate_rank": 1,
            "geometry_complete": True}


def decision(cand=None, price=100.0, age_ms=60_000, venue="HYPERLIQUID"):
    d = {"market": {"price": price, "data_age_ms": age_ms, "venue": venue}, "features": {"h1": {"atr": 0.5}}, "regime": "UPTREND"}
    if cand is not None:
        d["candidate"] = cand
    return d


def payload(scan_id, ts, observations, execution=None, signal=None):
    return {"scan": {"scan_id": scan_id, "decision_ts": ts, "scan_status": "BEST_TRADE_NOW", "n_markets": 1, "submitted_signal_id": signal,
                     "execution": execution or {"decision": "NO_SIGNAL"}, **VERSIONS}, "observations": observations}


def obs(asset="BTC", cand=None, reason="RANK_BELOW_SELECTED", **kw):
    return {"kind": "CANDIDATE", "asset": asset, "coin": asset, "not_submitted_reason": reason, "decision": decision(cand=cand or candidate(), **kw)}


def rising(start, closes, spread=0.05):
    out, prev = [], closes[0]
    for i, c in enumerate(closes):
        out.append({"time": start + i * BAR, "open": prev, "high": max(prev, c) + spread, "low": min(prev, c) - spread, "close": c})
        prev = c
    return out


WIN = rising(FIRST, [100.0 + 0.1 * i for i in range(70)])      # climbs through tp1 (102) and tp2 (104)
LOSE = rising(FIRST, [100.0 - 0.1 * i for i in range(40)])     # falls through the 98 stop


@pytest.fixture
def store(tmp_path):
    return ShadowStore(str(tmp_path / "shadow.sqlite3"))


def rows(store):
    with closing(store._connect()) as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM shadow_observations ORDER BY decision_ts, observation_id")]


def row_and_decision(store, index=0):
    row = rows(store)[index]
    from market_edge_exec.shadow.store import _unblob
    return row, _unblob(row["decision"])


NOW = FIRST + 100 * BAR


# ---- eligibility ------------------------------------------------------------------------------
def test_eligibility_is_deterministic_and_decision_time_only(store):
    store.record_scan(payload("s1", T0, [obs()]))
    row, dec = row_and_decision(store)
    a = SR.reconstruct_eligibility(row, dec)
    assert a == SR.reconstruct_eligibility(row, dec)
    assert (a["status"], a["cohort"]) == (SR.EXECUTABLE, SR.COHORT_B)
    # a hindsight-looking key elsewhere in the payload is never read and never changes the answer
    assert SR.reconstruct_eligibility(row, {**dec, "mfe_r": 9.9, "future_close": 1})["status"] == a["status"]
    with pytest.raises(C.LeakageError):   # and cannot even be ingested
        store.record_scan(payload("s2", T0 + BAR, [obs(asset="ETH", cand={**candidate(), "mfe_r": 3})]))


@pytest.mark.parametrize("field", ["stop", "tp2", "entry", "tp1"])
def test_a_missing_required_candidate_field_is_unknown_never_executable(store, field):
    cand = candidate()
    cand.pop(field)
    row = {"kind": "CANDIDATE", "execution_status": "NOT_SUBMITTED", "execution_rejection_reason": "RANK_BELOW_SELECTED",
           "research_candidate_valid": 1}
    out = SR.reconstruct_eligibility(row, decision(cand=cand))
    assert out["status"] == SR.UNKNOWN and out["cohort"] == SR.COHORT_C
    assert any(f"candidate.{field}" in r for r in out["reasons"])


def test_a_missing_market_field_is_unknown():
    row = {"kind": "CANDIDATE", "execution_status": "NOT_SUBMITTED", "execution_rejection_reason": "RANK_BELOW_SELECTED", "research_candidate_valid": 1}
    d = decision(cand=candidate())
    d["market"].pop("venue")
    assert SR.reconstruct_eligibility(row, d)["status"] == SR.UNKNOWN


def test_cohorts_follow_the_reason_not_the_outcome(store):
    store.record_scan(payload("s1", T0, [obs("BTC", reason="RANK_BELOW_SELECTED"), obs("ETH", reason="NO_SIGNAL_THIS_SCAN"),
                                         obs("SOL", reason="OUTSIDE_PRODUCTION_UNIVERSE")]))
    by_asset = {r["asset"]: SR.reconstruct_eligibility(r, __import__("market_edge_exec.shadow.store", fromlist=["_unblob"])._unblob(r["decision"]))
                for r in rows(store)}
    assert by_asset["BTC"]["cohort"] == SR.COHORT_B
    assert by_asset["ETH"]["cohort"] == SR.COHORT_C and by_asset["ETH"]["status"] == SR.EXECUTABLE
    assert by_asset["SOL"]["cohort"] == SR.COHORT_C


def test_a_risk_sizing_v2_rejection_makes_it_not_executable(store):
    d = decision(cand=candidate())
    d["counterfactual_sizing"] = {"approved": False, "rejection_reason": "MIN_ORDER_EXCEEDS_SAFE_SIZE"}
    row = {"kind": "CANDIDATE", "execution_status": "NOT_SUBMITTED", "execution_rejection_reason": "RANK_BELOW_SELECTED", "research_candidate_valid": 1}
    out = SR.reconstruct_eligibility(row, d)
    assert out["status"] == SR.NOT_EXECUTABLE and out["cohort"] == SR.COHORT_C and "RISK_SIZING_V2_REJECTED:MIN_ORDER_EXCEEDS_SAFE_SIZE" in out["reasons"]


def test_executed_paper_trades_are_cohort_a_and_not_replayed_here(store):
    store.record_scan(payload("s1", T0, [{**obs(), "submitted": True}], execution={"decision": "EXECUTED", "signal_id": "sig", "trade": {}}, signal="sig"))
    row, dec = row_and_decision(store)
    res = SR.replay_observation(row["observation_id"], row, dec, WIN, NOW)
    assert res["status"] == "NOT_REPLAYABLE" and res["eligibility"]["cohort"] == SR.COHORT_A


# ---- entry model ------------------------------------------------------------------------------
def test_the_entry_never_fills_at_the_signal_price(store):
    store.record_scan(payload("s1", T0, [obs()]))
    row, dec = row_and_decision(store)
    path = SR.clean_path(WIN, row["first_bar_ts"], NOW)
    spec, model = SR.shadow_entry(row["observation_id"], row, dec, path)
    assert spec.entry != dec["candidate"]["entry"]
    assert spec.entry == pytest.approx(lifecycle.slipped(path[0]["open"], "buy"))
    assert model["fill_bar_open_ts"] == FIRST and model["latency_ms"] == FIRST - T0 and model["entry_model_version"] == SR.ENTRY_MODEL_VERSION


def test_a_fill_already_through_the_stop_or_tp1_is_not_replayed(store):
    store.record_scan(payload("s1", T0, [obs()]))
    row, dec = row_and_decision(store)
    gap_down = rising(FIRST, [97.0] * 10)
    assert SR.shadow_entry("o", row, dec, SR.clean_path(gap_down, FIRST, NOW))[0] is None
    gap_up = rising(FIRST, [103.0] * 10)
    assert SR.shadow_entry("o", row, dec, SR.clean_path(gap_up, FIRST, NOW))[1]["rejection"] == "TP1_ALREADY_PASSED_AT_FILL"


def test_a_path_with_a_gap_ends_at_the_gap_and_is_never_repaired():
    path = rising(FIRST, [100.0] * 10)
    del path[4]
    assert len(SR.clean_path(path, FIRST, NOW)) == 4


# ---- replay -----------------------------------------------------------------------------------
def test_current_policy_replay_reproduces_the_fixed_lifecycle_exactly(store):
    store.record_scan(payload("s1", T0, [obs()]))
    row, dec = row_and_decision(store)
    res = SR.replay_observation(row["observation_id"], row, dec, WIN, NOW)
    assert res["status"] == "FINAL"
    spec, _ = SR.shadow_entry("x", row, dec, SR.clean_path(WIN, FIRST, NOW))
    events = lifecycle.advance(spec.direction, spec.entry, spec.stop, spec.tp1, spec.tp2, spec.quantity, spec.quantity, False,
                               spec.opened_at_ms, SR.clean_path(WIN, FIRST, NOW), NOW)
    pnl = sum(lifecycle.pnl(spec.direction, spec.entry, e.fill_price, e.quantity) for e in events)
    fees = spec.entry_fee + sum(lifecycle.fee(e.fill_price, e.quantity) for e in events)
    base = res["records"][pol.BASELINE]
    assert base["counterfactual_R"] == pytest.approx((pnl - fees) / spec.risk_dollars)
    assert [e["kind"] for e in base["events"]] == [e.kind for e in events] == ["TP1", "TP2"]
    assert set(res["records"]) == set(pol.REGISTRY)
    assert all(r["real_R"] == base["counterfactual_R"] and r["cohort"] == SR.COHORT_B for r in res["records"].values())


def test_a_losing_path_stops_out_for_every_policy(store):
    store.record_scan(payload("s1", T0, [obs()]))
    row, dec = row_and_decision(store)
    res = SR.replay_observation(row["observation_id"], row, dec, LOSE, NOW)
    assert res["status"] == "FINAL"
    assert res["records"][pol.BASELINE]["reason"] == "STOP"
    assert all(r["counterfactual_R"] <= 0.05 for r in res["records"].values())


def test_an_unfinished_path_stays_pending_and_writes_nothing(store):
    store.record_scan(payload("s1", T0, [obs()]))
    row, dec = row_and_decision(store)
    flat = rising(FIRST, [100.0] * 30)    # no stop, no target
    assert SR.replay_observation(row["observation_id"], row, dec, flat, NOW)["status"] == "PATH_PENDING"
    tally = SR.run_for_coin(store._connect, "BTC", flat, NOW)
    assert (tally["finalized"], tally["pending"]) == (0, 1)
    with closing(store._connect()) as conn:
        assert conn.execute("SELECT COUNT(*) FROM shadow_exit_replays").fetchone()[0] == 0
    # later, a complete path finalizes it
    assert SR.run_for_coin(store._connect, "BTC", WIN, NOW)["finalized"] == 1


def test_twenty_overlapping_observations_are_one_replay(store):
    for i in range(20):    # same asset / direction / strategy every 5 minutes: one observation cluster
        store.record_scan(payload(f"s{i}", T0 + i * BAR, [obs()]))
    with closing(store._connect()) as conn:
        assert conn.execute("SELECT COUNT(DISTINCT observation_cluster_id) FROM shadow_observations").fetchone()[0] == 1
    path = rising(FIRST, [100.0 + 0.1 * i for i in range(120)])
    assert SR.run_for_coin(store._connect, "BTC", path, FIRST + 200 * BAR)["finalized"] == 1
    report = SR.cohort_report(store._connect, FIRST + 200 * BAR)
    b = report["cohorts"][SR.COHORT_B]
    assert (b["replayed_observations"], b["observation_clusters"], b["independence_units_3h"]) == (1, 1, 1)


def test_coins_with_an_unfinished_path_ask_for_candles_until_it_expires(store):
    store.record_scan(payload("s1", T0, [obs()]))
    assert SR.pending_coins(store._connect, now_ms=FIRST + 3 * BAR) == [{"coin": "BTC", "since_ms": FIRST}]
    assert SR.pending_coins(store._connect, now_ms=FIRST) == []                        # the entry bar has not closed yet
    late = T0 + SR.PATH_HORIZON_MS + BAR
    assert SR.pending_coins(store._connect, now_ms=late) == []                         # expired: reported, never asked for again
    assert SR.cohort_report(store._connect, late)["expired_without_replay"] == 1
    SR.run_for_coin(store._connect, "BTC", WIN, NOW)
    assert SR.pending_coins(store._connect, now_ms=FIRST + 3 * BAR) == []              # finalized: nothing left to fetch


def test_cohorts_are_reported_separately_and_never_counted_toward_the_paper_bar(store):
    store.record_scan(payload("s1", T0, [obs("BTC", reason="RANK_BELOW_SELECTED"), obs("ETH", reason="NO_SIGNAL_THIS_SCAN")]))
    for coin in ("BTC", "ETH"):
        assert SR.run_for_coin(store._connect, coin, WIN, NOW)["finalized"] == 1
    report = SR.cohort_report(store._connect, NOW)
    assert report["counts_toward_paper_bar"] is False and "NONE" in report["promotion"]
    b, c = report["cohorts"][SR.COHORT_B], report["cohorts"][SR.COHORT_C]
    assert (b["replayed_observations"], c["replayed_observations"]) == (1, 1)
    assert b["evaluation"]["trades_with_baseline"] == 1 and c["evaluation"]["trades_with_baseline"] == 1
    assert all(m["verdict"] == "INSUFFICIENT_EVIDENCE" for m in b["evaluation"]["policies"].values())   # the bar is unchanged


def test_replay_rows_are_immutable_and_writes_stay_in_the_research_table(store):
    store.record_scan(payload("s1", T0, [obs()]))
    targets = []

    def connect():
        conn = store._connect()

        def authorizer(action, arg1, arg2, db, source):
            if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE, sqlite3.SQLITE_CREATE_TABLE):
                targets.append(arg1)
            return sqlite3.SQLITE_OK
        conn.set_authorizer(authorizer)
        return conn

    SR.ensure_table(store._connect)
    assert SR.run_for_coin(connect, "BTC", WIN, NOW)["finalized"] == 1
    assert set(targets) <= {"shadow_exit_replays", "sqlite_master", "sqlite_sequence"}
    with closing(store._connect()) as conn:
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            conn.execute("UPDATE shadow_exit_replays SET cohort='X'")
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            conn.execute("DELETE FROM shadow_exit_replays")


def test_episode_classes_are_diagnostic_labels_with_versioned_thresholds():
    base = lambda mfe, r, gb: {"MFE_R": mfe, "counterfactual_R": r, "giveback_R": gb}
    assert SR.classify_episode({pol.BASELINE: base(0.2, -1.0, 1.2)}) == "ENTRY_FAILURE"
    assert SR.classify_episode({pol.BASELINE: base(2.0, 0.5, 1.5)}) == "GIVEBACK_FAILURE"
    assert SR.classify_episode({pol.BASELINE: base(2.0, 1.8, 0.2)}) == "SUCCESSFUL_FIXED_EXIT"
    assert SR.classify_episode({pol.BASELINE: base(0.8, -0.2, 1.0)}) == "OTHER_INDETERMINATE"
    early = {pol.BASELINE: base(3.0, 2.0, 0.5), "x": {"counterfactual_R": 0.5, "reason": "POLICY_EXIT"}}
    assert SR.classify_episode(early) == "EARLY_EXIT_RISK"
    assert SR.EPISODE_CLASS["version"] == SR.EPISODE_CLASS_VERSION


# ---- API --------------------------------------------------------------------------------------
def test_api_resolve_replays_and_the_report_is_read_only(tmp_path):
    client = TestClient(create_app(db_path=str(tmp_path / "p.sqlite3")))
    body = payload("s1", T0, [obs()])
    assert client.post("/shadow/scan", json=body, headers=HEADERS).status_code == 200
    res = client.post("/shadow/resolve", json={"coin": "BTC", "venue": "HYPERLIQUID", "interval": "5m", "candles": WIN, "now_ms": NOW}, headers=HEADERS)
    assert res.status_code == 200 and res.json()["exit_replay"]["finalized"] == 1
    report = client.get("/research/shadow-exit-replay", headers=HEADERS).json()
    assert report["cohorts"][SR.COHORT_B]["replayed_observations"] == 1 and report["counts_toward_paper_bar"] is False
    assert client.get("/paper/open", headers=HEADERS).json()["trades"] == []       # zero capital, no trade
    assert client.get("/shadow/pending", headers=HEADERS).status_code == 200
