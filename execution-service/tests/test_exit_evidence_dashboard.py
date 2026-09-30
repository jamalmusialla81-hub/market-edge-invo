"""Exit-evidence dashboard data (#122): read-only, honest with empty, partial and degraded data."""
import os
import sqlite3
from contextlib import closing

from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.exits import evidence_dashboard as ed
from market_edge_exec.exits import shadow_replay as SR
from market_edge_exec.shadow.store import ShadowStore
from tests.test_shadow_exit_replay import NOW, T0, WIN, HEADERS, obs, payload

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"


def test_empty_database_says_none_pass_and_creates_nothing(tmp_path):
    client = TestClient(create_app(db_path=str(tmp_path / "p.sqlite3")))
    body = client.get("/research/exit-evidence", headers=HEADERS).json()
    assert body["label"] == "POST-OUTCOME RESEARCH ONLY · NOT AN ACTION THE BOT TOOK" and body["read_only"] is True
    g = body["gate"]
    assert (g["paper_finalized"], g["paper_finalized_needed"], g["independent_episodes"], g["independent_episodes_needed"]) == (0, 30, 0, 30)
    assert g["passing_policies"] == [] and g["passing_summary"] == "NONE"
    assert body["adaptive_exits_enabled"] == {"PAPER": False, "PAPER_CANARY": False}
    assert body["pipeline"]["status"] == "OK" and body["shadow"]["raw_observations"] == 0 and body["daily"] == []
    shadow_db = [f for f in os.listdir(tmp_path) if "shadow" in f][0]
    with closing(sqlite3.connect(str(tmp_path / shadow_db))) as conn:   # a read must not create the replay table
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='shadow_exit_replays'").fetchone() is None


def test_partial_data_counts_cohorts_separately_and_shows_acceleration(tmp_path):
    client = TestClient(create_app(db_path=str(tmp_path / "p.sqlite3")))
    assert client.post("/shadow/scan", json=payload("s1", T0, [obs("BTC", reason="RANK_BELOW_SELECTED"), obs("ETH", reason="NO_SIGNAL_THIS_SCAN")]),
                       headers=HEADERS).status_code == 200
    for coin in ("BTC", "ETH"):
        assert client.post("/shadow/resolve", json={"coin": coin, "venue": "HYPERLIQUID", "interval": "5m", "candles": WIN, "now_ms": NOW},
                           headers=HEADERS).json()["exit_replay"]["finalized"] == 1
    body = client.get("/research/exit-evidence", headers=HEADERS).json()
    assert body["shadow"]["candidate_observations"] == 2
    assert body["shadow"]["candidates_not_executed_for_a_selection_reason"] == 1 and body["shadow"]["candidates_research_only"] == 1
    assert body["executable_shadow"][SR.COHORT_B]["replayed_observations"] == 1 and body["executable_shadow"][SR.COHORT_C]["replayed_observations"] == 1
    assert body["gate"]["paper_finalized"] == 0                       # cohorts B and C never count toward the paper bar
    assert "never count toward the paper bar" in body["cohort_B_C_note"]
    assert sum(d["shadow_replays"] for d in body["daily"]) == 2
    assert body["current_vs_adaptive"] and all(v["verdict"] == "INSUFFICIENT_EVIDENCE" for v in body["current_vs_adaptive"].values())


def test_a_degraded_pipeline_is_reported_with_the_missing_trade_ids(tmp_path, monkeypatch):
    from market_edge_exec.exits import completeness as cp
    real = cp.assess

    def degraded(connect, *a, **k):
        report = real(connect, *a, **k)
        report["pipeline_status"] = cp.DEGRADED
        report["degraded_trades"] = [{"trade_id": "sig-9", "label": cp.PATH_INCOMPLETE, "reasons": ["GAP_OF_90MIN"], "missing_policies": []}]
        return report
    monkeypatch.setattr(cp, "assess", degraded)
    client = TestClient(create_app(db_path=str(tmp_path / "p.sqlite3")))
    body = client.get("/research/exit-evidence", headers=HEADERS).json()
    assert body["pipeline"]["status"] == "RESEARCH_PIPELINE_DEGRADED" and body["pipeline"]["degraded_trades"][0]["trade_id"] == "sig-9"


def test_the_dashboard_has_no_write_path():
    src = open(ed.__file__).read()
    assert "INSERT" not in src.upper().replace("INSERT_", "") and "UPDATE " not in src.upper() and "DELETE" not in src.upper()
