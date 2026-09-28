"""Forward-only schema migrations for the service's single SQLite file.

The schema version lives in `PRAGMA user_version`. Migrations are the
numbered SQL files in the `migrations/` directory (bundled next to the
frozen executable in the desktop app). On startup:

1. `prepare()` reads the current version. A database written by a NEWER
   build is refused (MigrationError) -- it is never downgraded or wiped.
   An existing database that needs migrating is copied first with SQLite's
   online backup API into `backups/pre-migration-v{from}-to-v{to}-{ts}.sqlite3`.
2. The stores create any missing tables (CREATE TABLE IF NOT EXISTS, as before).
3. `apply()` runs each pending migration in ONE transaction together with
   the user_version bump. A failing migration rolls back, the service refuses
   to start, and both the untouched database and the backup stay on disk.

Nothing here ever deletes a database file.
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys
import time
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from market_edge_exec import __version__

_NAME = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    sql: str


@dataclass
class MigrationReport:
    db_path: str
    from_version: int
    to_version: int
    target_version: int
    created: bool
    backup_path: Optional[str] = None
    applied: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return dict(self.__dict__)


def migrations_dir() -> Path:
    env = os.environ.get("EXECUTION_SERVICE_MIGRATIONS_DIR")
    if env:
        return Path(env)
    frozen = getattr(sys, "_MEIPASS", None)  # PyInstaller bundle
    if frozen and (Path(frozen) / "migrations").is_dir():
        return Path(frozen) / "migrations"
    return Path(__file__).resolve().parents[2] / "migrations"


def load_migrations(directory: Optional[Path] = None) -> list[Migration]:
    directory = directory or migrations_dir()
    if not directory.is_dir():
        raise MigrationError(f"MIGRATIONS_DIR_MISSING: {directory}")
    found = []
    for entry in sorted(directory.iterdir()):
        m = _NAME.match(entry.name)
        if m:
            found.append(Migration(int(m.group(1)), m.group(2), entry.read_text(encoding="utf-8")))
    versions = [m.version for m in found]
    if versions != list(range(1, len(found) + 1)):
        raise MigrationError(f"MIGRATIONS_NOT_CONTIGUOUS: {versions}")
    return found


def target_version(directory: Optional[Path] = None) -> int:
    return len(load_migrations(directory))


def current_version(db_path: str) -> int:
    with closing(sqlite3.connect(db_path)) as conn:
        return conn.execute("PRAGMA user_version").fetchone()[0]


def _has_tables(db_path: str) -> bool:
    if not os.path.exists(db_path) or os.path.getsize(db_path) == 0:
        return False
    with closing(sqlite3.connect(db_path)) as conn:
        return conn.execute("SELECT count(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0] > 0


def backup_database(src: str, dst: str) -> str:
    """Consistent copy of a live database (SQLite online backup API)."""
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with closing(sqlite3.connect(src)) as source, closing(sqlite3.connect(dst)) as target:
        source.backup(target)
    return dst


def default_backup_dir(db_path: str) -> str:
    return os.environ.get("EXECUTION_SERVICE_BACKUP_DIR") or os.path.join(os.path.dirname(os.path.abspath(db_path)), "backups")


def prepare(db_path: str, backup_dir: Optional[str] = None, directory: Optional[Path] = None) -> MigrationReport:
    target = target_version(directory)
    existing = _has_tables(db_path)
    version = current_version(db_path) if existing else 0
    if version > target:
        raise MigrationError(
            f"DB_SCHEMA_NEWER: {db_path} is at schema v{version} but this build supports up to v{target}. "
            "It was written by a newer Market Edge; install that version (the database was not modified).")
    report = MigrationReport(db_path=os.path.abspath(db_path), from_version=version, to_version=version,
                             target_version=target, created=not existing)
    if existing and version < target:
        stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
        dst = os.path.join(backup_dir or default_backup_dir(db_path), f"pre-migration-v{version}-to-v{target}-{stamp}.sqlite3")
        report.backup_path = backup_database(db_path, dst)
    return report


def apply(report: MigrationReport, directory: Optional[Path] = None) -> MigrationReport:
    pending = [m for m in load_migrations(directory) if m.version > report.from_version]
    if not pending:
        return report
    conn = sqlite3.connect(report.db_path, isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        for m in pending:
            for statement in _statements(m.sql):
                conn.execute(statement)
            if _table_exists(conn, "schema_history"):
                conn.execute("INSERT OR REPLACE INTO schema_history (version, name, applied_at, app_version) VALUES (?, ?, ?, ?)",
                             (m.version, m.name, time.time(), __version__))
            report.applied.append(f"{m.version:04d}_{m.name}")
        # earlier migrations that ran before schema_history existed
        if _table_exists(conn, "schema_history"):
            for m in load_migrations(directory):
                if m.version <= pending[-1].version:
                    conn.execute("INSERT OR IGNORE INTO schema_history (version, name, applied_at, app_version) VALUES (?, ?, ?, ?)",
                                 (m.version, m.name, time.time(), __version__))
        conn.execute(f"PRAGMA user_version = {int(pending[-1].version)}")
        conn.execute("COMMIT")
    except Exception as error:
        conn.execute("ROLLBACK")
        raise MigrationError(
            f"MIGRATION_FAILED at {report.applied[-1] if report.applied else pending[0].name}: {error}. "
            f"Database left at schema v{report.from_version}; backup: {report.backup_path or 'not needed (new database)'}") from error
    finally:
        conn.close()
    report.to_version = pending[-1].version
    return report


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def _statements(sql: str) -> list[str]:
    """Split a migration file into statements (sqlite3.complete_statement keeps
    semicolons inside strings/triggers intact). Executed one by one so the
    whole file stays inside the caller's transaction -- executescript() would
    COMMIT implicitly."""
    out, buf = [], ""
    for line in sql.splitlines(keepends=True):
        if not buf and line.strip().startswith("--"):
            continue
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


REQUIRED_TABLES = ("paper_account", "paper_trades", "paper_signals", "intents", "positions")


def inspect_database(path: str, directory: Optional[Path] = None) -> dict:
    """Read-only validation used before restoring a backup."""
    if not os.path.isfile(path):
        return {"ok": False, "error": "NOT_FOUND", "path": path}
    try:
        with closing(sqlite3.connect(f"file:{Path(path).resolve().as_posix()}?mode=ro", uri=True)) as conn:
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            counts = {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                      for t in ("paper_trades", "paper_signals", "paper_equity", "positions",
                                "risk_sizing_decisions", "risk_sizing_outcomes") if t in tables}
            policies = sorted(r[0] for r in conn.execute("SELECT DISTINCT policy_version FROM risk_sizing_decisions")) \
                if "risk_sizing_decisions" in tables else []
            equity = conn.execute("SELECT starting_equity FROM paper_account WHERE id = 1").fetchone() if "paper_account" in tables else None
    except sqlite3.DatabaseError as error:
        return {"ok": False, "error": f"NOT_A_VALID_DATABASE: {error}", "path": path}
    target = target_version(directory)
    missing = [t for t in REQUIRED_TABLES if t not in tables]
    problems = []
    if integrity != "ok":
        problems.append(f"INTEGRITY_CHECK_FAILED: {integrity}")
    if missing:
        problems.append(f"MISSING_TABLES: {missing}")
    if version > target:
        problems.append(f"DB_SCHEMA_NEWER: v{version} > supported v{target}")
    return {"ok": not problems, "problems": problems, "path": path, "schema_version": version,
            "supported_schema_version": target, "integrity": integrity, "counts": counts, "risk_policy_versions": policies,
            "starting_equity": equity[0] if equity else None}
