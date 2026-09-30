"""TASK M: the linkage audit reports every paper trade's provenance chain without writing or guessing anything."""
import hashlib
import json
import os
import sqlite3

import pytest

from market_edge_exec.api.app import create_app
from market_edge_exec.evidence import linkage_audit as L
from market_edge_exec.shadow.store import ShadowStore

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"
T = 1_800_000_000_000
H = 3_600_000


def add_trade(pc, sid, opened, *, signal=True, fill=True, sizing=("AUTHORITATIVE", "COUNTERFACTUAL"), exits=("EXIT-V1",)):
    tid = f"{sid}-SOL"
    pc.execute("INSERT INTO paper_trades VALUES (?,?,?,?,?,?)", (tid, "SOL-PERP", "CLOSED", opened, None, json.dumps({"signal_id": sid})))
    if signal:
        pc.execute("INSERT INTO paper_signals (signal_id, at_ms, outcome, payload) VALUES (?,?,?,?)", (sid, opened, "EXECUTED", "{}"))
    if fill:
        pc.execute("INSERT INTO fills VALUES (?,?,?,?)", (f"fill-{sid}", sid, "{}", 0.0))
    for role in sizing:
        pc.execute("INSERT INTO risk_sizing_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (f"dec-{sid}-{role}", sid, "SOL", "SHADOW", role, "V2", 1, None, opened, "{}", "h", None))
    for v in exits:
        pc.execute("INSERT INTO exit_policy_counterfactuals VALUES (?,?,?,?,?,?,?,?,?)", (tid, v, "OK", 1, opened, 0, "{}", "{}", "{}"))
    return tid


def add_shadow(sc, sid, opened, *, status="RESOLVED", labels=True, obs=True, scan_sig=None, decision_hash="dh"):
    scan, oid = f"scan-{sid}", f"obs-{sid}"
    sc.execute("INSERT INTO shadow_scans VALUES (" + ",".join("?" * 17) + ")",
               (scan, opened, "OK", "{}", "EXECUTED", None, scan_sig or sid, 1, 1, None, "g", "f", None, "d", b"{}", opened, None))
    if obs:
        sc.execute("INSERT INTO shadow_observations VALUES (" + ",".join("?" * 30) + ")",
                   (oid, scan, "CANDIDATE", "SOL", "SOL", "long", "T", opened, opened, 1, 1, 1, None, "EXECUTED", None, 1, None,
                    "c", "e", 0.0, "g", "f", None, "d", "V", "5m", b"{}", decision_hash, opened, None))
        sc.execute("INSERT INTO shadow_resolution VALUES (?,?,?,?,?,?,?)", (oid, "SOL", opened, "[]", status, None, opened))
        if labels:
            sc.execute("INSERT INTO shadow_labels VALUES (?,?,?,?,?,?,?,?,?)", (oid, "24h", opened + 24 * H, "OK", "L", "d", b"{}", "lh", opened))
    sc.execute("INSERT INTO forward_paper_executed VALUES (?,?,?,?,?,?,?)", (sid, oid if obs else None, scan, opened, "d", b"{}", opened))


@pytest.fixture()
def dbs(tmp_path):
    paper, shadow = str(tmp_path / "paper.db"), str(tmp_path / "shadow.db")
    create_app(db_path=paper, sizing_mode="SHADOW")
    ShadowStore(shadow)
    return paper, shadow


def run(dbs, fn):
    pc, sc = sqlite3.connect(dbs[0]), sqlite3.connect(dbs[1])
    fn(pc, sc)
    pc.commit(), sc.commit(), pc.close(), sc.close()


def by_trade(report):
    return {r["trade_id"]: r for r in report["results"]}


def test_fully_linked_trade_resolves_every_required_id(dbs):
    def build(pc, sc):
        add_trade(pc, "a", T)
        add_shadow(sc, "a", T)
    run(dbs, build)
    r = by_trade(L.audit(*dbs))["a-SOL"]
    assert r["fully_linked"]
    assert set(r["links"]) == set(L.CHECKS)
    assert all(v["status"] == L.LINKED for v in r["links"].values()), r["links"]
    assert r["links"]["risk_decision_id"]["value"] == {"AUTHORITATIVE": "dec-a-AUTHORITATIVE", "COUNTERFACTUAL": "dec-a-COUNTERFACTUAL"}
    assert L.audit(*dbs)["gaps"] == []


def test_old_trade_without_shadow_or_sizing_is_legacy_with_a_specific_reason(dbs):
    def build(pc, sc):
        add_trade(pc, "old", T, sizing=(), exits=())
        add_trade(pc, "new", T + H)
        add_shadow(sc, "new", T + H)
    run(dbs, build)
    rep = L.audit(*dbs)
    old = by_trade(rep)["old-SOL"]
    assert not old["fully_linked"]
    for check in ("risk_decision_id", "exit_policy_version", "observation_id", "scan_id", "decision_hash", "resolved_labels"):
        assert old["links"][check]["status"] == L.LEGACY, check
    assert "opened before the earliest trade" in old["links"]["risk_decision_id"]["reason"]
    assert "forward_paper_executed" in old["links"]["observation_id"]["reason"]
    assert by_trade(rep)["new-SOL"]["fully_linked"]
    assert rep["gaps"] == []


def test_missing_is_distinguished_from_legacy(dbs):
    def build(pc, sc):
        add_trade(pc, "early", T)
        add_trade(pc, "late", T + H, exits=())  # exit shadow was recording for "early" but not for "late"
        add_shadow(sc, "early", T)
        add_shadow(sc, "late", T + H)
    run(dbs, build)
    rep = L.audit(*dbs)
    late = by_trade(rep)["late-SOL"]["links"]["exit_policy_version"]
    assert late["status"] == L.MISSING and "unexplained gap" in late["reason"]
    assert [(g["trade_id"], g["check"]) for g in rep["gaps"]] == [("late-SOL", "exit_policy_version")]


def test_no_link_anywhere_is_legacy_not_missing(dbs):
    run(dbs, lambda pc, sc: add_trade(pc, "solo", T, sizing=(), exits=()))
    rep = L.audit(*dbs)
    assert rep["gaps"] == []
    assert by_trade(rep)["solo-SOL"]["links"]["risk_decision_id"]["status"] == L.LEGACY


def test_without_a_shadow_database_shadow_links_are_not_checked(dbs):
    run(dbs, lambda pc, sc: add_trade(pc, "a", T))
    rep = L.audit(dbs[0])
    links = by_trade(rep)["a-SOL"]["links"]
    for check in ("scan_id", "observation_id", "decision_hash", "resolved_labels"):
        assert links[check]["status"] == L.NOT_CHECKED
    assert not rep["shadow_checked"] and not by_trade(rep)["a-SOL"]["fully_linked"]


def test_unresolved_labels_are_pending_not_missing(dbs):
    def build(pc, sc):
        add_trade(pc, "a", T)
        add_shadow(sc, "a", T, status="PENDING", labels=False)
    run(dbs, build)
    r = by_trade(L.audit(*dbs))["a-SOL"]
    assert r["links"]["resolved_labels"]["status"] == L.PENDING
    assert r["fully_linked"] and L.audit(*dbs)["gaps"] == []


def test_broken_links_are_missing_and_never_guessed(dbs):
    def build(pc, sc):
        add_trade(pc, "a", T)
        add_shadow(sc, "a", T, scan_sig="someone-else")          # scan points at a different signal
        add_trade(pc, "b", T + H)
        add_shadow(sc, "b", T + H, obs=False)                    # executed row without an observation
        add_trade(pc, "c", T + 2 * H, sizing=("COUNTERFACTUAL",))  # no authoritative decision
        add_shadow(sc, "c", T + 2 * H)
    run(dbs, build)
    res = by_trade(L.audit(*dbs))
    assert res["a-SOL"]["links"]["scan_id"]["status"] == L.MISSING
    assert res["b-SOL"]["links"]["observation_id"]["status"] == L.MISSING
    assert res["b-SOL"]["links"]["resolved_labels"]["status"] == L.MISSING
    assert res["c-SOL"]["links"]["risk_decision_id"]["status"] == L.MISSING


def test_shadow_execution_without_a_paper_trade_is_reported(dbs):
    def build(pc, sc):
        add_trade(pc, "a", T)
        add_shadow(sc, "a", T)
        add_shadow(sc, "ghost", T + H)
    run(dbs, build)
    assert L.audit(*dbs)["shadow_executed_without_paper_trade"] == ["ghost"]


def digest(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest(), os.stat(path).st_mtime_ns


def test_audit_never_writes_to_a_source_database(dbs, capsys):
    def build(pc, sc):
        add_trade(pc, "a", T)
        add_shadow(sc, "a", T)
    run(dbs, build)
    before = [digest(p) for p in dbs]
    L.audit(*dbs)
    assert L.main([dbs[0], "--shadow", dbs[1]]) == 0
    assert L.main([dbs[0], "--shadow", dbs[1], "--json"]) == 0
    assert "Trades audited" in capsys.readouterr().out
    assert [digest(p) for p in dbs] == before
    # and the connection itself is read-only
    conn = L._connect_ro(dbs[0])
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("DELETE FROM paper_trades")
    conn.close()


def test_a_non_paper_database_is_refused(tmp_path):
    p = str(tmp_path / "x.db")
    sqlite3.connect(p).execute("CREATE TABLE t (a)").connection.commit()
    with pytest.raises(ValueError, match="NOT_A_PAPER_DATABASE"):
        L.audit(p)
