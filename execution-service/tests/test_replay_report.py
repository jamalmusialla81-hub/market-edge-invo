"""DATA 16 (#65): read-only reproduction report. Assembles what was recorded; says so plainly when a field was not."""
import hashlib
import json
import os
import shutil
import sqlite3
from contextlib import closing

from fastapi.testclient import TestClient

from market_edge_exec.buildinfo import build_info
from market_edge_exec.replay import report as R
from tests.test_data_ingestion import run_trade
from tests.test_shadow import HEADERS

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")


def digest(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def paths(app):
    return app.state.ledger.path, app.state.shadow.path


def test_a_full_report_for_a_trade_with_complete_provenance(tmp_path):
    app = run_trade(tmp_path)
    led, sh = paths(app)
    r = R.build_report("sig-1", ledger_path=led, shadow_path=sh)
    assert r["found"] and r["identity"]["kind"] == "TRADE" and r["identity"]["signal_id"] == "sig-1"
    assert r["identity"]["scan_id"] and r["identity"]["observation_id"]
    sha = build_info().get("git_sha")
    assert r["source_commit"] == {"recorded": True, "value": sha}
    obs, scan = r["shadow"]["observation"], r["shadow"]["scan"]
    assert obs["source_commit"]["value"] == sha and scan["source_commit"]["value"] == sha
    for k in ("generator_version", "feature_version", "model_version", "dataset_version"):
        assert obs["versions"][k]["recorded"] is True and scan["versions"][k]["recorded"] is True
    assert obs["decision_hash_ok"] is True and obs["decision_time_inputs"]["features"] is not None and obs["asset"] == "ETH"
    d = r["decision"]
    assert d["entry_fill"]["recorded"] and d["stop"]["value"] == 90.0 and d["tp1"]["value"] == 110.0 and d["direction"]["value"] == "long" and d["quantity"]["value"] > 0
    assert r["market_inputs"]["market_price_source"]["value"] == "HYPERLIQUID_ALLMIDS_LIVE" and r["market_inputs"]["market_price_timestamp"]["recorded"]
    assert r["risk_policy_version"]["recorded"] and r["sizing_mode"]["recorded"]
    roles = {s["role"] for s in r["sizing"]}
    assert "AUTHORITATIVE" in roles and all(s["source_commit"]["value"] == sha for s in r["sizing"])
    assert isinstance(r["exit_policies"], list) and r["exit_policies"] and all(e["used_for_execution"] is False and e["counterfactual"] for e in r["exit_policies"])
    assert r["post_entry_price_path"]["recorded"] and r["post_entry_price_path"]["observations"] >= 2
    assert r["status"] == "CLOSED" and r["read_only"] is True


def test_the_same_report_is_reachable_by_trade_signal_and_scan_id(tmp_path):
    app = run_trade(tmp_path)
    led, sh = paths(app)
    by_trade = R.build_report("sig-1", ledger_path=led, shadow_path=sh, now_ms=1)
    scan_id = by_trade["identity"]["scan_id"]
    by_scan = R.build_report(scan_id, ledger_path=led, shadow_path=sh, now_ms=1)
    assert by_scan["identity"]["kind"] == "SCAN" and by_scan["shadow"]["scan"]["submitted_signal_id"] == "sig-1"
    assert any(o["asset"] == "ETH" and o["execution_status"] for o in by_scan["scan_observations"])
    assert by_scan["shadow"]["scan"] == by_trade["shadow"]["scan"]
    assert R.build_report("nope", ledger_path=led, shadow_path=sh)["found"] is False


def test_no_post_outcome_labels_appear_in_the_report(tmp_path):
    app = run_trade(tmp_path)
    r = R.build_report("sig-1", ledger_path=paths(app)[0], shadow_path=paths(app)[1])
    text = json.dumps(r)
    for leaked in ("policy_r", "mfe_r", "mae_r", "best_achievable_r", "executable_within_stop_r", "FUTURE_LABEL_DATA", "POST_OUTCOME_RESEARCH_ONLY"):
        assert leaked not in text, leaked
    assert r["shadow"]["observation"]["outcome_status"]["note"].startswith("post-outcome labels are deliberately not shown")


def old_era_copy(app, tmp_path):
    """The same trade as an older build would have left it: no source commit, no sizing or exit records, sparse payloads."""
    led, sh = tmp_path / "old_l.sqlite3", tmp_path / "old_s.sqlite3"
    shutil.copy(app.state.ledger.path, led)
    shutil.copy(app.state.shadow.path, sh)
    with closing(sqlite3.connect(sh)) as c:
        for (name,) in c.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall():
            c.execute(f"DROP TRIGGER {name}")
        c.execute("UPDATE shadow_scans SET source_commit=NULL, model_version=NULL")
        c.execute("UPDATE shadow_observations SET source_commit=NULL, model_version=NULL")
        c.commit()
    with closing(sqlite3.connect(led)) as c:
        for (name,) in c.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall():
            c.execute(f"DROP TRIGGER {name}")
        c.execute("DELETE FROM risk_sizing_decisions")
        c.execute("DELETE FROM exit_policy_counterfactuals")
        c.execute("DELETE FROM exit_path_observations")
        row = c.execute("SELECT trade_id, payload FROM paper_trades").fetchone()
        p = json.loads(row[1])
        for k in ("market_price_source", "market_price_timestamp", "risk_policy_version", "sizing_mode", "mark_at_entry"):
            p.pop(k, None)
        c.execute("UPDATE paper_trades SET payload=? WHERE trade_id=?", (json.dumps(p), row[0]))
        c.commit()
    return str(led), str(sh)


def test_an_older_incomplete_trade_reports_missing_fields_as_not_recorded_never_fabricated(tmp_path):
    app = run_trade(tmp_path)
    led, sh = old_era_copy(app, tmp_path)
    r = R.build_report("sig-1", ledger_path=led, shadow_path=sh)
    assert r["found"]
    assert r["source_commit"]["recorded"] is False and "predate" in r["source_commit"]["note"]
    assert r["shadow"]["observation"]["versions"]["model_version"] == {"recorded": False, "note": "not recorded"}
    for k in ("market_price_source", "market_price_timestamp"):
        assert r["market_inputs"][k]["recorded"] is False and "not recorded" in r["market_inputs"][k]["note"]
    assert r["risk_policy_version"]["recorded"] is False and r["sizing_mode"]["recorded"] is False
    assert r["sizing"]["recorded"] is False and r["exit_policies"]["recorded"] is False and r["post_entry_price_path"]["recorded"] is False
    assert r["decision"]["stop"]["value"] == 90.0          # what WAS recorded is still there, unmodified
    gaps = set(r["gaps"])
    assert {"source_commit", "risk_policy_version", "sizing", "exit_policies", "market_inputs.market_price_source"} <= gaps
    assert "recorded\": true, \"value\": null" not in json.dumps(r).replace("'", '"')      # no null presented as a recorded value


def test_zero_and_false_count_as_recorded_and_none_does_not():
    assert R.rec(0, "n") == {"recorded": True, "value": 0} and R.rec(False, "n")["recorded"] is True and R.rec("", "n")["recorded"] is True
    assert R.rec(None, "why") == {"recorded": False, "note": "why"}


def test_the_report_never_writes_to_either_database(tmp_path):
    app = run_trade(tmp_path)
    led, sh = paths(app)
    before = (digest(led), digest(sh), os.stat(led).st_mtime_ns, os.stat(sh).st_mtime_ns)
    R.build_report("sig-1", ledger_path=led, shadow_path=sh)
    R.build_report(R.build_report("sig-1", ledger_path=led, shadow_path=sh)["identity"]["scan_id"], ledger_path=led, shadow_path=sh)
    assert (digest(led), digest(sh), os.stat(led).st_mtime_ns, os.stat(sh).st_mtime_ns) == before
    conn = R._ro(led)
    try:
        import pytest
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute("DELETE FROM paper_trades")
    finally:
        conn.close()


def test_a_missing_database_is_reported_not_invented(tmp_path):
    app = run_trade(tmp_path)
    r = R.build_report("sig-1", ledger_path=paths(app)[0], shadow_path=str(tmp_path / "does-not-exist.sqlite3"))
    assert r["found"] and r["shadow"]["scan"]["recorded"] is False and "no shadow-learning database" in r["shadow"]["scan"]["note"]
    assert r["source_commit"]["recorded"] is True       # the sizing record still carries it


def test_the_api_serves_the_same_report_and_404s_gracefully(tmp_path):
    app = run_trade(tmp_path)
    client = TestClient(app)
    r = client.get("/research/replay", params={"id": "sig-1"}, headers=HEADERS).json()
    assert r["found"] and r["identity"]["trade_id"] == "sig-1" and r["label"].startswith("READ-ONLY REPRODUCTION REPORT")
    assert client.get("/research/replay", params={"id": "zzz"}, headers=HEADERS).json()["found"] is False


def test_the_module_recomputes_nothing():
    src = open(R.__file__).read()
    for banned in ("from market_edge_exec.risk", "from market_edge_exec.exits", "quant_engine", "INSERT", "UPDATE ", "DELETE ", "sizing_v2", "replay(", "import requests", "httpx"):
        assert banned not in src.replace("UPDATE shadow", ""), banned
