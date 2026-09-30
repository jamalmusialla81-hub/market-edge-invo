"""#119: exit-replay linkage and completeness. Legacy or partial-path trades are labelled and kept out of 3H; a new paper trade
must create its full research linkage; nothing here edits or invents a row."""
import os
import sqlite3
import time
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.exits import completeness as cp, policies as pol
from market_edge_exec.exits.store import ExitStore
from market_edge_exec.risk.engine import RiskLimits

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
HEADERS = {"X-API-Key": "test-key"}
WIDE = RiskLimits(max_initial_position_notional_pct=100.0, max_portfolio_exposure_pct=100.0)
LIVE = "HYPERLIQUID_ALLMIDS_LIVE"
M5 = 300_000


def now_ms():
    return int(time.time() * 1000)


def open_trade(db, opened_ms, sid="sig-1"):
    app = create_app(db_path=db, risk_limits=WIDE)
    sig = {"signal_id": sid, "asset": "ETH", "direction": "long", "timestamp": opened_ms, "entry": 100.0, "stop": 90.0,
           "targets": [110.0, 120.0], "strategy_id": "TREND CONTINUATION", "quant_score": 72}
    r = app.state.paper.open_from_signal(sig, "ETH-PERP", 100.0, opened_ms, now_ms=opened_ms, market_price_source=LIVE)
    assert r.accepted, r.reason
    return app, r.trade


def ro(db):
    def connect():
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        return c
    return connect


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "c.sqlite3")


# ---- pure path classification ------------------------------------------------------
def test_a_path_from_entry_to_close_is_complete():
    known = [1_000 + i * 10_000 for i in range(0, 200)]
    assert cp.classify_path(0, known[-1], known) == []


def test_a_path_that_starts_hours_after_entry_is_incomplete():
    r = cp.classify_path(0, 4 * 3_600_000, [3 * 3_600_000, 4 * 3_600_000])
    assert any(x.startswith("STARTS_LATE") for x in r)


def test_a_single_observation_at_the_close_is_incomplete():
    assert cp.classify_path(0, 10 * 3_600_000, [10 * 3_600_000]) != []


def test_an_ordinary_monitor_gap_passes_but_a_long_one_does_not():
    ok = [0, 49 * 60_000, 50 * 60_000]
    bad = [0, 61 * 60_000, 62 * 60_000]
    assert cp.classify_path(0, 50 * 60_000, ok) == []
    assert any(x.startswith("GAP_OF") for x in cp.classify_path(0, 62 * 60_000, bad))


def test_a_path_that_stops_before_the_close_is_incomplete():
    assert any(x.startswith("ENDS_") for x in cp.classify_path(0, 2 * 3_600_000, [0, 60_000, 30 * 60_000]))


def test_no_observations_at_all():
    assert cp.classify_path(0, 1000, []) == ["NO_OBSERVATIONS"]


def test_a_trade_expects_only_the_policies_of_the_registry_it_was_recorded_under():
    v1 = cp.expected_policies(pol.REGISTRY, "EXIT-POLICIES-V1")
    v2 = cp.expected_policies(pol.REGISTRY, "EXIT-POLICIES-V2")
    v3 = cp.expected_policies(pol.REGISTRY, "EXIT-POLICIES-V3")
    assert len(v1) == 18 and set(v1) < set(v2) and len(v2) == 22 and set(v2) < set(v3) and len(v3) == len(pol.REGISTRY) == 28
    assert cp.expected_policies(pol.REGISTRY, None) == sorted(pol.REGISTRY)


# ---- through the real engine ---------------------------------------------------------
def test_every_new_paper_trade_creates_its_full_research_linkage(db):
    t = now_ms() - 120_000
    app, trade = open_trade(db, t)
    app.state.paper.tick("ETH-PERP", 101.0, now_ms(), LIVE)
    app.state.paper.tick("ETH-PERP", 89.0, now_ms(), LIVE)          # stop: the trade closes
    report = cp.assess(ro(db), installed_at_ms=0)
    (row,) = [x for x in report["trades"] if x["trade_id"] == trade["trade_id"]]
    assert row["status"] == "CLOSED"
    assert row["label"] == cp.COMPLETE, row
    assert row["finalized_replays"] == row["expected_replays"] == len(pol.REGISTRY)
    assert report["pipeline_status"] == "OK"
    assert report["eligible_trade_ids"] == [trade["trade_id"]]


def test_a_trade_opened_before_the_shadow_was_installed_is_legacy_and_excluded_from_3h(db):
    t = now_ms() - 120_000
    app, trade = open_trade(db, t)
    app.state.paper.tick("ETH-PERP", 101.0, now_ms(), LIVE)
    app.state.paper.tick("ETH-PERP", 89.0, now_ms(), LIVE)
    installed_after_open = t + 10_000
    report = cp.assess(ro(db), installed_at_ms=installed_after_open)
    (row,) = report["trades"]
    assert row["label"] == cp.LEGACY and row["reasons"] == ["OPENED_BEFORE_EXIT_SHADOW_INSTALLED"]
    assert report["pipeline_status"] == "OK"                        # legacy is labelled, not a pipeline failure
    result = cp.evaluate_eligible(ro(db), installed_at_ms=installed_after_open)
    assert result["trades_with_baseline"] == 0
    assert [e["trade_id"] for e in result["evidence_integrity"]["excluded"]] == [trade["trade_id"]]


def test_a_post_install_trade_with_a_late_path_degrades_the_pipeline_and_names_it(db):
    t = now_ms() - 4 * 3_600_000
    app, trade = open_trade(db, t)
    app.state.paper.tick("ETH-PERP", 89.0, now_ms(), LIVE)          # first observation four hours after entry
    report = cp.assess(ro(db), installed_at_ms=0)
    (row,) = report["trades"]
    assert row["status"] == "CLOSED"
    assert row["label"] == cp.PATH_INCOMPLETE and any(x.startswith("STARTS_LATE") for x in row["reasons"])
    assert report["pipeline_status"] == cp.DEGRADED
    assert report["degraded_trades"][0]["trade_id"] == trade["trade_id"]
    assert report["eligible_trade_ids"] == []


def test_a_missing_policy_replay_is_reported_with_its_exact_name(db):
    t = now_ms() - 120_000
    app, trade = open_trade(db, t)
    dropped = "MFE_TRAIL_33"
    shadow = app.state.paper.exit_shadow
    shadow.registry = {k: v for k, v in pol.REGISTRY.items() if k != dropped}
    app.state.paper.tick("ETH-PERP", 101.0, now_ms(), LIVE)
    app.state.paper.tick("ETH-PERP", 89.0, now_ms(), LIVE)
    report = cp.assess(ro(db), installed_at_ms=0)
    (row,) = report["trades"]
    assert row["label"] == cp.REPLAYS_MISSING and row["missing_policies"] == [dropped]
    assert report["pipeline_status"] == cp.DEGRADED
    assert report["degraded_trades"][0]["missing_policies"] == [dropped]
    assert cp.eligible_records(ExitStore(ro(db)).finalized_records(), report) == []


def test_open_trades_are_never_evidence(db):
    t = now_ms() - 120_000
    app, trade = open_trade(db, t)
    app.state.paper.tick("ETH-PERP", 101.0, now_ms(), LIVE)
    report = cp.assess(ro(db), installed_at_ms=0)
    assert report["trades"][0]["label"] == cp.OPEN and report["eligible_trade_ids"] == []


def test_assessment_never_writes(db):
    t = now_ms() - 120_000
    app, _ = open_trade(db, t)
    app.state.paper.tick("ETH-PERP", 89.0, now_ms(), LIVE)
    with closing(sqlite3.connect(db)) as c:
        before = c.execute("PRAGMA data_version").fetchone()[0]
    cp.assess(ro(db), installed_at_ms=0)
    cp.evaluate_eligible(ro(db), installed_at_ms=0)                 # a read-only connection cannot write; this must simply work
    with closing(sqlite3.connect(db)) as c:
        assert c.execute("PRAGMA data_version").fetchone()[0] == before


def test_integrity_and_evaluation_endpoints_expose_the_labels(db):
    app = create_app(db_path=db, risk_limits=WIDE)
    client = TestClient(app)
    r = client.get("/research/exit-policies/integrity", headers=HEADERS)
    assert r.status_code == 200 and r.json()["pipeline_status"] == "OK" and r.json()["trades"] == []
    e = client.get("/research/exit-policies/evaluation", headers=HEADERS).json()
    assert e["evidence_integrity"]["pipeline_status"] == "OK"
    assert e["evidence_bar"]["min_independent_episodes"] == 30    # the bar is unchanged
