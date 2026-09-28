"""Schema versioning: an existing (pre-versioning) database is backed up and
migrated forward with every row intact; a failing migration rolls back and
leaves the database untouched; a database from a newer build is refused.
Nothing ever deletes the database."""
import json
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.persistence import migrations
from market_edge_exec.persistence.store import Store

KEY = "test-key"
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("MARKET_EDGE_EXEC_API_KEY", KEY)


def _legacy_db(path):
    """A v0 database as the desktop MVP left it: tables created by the stores,
    user_version never set, a real trade and a custom starting equity."""
    Store(str(path))
    ledger = PaperLedger(str(path))
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("UPDATE paper_account SET starting_equity = 25000 WHERE id = 1")
        conn.execute("INSERT INTO paper_trades (trade_id, instrument, status, opened_at_ms, payload) VALUES ('t-1', 'BTCUSDT-PERP', 'OPEN', 1, '{}')")
        conn.execute("INSERT INTO paper_signals (signal_id, at_ms, outcome, payload) VALUES ('s-1', 1, 'EXECUTED', '{}')")
        conn.commit()
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    return ledger


def _rows(path):
    with closing(sqlite3.connect(path)) as conn:
        return (conn.execute("SELECT trade_id, status FROM paper_trades").fetchall(),
                conn.execute("SELECT signal_id, outcome FROM paper_signals").fetchall(),
                conn.execute("SELECT starting_equity FROM paper_account").fetchone()[0])


def test_fresh_database_is_created_at_target_version_without_backup(tmp_path):
    db = tmp_path / "new.sqlite3"
    app = create_app(db_path=str(db))
    report = app.state.migration
    assert report.created and report.backup_path is None
    assert report.to_version == migrations.target_version() == migrations.current_version(str(db))
    assert not (tmp_path / "backups").exists()
    health = TestClient(app).get("/health").json()
    assert health["version"] == "0.1.0" and health["schema_version"] == report.to_version
    assert health["build"]["backend_version"] == "0.1.0"


def test_legacy_database_is_backed_up_then_migrated_with_data_preserved(tmp_path):
    db = tmp_path / "legacy.sqlite3"
    _legacy_db(db)
    before = _rows(db)
    app = create_app(db_path=str(db))
    report = app.state.migration
    assert report.from_version == 0 and report.to_version == migrations.target_version()
    assert report.applied == ["0001_baseline", "0002_schema_history_and_indexes", "0003_risk_sizing_v2"]
    assert _rows(db) == before
    backup = Path(report.backup_path)
    assert backup.is_file() and backup.parent == tmp_path / "backups"
    assert migrations.current_version(str(backup)) == 0 and _rows(backup) == before
    with closing(sqlite3.connect(db)) as conn:
        assert [r[0] for r in conn.execute("SELECT version FROM schema_history ORDER BY version")] == [1, 2, 3]
    # the service still reads the migrated data
    client = TestClient(app, headers={"X-API-Key": KEY})
    assert client.get("/risk/config").json()["starting_equity"] == 25000


def test_second_start_is_a_no_op(tmp_path):
    db = tmp_path / "x.sqlite3"
    create_app(db_path=str(db))
    again = create_app(db_path=str(db)).state.migration
    assert again.applied == [] and again.backup_path is None and not again.created


def test_failed_migration_rolls_back_and_keeps_database_and_backup(tmp_path):
    db = tmp_path / "legacy.sqlite3"
    _legacy_db(db)
    before = _rows(db)
    bad = tmp_path / "migrations"
    bad.mkdir()
    existing = migrations.load_migrations()
    for m in existing:
        (bad / f"{m.version:04d}_{m.name}.sql").write_text(m.sql)
    # a broken migration right after the real ones
    (bad / f"{max(m.version for m in existing) + 1:04d}_broken.sql").write_text("CREATE TABLE ok_so_far (x INTEGER);\nINSERT INTO no_such_table VALUES (1);\n")
    report = migrations.prepare(str(db), directory=bad)
    with pytest.raises(migrations.MigrationError, match="MIGRATION_FAILED"):
        migrations.apply(report, directory=bad)
    assert migrations.current_version(str(db)) == 0
    assert _rows(db) == before
    with closing(sqlite3.connect(db)) as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    assert "ok_so_far" not in names and "schema_history" not in names  # whole batch rolled back
    assert Path(report.backup_path).is_file()


def test_database_from_a_newer_build_is_refused_untouched(tmp_path):
    db = tmp_path / "future.sqlite3"
    create_app(db_path=str(db))
    with closing(sqlite3.connect(db)) as conn:
        conn.execute("PRAGMA user_version = 99")
        conn.commit()
    size, mtime = db.stat().st_size, db.stat().st_mtime_ns
    with pytest.raises(migrations.MigrationError, match="DB_SCHEMA_NEWER"):
        create_app(db_path=str(db))
    assert db.stat().st_size == size and db.stat().st_mtime_ns == mtime
    assert migrations.current_version(str(db)) == 99


def test_inspect_database_validates_backups(tmp_path):
    good = tmp_path / "good.sqlite3"
    create_app(db_path=str(good))
    result = migrations.inspect_database(str(good))
    assert result["ok"] and result["integrity"] == "ok" and result["counts"]["paper_trades"] == 0
    junk = tmp_path / "junk.sqlite3"
    junk.write_bytes(b"not a database at all" * 100)
    assert not migrations.inspect_database(str(junk))["ok"]
    empty = tmp_path / "empty.sqlite3"
    sqlite3.connect(empty).close()
    assert any("MISSING_TABLES" in p for p in migrations.inspect_database(str(empty))["problems"])
    assert migrations.inspect_database(str(tmp_path / "nope.sqlite3"))["error"] == "NOT_FOUND"


def test_cli_backup_validate_and_migrate(tmp_path):
    db = tmp_path / "legacy.sqlite3"
    _legacy_db(db)
    env = {**os.environ, "PYTHONPATH": str(ROOT)}

    def run(*args):
        out = subprocess.run([sys.executable, str(ROOT / "run_server.py"), *args], capture_output=True, text=True, env=env, cwd=tmp_path)
        return out.returncode, json.loads(out.stdout.strip().splitlines()[-1])

    code, v = run("version")
    assert code == 0 and v["backend_version"] == "0.1.0" and v["schema_version"] == migrations.target_version()
    code, b = run("backup-db", str(db), str(tmp_path / "copy.sqlite3"))
    assert code == 0 and b["ok"] and b["counts"]["paper_trades"] == 1
    code, m = run("migrate", str(db))
    assert code == 0 and m["from_version"] == 0 and m["backup_path"]
    code, bad = run("validate-db", str(tmp_path / "missing.sqlite3"))
    assert code == 1 and not bad["ok"]


def test_committed_legacy_fixture_migrates_with_settings_intact(tmp_path):
    import shutil
    db = tmp_path / "legacy.sqlite3"
    shutil.copy(ROOT / "tests" / "fixtures" / "legacy_v0.sqlite3", db)
    assert migrations.current_version(str(db)) == 0
    app = create_app(db_path=str(db))
    assert app.state.migration.from_version == 0 and app.state.migration.backup_path
    client = TestClient(app, headers={"X-API-Key": KEY})
    cfg = client.get("/risk/config").json()
    assert cfg["starting_equity"] == 25000 and cfg["settings"]["max_risk_per_trade_pct"] == 0.5
    assert cfg["settings"]["stale_data_timeout_s"] == 90


def test_service_exits_gracefully_when_its_parent_goes_away(tmp_path):
    """The desktop app holds the service's stdin; if the app dies the pipe
    closes and the service must shut down instead of orphaning the port."""
    import socket
    import time
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "PYTHONPATH": str(ROOT), "EXECUTION_SERVICE_EXIT_ON_STDIN_EOF": "1", "EXECUTION_SERVICE_PORT": str(port),
           "EXECUTION_SERVICE_DB_PATH": str(tmp_path / "p.sqlite3"), "MARKET_EDGE_EXEC_API_KEY": KEY}
    proc = subprocess.Popen([sys.executable, str(ROOT / "run_server.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, cwd=tmp_path)
    try:
        import httpx
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if httpx.get(f"http://127.0.0.1:{port}/health", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        else:
            raise AssertionError("service did not start")
        proc.stdin.close()  # the parent "dies"
        assert proc.wait(timeout=30) == 0
        assert b"parent_gone_shutdown" in proc.stderr.read()
    finally:
        if proc.poll() is None:
            proc.kill()
