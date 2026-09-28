"""Durable local persistence (SQLite) for paper execution state.

Idempotency is enforced here, not in memory: signal_id is the primary key of
the `intents` table, so a re-submitted intent — even after the process has
restarted and rebuilt every in-memory object from scratch — is caught by a
UNIQUE constraint violation before anything is ever sent to a backend.
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing
from dataclasses import asdict
from typing import Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS intents (
    signal_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    signal_id TEXT PRIMARY KEY,
    backend TEXT NOT NULL,
    status TEXT NOT NULL,
    external_id TEXT,
    updated_at REAL NOT NULL,
    FOREIGN KEY (signal_id) REFERENCES intents(signal_id)
);
CREATE TABLE IF NOT EXISTS fills (
    fill_id TEXT PRIMARY KEY,
    signal_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    instrument TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS balances (
    account TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT,
    reason TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS halts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reason TEXT NOT NULL,
    created_at REAL NOT NULL,
    cleared_at REAL
);
"""


class DuplicateSignalError(Exception):
    def __init__(self, signal_id: str):
        super().__init__(f"IDEMPOTENCY_VIOLATION: signal_id {signal_id} already has a persisted intent")
        self.signal_id = signal_id


class Store:
    """One Store per SQLite file. Re-opening the same path after a process
    restart sees exactly the state the previous process committed — this is
    what makes idempotency and position recovery survive a restart."""

    def __init__(self, path: str):
        self.path = path
        with closing(self._connect()) as conn:
            conn.executescript(SCHEMA)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def record_intent(self, intent_dict: dict) -> None:
        with closing(self._connect()) as conn:
            try:
                conn.execute(
                    "INSERT INTO intents (signal_id, payload, created_at) VALUES (?, ?, ?)",
                    (intent_dict["signal_id"], json.dumps(intent_dict), time.time()),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                raise DuplicateSignalError(intent_dict["signal_id"])

    def has_intent(self, signal_id: str) -> bool:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT 1 FROM intents WHERE signal_id = ?", (signal_id,)).fetchone()
            return row is not None

    def upsert_order(self, signal_id: str, backend: str, status: str, external_id: Optional[str] = None) -> None:
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT INTO orders (signal_id, backend, status, external_id, updated_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(signal_id) DO UPDATE SET status=excluded.status, external_id=excluded.external_id, updated_at=excluded.updated_at",
                (signal_id, backend, status, external_id, time.time()),
            )
            conn.commit()

    def record_fill(self, fill_dict: dict) -> None:
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO fills (fill_id, signal_id, payload, created_at) VALUES (?, ?, ?, ?)",
                (fill_dict["fill_id"], fill_dict["signal_id"], json.dumps(fill_dict), time.time()),
            )
            conn.commit()

    def upsert_position(self, position_dict: dict) -> None:
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT INTO positions (instrument, payload, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(instrument) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
                (position_dict["instrument"], json.dumps(position_dict), time.time()),
            )
            conn.commit()

    def positions(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT payload FROM positions").fetchall()
            return [json.loads(row["payload"]) for row in rows]

    def orders(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT signal_id, backend, status, external_id FROM orders").fetchall()
            return [dict(row) for row in rows]

    def record_reconciliation_event(self, payload: dict) -> None:
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO reconciliation_events (payload, created_at) VALUES (?, ?)", (json.dumps(payload), time.time()))
            conn.commit()

    def record_failure(self, signal_id: Optional[str], reason: str) -> None:
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO failures (signal_id, reason, created_at) VALUES (?, ?, ?)", (signal_id, reason, time.time()))
            conn.commit()

    def failures(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT signal_id, reason, created_at FROM failures ORDER BY id").fetchall()
            return [dict(row) for row in rows]

    def set_halt(self, reason: str) -> None:
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO halts (reason, created_at) VALUES (?, ?)", (reason, time.time()))
            conn.commit()

    def active_halt(self) -> Optional[str]:
        """A halt survives restarts until explicitly cleared by a human --
        restarting the process must never be a way to un-kill trading."""
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT reason FROM halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1").fetchone()
            return row["reason"] if row else None

    def clear_halts(self) -> None:
        with closing(self._connect()) as conn:
            conn.execute("UPDATE halts SET cleared_at = ? WHERE cleared_at IS NULL", (time.time(),))
            conn.commit()
