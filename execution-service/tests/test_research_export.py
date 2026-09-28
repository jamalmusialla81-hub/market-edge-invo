"""SIDE 6 (#35): read-only research export. Decision-time, outcome and
hindsight data land in separate files; the databases are never written."""
import csv
import hashlib
import json
import os

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.export import research as X
from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow import resolve as R
from market_edge_exec.shadow.store import ShadowStore
from tests.test_shadow import BAR, HEADERS, T0, bars_path, candidate, decision, scan_payload


def _trade(trade_id="scan-1-ETH"):
    return {"trade_id": trade_id, "instrument": "ETH-PERP", "asset": "ETH", "status": "OPEN", "direction": "long",
            "opened_at_ms": T0, "closed_at_ms": None, "entry_fill": 100.0, "quantity": 1.0, "fees": 0.05,
            "stop": 98.0, "tp1": 102.0, "tp2": 104.0}


def _seed(tmp_path):
    paper_db, shadow_db = str(tmp_path / "paper.sqlite3"), str(tmp_path / "shadow.sqlite3")
    ledger = PaperLedger(paper_db)
    ledger.open_trade(_trade())
    ledger.record_hindsight("scan-1-ETH", T0 + 10 * BAR, "USL-shadow", {"optimal_tp1": 112.5})
    store = ShadowStore(shadow_db)
    store.record_scan(scan_payload(observations=[
        {"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate())},
        {"kind": "MARKET_STATE", "asset": "BTC", "production_state": "NO_TRADE", "decision": decision()}]))
    first = R.first_bar_open(T0)
    closes = [100 + min(i, 60) * 0.1 for i in range(C.FULL_WINDOW_MS // BAR + 2)]
    store.resolve("BTC", bars_path(first, closes, spread=0.05), "HYPERLIQUID", "5m", now_ms=T0 + C.FULL_WINDOW_MS + C.HOUR)
    return paper_db, shadow_db


def _digest(path):
    h = hashlib.sha256()
    for suffix in ("", "-wal"):
        if os.path.exists(path + suffix):
            h.update(open(path + suffix, "rb").read())
    return h.hexdigest()


def _csv(folder, name):
    with open(os.path.join(folder, name), newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def test_csv_export_separates_decision_outcome_and_hindsight(tmp_path):
    paper_db, shadow_db = _seed(tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    m = X.export_research(paper_db, shadow_db, str(out), now=1_790_000_000)
    names = {f["file"] for f in m["files"]}
    assert names == {f"{stem}.csv" for stem, *_ in X.FILES}
    assert m["read_only"] and {c["category"] for c in m["not_yet_available"]} == {"risk_sizing", "adaptive_exit_counterfactuals"}
    folder = m["folder"]
    assert os.path.basename(folder) == "market-edge-research-20260921T141320Z"
    assert json.load(open(os.path.join(folder, "manifest.json"))) == m

    decisions = _csv(folder, "DECISION__shadow_observations.csv")
    assert {r["kind"] for r in decisions} == {"CANDIDATE", "MARKET_STATE"}
    # decision-time rows carry no outcome or hindsight columns...
    assert not any(c for c in decisions[0] if "classification" in c or "hindsight" in c or "label" in c)
    for r in decisions:
        assert not C.is_hindsight_name(r["decision_json"]) and "optimal" not in r["decision_json"]
        assert json.loads(r["decision_json"])["market"]["price"] == 100.0
    # ...labels and hindsight live in their own files, keyed by observation_id
    labels = _csv(folder, "OUTCOME__shadow_labels.csv")
    assert len(labels) == 8 and {r["batch"] for r in labels} == {"B1", "B2", "B3", "B4"}
    hindsight = _csv(folder, "HINDSIGHT__shadow_post_outcome_research_only.csv")
    assert {r["classification"] for r in hindsight} == {"GOOD_TRADE_MISSED", "MISSED_OPPORTUNITY"}
    assert {r["observation_id"] for r in hindsight} == {r["observation_id"] for r in decisions}
    trades = _csv(folder, "LEDGER__paper_trades.csv")
    assert [t["trade_id"] for t in trades] == ["scan-1-ETH"] and "optimal_tp1" not in trades[0]["trade_json"]
    ph = _csv(folder, "HINDSIGHT__paper_post_outcome_research_only.csv")
    assert json.loads(ph[0]["hindsight_json"]) == {"optimal_tp1": 112.5}
    events = _csv(folder, "OUTCOME__paper_trade_events.csv")
    assert [e["kind"] for e in events] == ["ENTRY"]
    counts = {f["file"]: f["rows"] for f in m["files"]}
    assert counts["DECISION__shadow_observations.csv"] == 2 and counts["DECISION__shadow_scans.csv"] == 1


def test_export_never_writes_to_either_database(tmp_path):
    paper_db, shadow_db = _seed(tmp_path)
    before = (_digest(paper_db), _digest(shadow_db))
    out = tmp_path / "out"
    out.mkdir()
    X.export_research(paper_db, shadow_db, str(out), now=1)
    X.export_research(paper_db, shadow_db, str(out), now=2)
    assert (_digest(paper_db), _digest(shadow_db)) == before


def test_export_reads_no_settings_or_secret_tables():
    sources = " ".join(sql for _, _, sql, _ in X.FILES).lower()
    for forbidden in ("control_settings", "settings", "secret", "api_key", "control_audit"):
        assert forbidden not in sources
    for _, _, sql, _ in X.FILES:
        assert "select *" not in sql.lower()   # columns are named, never picked up implicitly


def test_export_refuses_bad_targets_and_never_overwrites(tmp_path):
    paper_db, shadow_db = _seed(tmp_path)
    with pytest.raises(ValueError, match="OUT_DIR_INVALID"):
        X.export_research(paper_db, shadow_db, "relative/dir")
    with pytest.raises(ValueError, match="OUT_DIR_INVALID"):
        X.export_research(paper_db, shadow_db, str(tmp_path / "missing"))
    with pytest.raises(ValueError, match="UNSUPPORTED_FORMAT"):
        X.export_research(paper_db, shadow_db, str(tmp_path), fmt="xlsx")
    X.export_research(paper_db, shadow_db, str(tmp_path), now=5)
    with pytest.raises(FileExistsError):
        X.export_research(paper_db, shadow_db, str(tmp_path), now=5)


def test_missing_shadow_database_exports_paper_and_reports_what_was_skipped(tmp_path):
    paper_db, _ = _seed(tmp_path)
    m = X.export_research(paper_db, str(tmp_path / "none.sqlite3"), str(tmp_path), now=9)
    assert {f["file"] for f in m["files"]} == {"LEDGER__paper_trades.csv", "OUTCOME__paper_trade_events.csv",
                                               "HINDSIGHT__paper_post_outcome_research_only.csv"}
    assert all(s["reason"] == "no shadow database" for s in m["skipped"]) and len(m["skipped"]) == 6


@pytest.mark.skipif(not X.parquet_available(), reason="pyarrow not importable")
def test_parquet_export_matches_csv_rows(tmp_path):
    import pyarrow.parquet as pq
    paper_db, shadow_db = _seed(tmp_path)
    m = X.export_research(paper_db, shadow_db, str(tmp_path), fmt="parquet", now=11)
    table = pq.read_table(os.path.join(m["folder"], "DECISION__shadow_observations.parquet"))
    assert table.num_rows == 2 and "decision_json" in table.column_names


def test_endpoint_exports_via_the_app_and_rejects_bad_input(tmp_path):
    os.environ["MARKET_EDGE_SHADOW_DB"] = str(tmp_path / "shadow.sqlite3")
    try:
        app = create_app(db_path=str(tmp_path / "paper.sqlite3"))
    finally:
        del os.environ["MARKET_EDGE_SHADOW_DB"]
    client = TestClient(app)
    info = client.get("/research/export", headers=HEADERS).json()
    assert "csv" in info["formats"] and len(info["not_yet_available"]) == 2
    assert client.post("/research/export", json={"out_dir": str(tmp_path)}).status_code == 401
    r = client.post("/research/export", headers=HEADERS, json={"out_dir": str(tmp_path), "format": "csv"})
    assert r.status_code == 200 and r.json()["read_only"] is True
    assert os.path.isfile(os.path.join(r.json()["folder"], "DECISION__shadow_observations.csv"))
    assert client.post("/research/export", headers=HEADERS, json={"out_dir": "nope"}).status_code == 422
