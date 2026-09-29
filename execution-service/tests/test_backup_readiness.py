"""#74: evidence readiness from a desktop backup. Validates like restore, reads only, flips nothing."""
import hashlib
import json
import os
import zipfile

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.evidence import backup_readiness as BR
from tests.test_risk_sizing_v2_paper import post
from tests.test_sizing_review import _ledger, _stop_out
from tests.test_snapshot_builder import make_source


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def make_backup(tmp_path, paper, shadow=None, name="b.mebackup", **manifest_overrides):
    """Built the way desktop/src-tauri/src/backup.rs export() builds one."""
    manifest = {"format": "market-edge-backup", "format_version": 2, "created_at": "2026-09-29T06:00:00Z", "app_version": "0.3.0",
                "git_sha": "abc1234", "schema_version": 7, "db_sha256": sha(paper), "db_bytes": os.path.getsize(paper), "counts": {},
                "starting_equity": 10000, "secrets_included": False, "contents": ["manifest.json", BR.PAPER_ENTRY, "settings.json"],
                "shadow_included": shadow is not None, "shadow_sha256": sha(shadow) if shadow else None, "cloud_backup": False}
    manifest.update(manifest_overrides)
    path = str(tmp_path / name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest))
        z.writestr("settings.json", "{}")
        z.write(paper, BR.PAPER_ENTRY)
        if shadow:
            z.write(shadow, BR.SHADOW_ENTRY)
    return path


@pytest.fixture
def dbs(tmp_path):
    paper = str(tmp_path / "paper.sqlite3")
    c = TestClient(create_app(db_path=paper, sizing_mode="SHADOW"))
    _stop_out(c, post(c, "x1", stop_pct=0.10)["trade"], 89.0)
    return paper, make_source(tmp_path, n_scans=6, extra_same_cluster=False).path


def status(report):
    return {g["task"]: g["status"] for g in report["gates"]}


def test_real_backup_reports_every_gate_from_the_reused_evaluators(tmp_path, dbs):
    paper, shadow = dbs
    backup = make_backup(tmp_path, paper, shadow)
    before = sha(backup), sha(paper), sha(shadow)
    r = BR.run(backup, str(tmp_path / "out"))
    assert status(r) == {"#25": "BLOCKED", "#26": "READY", "#27": "BLOCKED", "#28": "BLOCKED", "#29": "NOT_ASSESSABLE"}
    assert r["sizing_review"]["trades"] == 1 and r["sizing_review"]["verdict"] == "INSUFFICIENT_EVIDENCE"
    assert r["exit_evaluation"] is not None and r["forward_diagnostic"]["evidence"]["sufficient"] is False
    gate26 = next(g for g in r["gates"] if g["task"] == "#26")
    assert "INSUFFICIENT" in gate26["note"]
    assert (sha(backup), sha(paper), sha(shadow)) == before
    md = open(tmp_path / "out" / "readiness.md", encoding="utf-8").read()
    assert "| #27 MAJOR 6" in md and "Risk Sizing V2 forward review" in md and "Forward data diagnostic batch" in md
    assert json.load(open(tmp_path / "out" / "readiness.json", encoding="utf-8"))["readiness_version"] == BR.READINESS_VERSION


def test_enough_closed_shadow_trades_make_major6_ready(tmp_path, dbs):
    _, shadow = dbs
    paper = _ledger(tmp_path, [(1.0, 100.0, 0.8, 95.0, 50.0, True)] * 35)
    r = BR.run(make_backup(tmp_path, paper, shadow))
    assert status(r)["#27"] == "READY" and status(r)["#25"] == "BLOCKED"


def test_v1_backup_without_shadow_db_keeps_major5_blocked(tmp_path, dbs):
    paper, _ = dbs
    r = BR.run(make_backup(tmp_path, paper, None, format_version=1))
    assert status(r)["#26"] == "BLOCKED" and r["forward_diagnostic"] is None


@pytest.mark.parametrize("override, message", [
    ({"db_sha256": "0" * 64}, "checksum mismatch"),
    ({"secrets_included": True}, "secrets"),
    ({"format": "something-else"}, "unknown backup format"),
    ({"format_version": 3}, "newer"),
])
def test_bad_backups_are_rejected(tmp_path, dbs, override, message):
    paper, shadow = dbs
    with pytest.raises(BR.BackupRejected, match=message):
        BR.run(make_backup(tmp_path, paper, shadow, **override))


def test_not_a_zip_is_rejected_and_cli_exits_2(tmp_path, capsys):
    bogus = tmp_path / "x.mebackup"
    bogus.write_text("hello")
    assert BR.main([str(bogus)]) == 2
    assert "backup rejected" in capsys.readouterr().err


def test_only_known_entries_are_extracted(tmp_path, dbs):
    paper, shadow = dbs
    backup = make_backup(tmp_path, paper, shadow)
    with zipfile.ZipFile(backup, "a") as z:
        z.writestr("../../escape.txt", "no")
    dest = tmp_path / "x"
    dest.mkdir()
    ext = BR.extract(backup, str(dest))
    # (SQLite may add its own -wal/-shm sidecars next to a WAL-mode file it opened)
    assert {f for f in os.listdir(dest) if not f.endswith(("-wal", "-shm"))} == {BR.PAPER_ENTRY, BR.SHADOW_ENTRY}
    assert "../../escape.txt" in ext["ignored_entries"] and not (tmp_path.parent / "escape.txt").exists()


def test_cli_prints_the_gate_table(tmp_path, dbs, capsys):
    paper, shadow = dbs
    assert BR.main([make_backup(tmp_path, paper, shadow)]) == 0
    out = capsys.readouterr().out
    assert "#26  READY" in out and "#29  NOT_ASSESSABLE" in out


def test_an_empty_shadow_database_does_not_make_major5_ready(tmp_path):
    paper, shadow = str(tmp_path / "p.sqlite3"), str(tmp_path / "s.sqlite3")
    create_app(db_path=paper, shadow_db_path=shadow)
    assert status(BR.run(make_backup(tmp_path, paper, shadow)))["#26"] == "BLOCKED"
