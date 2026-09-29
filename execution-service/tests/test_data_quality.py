"""DATA 2 (#52): the shared VALID / INVALID / UNRESOLVED / QUARANTINED gate.
One deliberately broken fixture per named check."""
import json
import os
import sqlite3
import time
import zlib
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.quality import checks as K, runner
from market_edge_exec.risk.engine import RiskLimits
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore, inspect_database
from tests.test_data_ingestion import executed_scan, run_trade
from tests.test_shadow import BAR, T0, bars_path, candidate, decision, scan_payload
from market_edge_exec.shadow import resolve as R

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
HEADERS = {"X-API-Key": "test-key"}
NOW = T0 + 10 * 60_000


@pytest.fixture
def store(tmp_path):
    s = ShadowStore(str(tmp_path / "s.sqlite3"), source_commit="abc")
    s.record_scan(scan_payload(observations=[{"kind": "CANDIDATE", "asset": "BTC", "submitted": False, "decision": decision(cand=candidate())}]))
    return s


def base_row(store):
    with closing(store._connect()) as c:
        return dict(c.execute("SELECT * FROM shadow_observations WHERE kind='CANDIDATE'").fetchone())


def insert_row(store, **over):
    """Fabricate a damaged observation by INSERT (the triggers only forbid UPDATE/DELETE)."""
    row = {**base_row(store), **over}
    row["observation_id"] = over.get("observation_id", "obs-broken-" + str(abs(hash(json.dumps(over, default=str))) % 10**8))
    cols = list(row)
    with closing(store._connect()) as c:
        c.execute(f"INSERT INTO shadow_observations ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", [row[k] for k in cols])
        c.commit()
    return row["observation_id"]


def blob(value):
    return zlib.compress(C.canonical(value).encode(), 6)


def verdict_of(store, oid, now=NOW, listing=None):
    v = {(x["subject_kind"], x["subject_id"]): x for x in runner.compute(store, None, now, listing)}
    return v[(runner.SHADOW_OBSERVATION, oid)]


def test_a_clean_observation_is_valid_or_unresolved_only_because_its_outcome_is_pending(store):
    oid = base_row(store)["observation_id"]
    v = verdict_of(store, oid)
    assert v["verdict"] == K.UNRESOLVED and v["reasons"] == ["UNRESOLVED:OUTCOME_PENDING"]


def test_future_timestamp_is_invalid(store):
    oid = insert_row(store, decision_ts=T0 + 3_600_000, created_at_ms=T0, first_bar_ts=T0 + 3_600_000)
    v = verdict_of(store, oid)
    assert v["verdict"] == K.INVALID and "INVALID:FUTURE_TIMESTAMP" in v["reasons"]


def test_timestamp_order_first_bar_before_decision_is_invalid(store):
    oid = insert_row(store, first_bar_ts=base_row(store)["decision_ts"] - 1)
    assert "INVALID:TIMESTAMP_ORDER_FIRST_BAR_BEFORE_DECISION" in verdict_of(store, oid)["reasons"]


def test_duplicate_observation_is_flagged_and_the_first_is_not(store):
    first = base_row(store)
    dup = insert_row(store, scan_id="scan-2", created_at_ms=first["created_at_ms"] + 5)
    assert verdict_of(store, dup)["reasons"].count("INVALID:DUPLICATE_OBSERVATION") == 1
    assert "INVALID:DUPLICATE_OBSERVATION" not in verdict_of(store, first["observation_id"])["reasons"]


def test_missing_version_metadata_is_invalid(store):
    oid = insert_row(store, feature_version="")
    v = verdict_of(store, oid)
    assert v["verdict"] == K.INVALID and "INVALID:MISSING_VERSION_METADATA" in v["reasons"]


def test_cross_venue_label_substitution_is_invalid(store):
    oid = insert_row(store, outcome_venue="BINANCE")
    v = verdict_of(store, oid)
    assert v["verdict"] == K.INVALID and "INVALID:CROSS_VENUE_LABEL_SUBSTITUTION" in v["reasons"]
    d = json.loads(zlib.decompress(base_row(store)["decision"]).decode())
    d["market"]["venue"] = "COINBASE"          # decision taken on one venue, outcome measured on another
    oid2 = insert_row(store, decision=blob(d), decision_hash=C.content_hash(d))
    assert "INVALID:CROSS_VENUE_LABEL_SUBSTITUTION" in verdict_of(store, oid2)["reasons"]


def test_pre_listing_history_is_invalid_when_a_listing_date_is_known(store):
    row = base_row(store)
    v = verdict_of(store, row["observation_id"], listing={row["coin"]: row["decision_ts"] + 1})
    assert "INVALID:PRE_LISTING_HISTORY" in v["reasons"]
    assert "INVALID:PRE_LISTING_HISTORY" not in verdict_of(store, row["observation_id"])["reasons"]   # no listing data, no claim
    assert (K.INVALID, "PRE_LISTING_HISTORY") in K.candle_findings("BTC", [{"time": 5, "open": 1, "high": 2, "low": 1, "close": 1}], listing_ms=10)


def test_impossible_candle_prices_are_invalid_and_non_finite_are_quarantined():
    ok = {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10}
    assert K.candle_findings("X", [ok]) == []
    assert (K.INVALID, "IMPOSSIBLE_PRICES") in K.candle_findings("X", [{**ok, "high": 8}])
    assert (K.INVALID, "IMPOSSIBLE_PRICES") in K.candle_findings("X", [{**ok, "low": -1}])
    assert (K.QUARANTINED, "CANDLE_NON_FINITE") in K.candle_findings("X", [{**ok, "close": float("nan")}])
    assert (K.QUARANTINED, "CANDLE_SCHEMA_DRIFT") in K.candle_findings("X", [{"time": 1}])


def test_corrupted_rows_are_quarantined_and_left_exactly_as_captured(store):
    unreadable = insert_row(store, decision=b"not-a-zlib-blob")
    assert verdict_of(store, unreadable) ["verdict"] == K.QUARANTINED
    assert "QUARANTINED:CORRUPTED_DECISION_BLOB" in verdict_of(store, unreadable)["reasons"]
    d = json.loads(zlib.decompress(base_row(store)["decision"]).decode())
    tampered = insert_row(store, decision=blob({**d, "extra": 1}), decision_hash=base_row(store)["decision_hash"])
    assert "QUARANTINED:DECISION_HASH_MISMATCH" in verdict_of(store, tampered)["reasons"]
    with closing(store._connect()) as c:     # nothing was repaired or removed
        assert c.execute("SELECT decision FROM shadow_observations WHERE observation_id=?", (unreadable,)).fetchone()[0] == b"not-a-zlib-blob"


def test_non_finite_values_are_quarantined():
    assert K.non_finite({"a": [1, {"b": float("inf")}]}) and not K.non_finite({"a": [1, 2.5]})
    assert K.paper_trade_findings({"entry_fill": float("nan"), "stop": 1, "quantity": 1}, NOW) == [(K.QUARANTINED, "NON_FINITE_VALUE")]


def test_schema_drift_missing_column_is_quarantined(store):
    row = base_row(store)
    del row["feature_version"]
    assert K.observation_findings(row, NOW) == [(K.QUARANTINED, "SCHEMA_DRIFT_MISSING_COLUMN")]
    d = json.loads(zlib.decompress(base_row(store)["decision"]).decode())
    d.pop("candidate")
    oid = insert_row(store, decision=blob(d), decision_hash=C.content_hash(d))
    assert "QUARANTINED:SCHEMA_DRIFT_MISSING_CANDIDATE" in verdict_of(store, oid)["reasons"]


def test_existing_snapshot_validity_maps_into_the_shared_taxonomy(store):
    stale = decision(age_ms=C.MAX_SNAPSHOT_AGE_MS + 1, cand=candidate())
    store.record_scan(scan_payload(scan_id="scan-stale", observations=[{"kind": "CANDIDATE", "asset": "ETH", "submitted": False, "decision": stale}]))
    with closing(store._connect()) as c:
        oid = c.execute("SELECT observation_id FROM shadow_observations WHERE asset='ETH'").fetchone()[0]
    v = verdict_of(store, oid)
    assert v["verdict"] == K.INVALID and "INVALID:STALE_SNAPSHOT" in v["reasons"]


def test_resolve_py_unresolved_states_map_into_the_shared_taxonomy(store):
    assert K.resolution_findings("PENDING", []) == [(K.UNRESOLVED, "OUTCOME_PENDING")]
    assert K.resolution_findings("PARTIAL", []) == [(K.UNRESOLVED, "INCOMPLETE_HORIZONS")]
    assert K.resolution_findings("RESOLVED", ["OK"]) == []
    assert K.resolution_findings("RESOLVED_WITH_GAPS", ["UNRESOLVED_MISSING_CANDLE"]) == [
        (K.UNRESOLVED, "RESOLVED_WITH_GAPS"), (K.UNRESOLVED, "MISSING_CANDLE")]
    assert K.resolution_findings("RESOLVED", ["UNRESOLVED_DATA_UNAVAILABLE"]) == [(K.UNRESOLVED, "OUTCOME_DATA_UNAVAILABLE")]
    assert K.resolution_findings("RESOLVED", ["MYSTERY"]) == [(K.QUARANTINED, "UNKNOWN_LABEL_STATUS")]
    # and end to end: a fully resolved observation becomes VALID
    first = R.first_bar_open(T0)
    closes = [100 + min(i, 60) * 0.1 for i in range(C.FULL_WINDOW_MS // BAR + 2)]
    store.resolve("BTC", bars_path(first, closes, spread=0.05), "HYPERLIQUID", "5m", now_ms=T0 + C.FULL_WINDOW_MS + C.HOUR)
    v = verdict_of(store, base_row(store)["observation_id"], now=T0 + C.FULL_WINDOW_MS + C.HOUR)
    assert v["verdict"] == K.VALID and v["reasons"] == []


def test_sizing_decision_checks():
    body = json.dumps({"approved": True}, sort_keys=True)
    import hashlib
    good = {"record": body, "record_hash": hashlib.sha256(body.encode()).hexdigest(), "policy_version": "RISK-SIZING-V2.0", "signal_id": "s", "created_at_ms": 5}
    assert K.sizing_decision_findings(good) == []
    assert K.sizing_decision_findings({**good, "record_hash": "0" * 64}) == [(K.QUARANTINED, "RECORD_HASH_MISMATCH")]
    assert K.sizing_decision_findings({**good, "record": "{not json"}) == [(K.QUARANTINED, "CORRUPTED_RECORD")]
    assert K.sizing_decision_findings({**good, "policy_version": "UNKNOWN"}) == [(K.INVALID, "MISSING_VERSION_METADATA")]
    nan = '{"a": NaN}'
    assert K.sizing_decision_findings({**good, "record": nan, "record_hash": hashlib.sha256(nan.encode()).hexdigest()}) == [(K.QUARANTINED, "NON_FINITE_VALUE")]


def test_paper_trade_checks():
    t = {"entry_fill": 100.0, "stop": 90.0, "quantity": 1.0, "opened_at_ms": 1000, "closed_at_ms": 2000, "direction": "long", "status": "CLOSED", "exit_reason": "STOP"}
    assert K.paper_trade_findings(t, NOW) == []
    assert (K.INVALID, "TIMESTAMP_ORDER_CLOSE_BEFORE_OPEN") in K.paper_trade_findings({**t, "closed_at_ms": 500}, NOW)
    assert (K.INVALID, "STOP_ON_WRONG_SIDE_OF_ENTRY") in K.paper_trade_findings({**t, "stop": 110.0}, NOW)
    assert (K.INVALID, "FUTURE_TIMESTAMP") in K.paper_trade_findings({**t, "opened_at_ms": NOW * 2}, NOW)
    assert (K.UNRESOLVED, "TRADE_STILL_OPEN") in K.paper_trade_findings({**t, "status": "OPEN", "closed_at_ms": None}, NOW)


def test_bad_join_between_shadow_and_paper_is_invalid(tmp_path):
    app = run_trade(tmp_path)
    with closing(sqlite3.connect(app.state.shadow.path)) as c:      # an executed shadow row whose paper trade does not exist
        c.execute("INSERT INTO forward_paper_executed VALUES ('ghost-1', 'obs-missing', 'scan-x', 1, 'FORWARD-PAPER-EXECUTED-V1', x'00', 1)")
        c.commit()
    out = {(v["subject_kind"], v["subject_id"]): v for v in runner.compute(app.state.shadow, str(tmp_path / "p.sqlite3"), int(time.time() * 1000))}
    ghost = out[(runner.SHADOW_JOIN, "ghost-1")]
    assert ghost["verdict"] == K.INVALID and set(ghost["reasons"]) == {"INVALID:BAD_JOIN_NO_SHADOW_OBSERVATION", "INVALID:BAD_JOIN_NO_PAPER_TRADE"}
    assert out[(runner.SHADOW_JOIN, "sig-1")]["verdict"] == K.VALID


def test_verdicts_are_append_only_and_a_row_changes_bucket_only_through_a_new_check(store):
    oid = insert_row(store, feature_version="")
    runner.run(store, None, now_ms=NOW)
    assert runner.run(store, None, now_ms=NOW + 1)["new_verdicts"] == 0          # a quiet re-run writes nothing
    with closing(sqlite3.connect(store.path)) as c:
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            c.execute("UPDATE data_quality_verdicts SET verdict='VALID'")
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            c.execute("DELETE FROM data_quality_verdicts")
    assert store.latest_quality(runner.SHADOW_OBSERVATION)[(runner.SHADOW_OBSERVATION, oid)]["verdict"] == K.INVALID
    # the row itself is untouched, so a later check still says INVALID; the verdict cannot flip on its own
    runner.run(store, None, now_ms=NOW + 5)
    hist = store.quality_history(runner.SHADOW_OBSERVATION, oid)
    assert [h["verdict"] for h in hist] == [K.INVALID]


def test_existing_valid_data_is_not_reclassified_and_the_api_reports_counts(tmp_path):
    app = run_trade(tmp_path)
    c = TestClient(app)
    r = c.post("/research/data-quality/run", headers=HEADERS).json()
    assert "ROWS ARE NEVER EDITED" in r["label"]
    kinds = r["by_kind"]
    assert kinds["PAPER_TRADE"]["INVALID"] == 0 and kinds["PAPER_TRADE"]["QUARANTINED"] == 0
    assert kinds["RISK_SIZING_DECISION"]["VALID"] >= 1 and kinds["SHADOW_JOIN"]["VALID"] == 1
    assert sum(kinds["SHADOW_OBSERVATION"].values()) >= 1 and kinds["SHADOW_OBSERVATION"]["QUARANTINED"] == 0
    assert c.get("/research/data-quality", headers=HEADERS).json()["by_kind"] == kinds
    assert c.get("/research/data-quality").status_code in (401, 403)


def test_a_v2_database_gains_the_verdict_table_and_v2_backups_stay_valid(tmp_path):
    path = str(tmp_path / "s.sqlite3")
    ShadowStore(path)
    with closing(sqlite3.connect(path)) as c:
        for op in ("update", "delete"):
            c.execute(f"DROP TRIGGER data_quality_verdicts_no_{op}")
        c.execute("DROP TABLE data_quality_verdicts")
        c.execute("UPDATE shadow_meta SET value='2' WHERE key='schema_version'")
        c.commit()
    assert inspect_database(path)["ok"]
    assert ShadowStore(path).versions()["shadow_schema_version"] == 3
