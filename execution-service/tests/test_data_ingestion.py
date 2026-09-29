"""DATA 1 (#51): closing the gaps in forward data capture. source_commit on new
rows, execution-quality copied from the paper ledger at close, and one shared
key (signal_id) joining shadow, sizing, paper and exit-counterfactual records."""
import os
import sqlite3
import time
from contextlib import closing

import pytest

from market_edge_exec.api.app import create_app
from market_edge_exec.buildinfo import build_info
from market_edge_exec.risk.engine import RiskLimits
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore, inspect_database
from tests.test_shadow import T0, candidate, decision, scan_payload

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
WIDE = RiskLimits(max_initial_position_notional_pct=100.0, max_portfolio_exposure_pct=100.0)
LIVE = "HYPERLIQUID_ALLMIDS_LIVE"


def now_ms():
    return int(time.time() * 1000)


def executed_scan(sid="sig-1"):
    return scan_payload(submitted_signal_id=sid, execution={"decision": "EXECUTED", "signal_id": sid, "trade": {"qty": 1}},
                        observations=[{"kind": "CANDIDATE", "asset": "ETH", "submitted": True, "decision": decision(cand=candidate())}])


def run_trade(tmp_path, stop_fill=89.0):
    """A real paper trade for signal sig-1 that hits its stop, with the matching shadow scan recorded."""
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"), risk_limits=WIDE)
    app.state.shadow.record_scan(executed_scan())
    t = now_ms() - 60_000
    sig = {"signal_id": "sig-1", "asset": "ETH", "direction": "long", "timestamp": t - 4000, "entry": 100.0, "stop": 90.0,
           "targets": [110.0, 120.0], "strategy_id": "TREND CONTINUATION", "quant_score": 72}
    res = app.state.paper.open_from_signal(sig, "ETH-PERP", 100.0, t, now_ms=t, market_price_source=LIVE)
    assert res.accepted, res.reason
    app.state.paper.tick("ETH-PERP", 104.0, t + 45_000, LIVE)
    app.state.paper.tick("ETH-PERP", stop_fill, t + 55_000, LIVE)
    assert app.state.ledger.trade("sig-1")["status"] == "CLOSED"
    return app


def test_new_rows_carry_the_running_builds_source_commit(tmp_path):
    app = run_trade(tmp_path)
    sha = build_info().get("git_sha")
    assert sha
    with closing(sqlite3.connect(app.state.shadow.path)) as conn:
        assert {r[0] for r in conn.execute("SELECT source_commit FROM shadow_scans")} == {sha}
        assert {r[0] for r in conn.execute("SELECT source_commit FROM shadow_observations")} == {sha}
        assert {r[0] for r in conn.execute("SELECT source_commit FROM forward_execution_quality")} == {sha}
    with closing(sqlite3.connect(str(tmp_path / "p.sqlite3"))) as conn:
        assert {r[0] for r in conn.execute("SELECT source_commit FROM risk_sizing_decisions")} == {sha}


def test_one_signal_id_joins_shadow_paper_sizing_exit_and_quality_records(tmp_path):
    app = run_trade(tmp_path)
    sid = "sig-1"
    with closing(sqlite3.connect(app.state.shadow.path)) as s:
        fpe = s.execute("SELECT signal_id, observation_id, scan_id FROM forward_paper_executed").fetchall()
        feq = s.execute("SELECT signal_id, observation_id, scan_id FROM forward_execution_quality").fetchall()
        obs_ids = {r[0] for r in s.execute("SELECT observation_id FROM shadow_observations")}
    assert [r[0] for r in fpe] == [sid] and [r[0] for r in feq] == [sid]
    assert fpe[0][1] in obs_ids and feq[0] == fpe[0]     # same observation and scan on both sides of the join
    with closing(sqlite3.connect(str(tmp_path / "p.sqlite3"))) as p:
        assert {r[0] for r in p.execute("SELECT signal_id FROM risk_sizing_decisions")} == {sid}
        assert p.execute("SELECT trade_id FROM exit_policy_counterfactuals WHERE finalized=1").fetchall(), "counterfactuals are keyed by the same id"
        assert {r[0] for r in p.execute("SELECT DISTINCT trade_id FROM exit_policy_counterfactuals")} == {sid}
    assert app.state.ledger.trade(sid)["signal_id"] == sid


def test_join_is_absent_not_mismatched_where_one_side_is_missing(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"), risk_limits=WIDE)
    # a closed trade the shadow scan never saw
    closed = {"status": "CLOSED", "signal_id": "orphan", "trade_id": "orphan", "direction": "long", "exits": []}
    assert app.state.shadow.record_execution_quality(closed) is True
    q = app.state.shadow.execution_quality("orphan")
    assert q["observation_id"] is None and q["scan_id"] is None
    with closing(sqlite3.connect(app.state.shadow.path)) as s:
        assert s.execute("SELECT count(*) FROM forward_paper_executed WHERE signal_id='orphan'").fetchone()[0] == 0


def test_execution_quality_is_copied_from_the_ledger_not_recomputed(tmp_path):
    app = run_trade(tmp_path, stop_fill=88.0)          # a gap through the 90 stop
    trade = app.state.ledger.trade("sig-1")
    q = app.state.shadow.execution_quality("sig-1")
    r = q["record"]
    assert q["record_hash_ok"] and q["field_class"] == "OUTCOME_EVENT" and q["source"] == "PAPER_LEDGER"
    assert r["fees"] == trade["fees"] and r["entry_slippage_cost"] == trade["slippage_cost"]
    assert r["latency_to_fill_ms"] == trade["opened_at_ms"] - trade["signal_timestamp"] > 0
    stop = next(o for o in r["stop_overshoot"] if "STOP" in o["kind"])
    assert stop["overshoot"] == pytest.approx(max(0.0, stop["level"] - stop["fill_price"])) and stop["overshoot"] > 0
    assert r["best_price_at_ms"] and r["best_price_precision"] == "TICK"    # #41 fields flow through
    # first write wins: recording again never changes it
    assert app.state.shadow.record_execution_quality(dict(trade)) is False


def test_execution_quality_is_outcome_data_and_never_a_model_feature(tmp_path):
    store = ShadowStore(str(tmp_path / "s.sqlite3"))
    for path in ("execution_quality.fees", "fees", "latency_to_fill_ms", "stop_overshoot", "forward_execution_quality"):
        with pytest.raises(C.LeakageError):
            C.assert_decision_features([path])
    with closing(sqlite3.connect(store.path)) as conn:
        store.record_execution_quality({"status": "CLOSED", "signal_id": "x", "direction": "long", "exits": []})
        for sql in ("UPDATE forward_execution_quality SET source='X'", "DELETE FROM forward_execution_quality"):
            with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
                conn.execute(sql)


def _make_v1(path):
    """A shadow database exactly as a v1 build left it: no source_commit columns, no quality table."""
    store = ShadowStore(path, source_commit="old")
    store.record_scan(executed_scan("old-1"))
    with closing(sqlite3.connect(path)) as conn:
        for t in ("shadow_scans", "shadow_observations"):
            for op in ("update", "delete"):
                conn.execute(f"DROP TRIGGER {t}_no_{op}")
            conn.execute(f"ALTER TABLE {t} DROP COLUMN source_commit")
        for op in ("update", "delete"):
            conn.execute(f"DROP TRIGGER forward_execution_quality_no_{op}")
        conn.execute("DROP TABLE forward_execution_quality")
        for t in ("shadow_scans", "shadow_observations"):
            for op in ("UPDATE", "DELETE"):
                conn.execute(f"CREATE TRIGGER {t}_no_{op.lower()} BEFORE {op} ON {t} BEGIN SELECT RAISE(ABORT, 'SHADOW_RESEARCH_ROW_IMMUTABLE'); END;")
        conn.execute("UPDATE shadow_meta SET value='1' WHERE key='schema_version'")
        conn.commit()


def test_a_v1_database_upgrades_in_place_with_null_for_old_rows(tmp_path):
    path = str(tmp_path / "s.sqlite3")
    _make_v1(path)
    v1 = inspect_database(path)
    assert v1["ok"] and v1["shadow_schema_version"] == 1     # a v1 backup is still a valid restore source
    store = ShadowStore(path, source_commit="new")
    assert store.versions()["shadow_schema_version"] == 2
    old = store.observations(limit=10)
    assert old and all(store.observation(o["observation_id"])["source_commit"] is None for o in old)   # never backfilled with a guess
    store.record_scan({**executed_scan("new-1"), "scan": {**executed_scan("new-1")["scan"], "scan_id": "new-1"}})
    with closing(sqlite3.connect(path)) as conn:
        assert {r[0] for r in conn.execute("SELECT DISTINCT source_commit FROM shadow_scans")} == {None, "new"}
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            conn.execute("UPDATE shadow_scans SET source_commit='forged'")
    assert inspect_database(path)["ok"]


def test_old_rows_do_not_break_the_training_export_or_the_leakage_guard(tmp_path):
    path = str(tmp_path / "s.sqlite3")
    _make_v1(path)
    store = ShadowStore(path)
    out = store.training_rows(["candidate.entry"])
    assert "rows" in out
    with pytest.raises(C.LeakageError):
        store.training_rows(["source_commit_outcome_mfe"])


def test_a_newer_shadow_database_is_still_refused_by_inspection(tmp_path):
    path = str(tmp_path / "s.sqlite3")
    ShadowStore(path)
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("UPDATE shadow_meta SET value='99' WHERE key='schema_version'")
        conn.commit()
    assert any("SHADOW_SCHEMA_NEWER" in p for p in inspect_database(path)["problems"])
