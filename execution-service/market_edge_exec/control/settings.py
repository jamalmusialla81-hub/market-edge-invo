"""Operator controls for the desktop app: persisted risk settings and the
pause-new-entries flag.

Lives in the same SQLite file as the Store and PaperLedger. Nothing here
changes the risk invariant (size = risk budget / stop distance; leverage
never raises the allowed loss) -- it only lets an operator tighten or loosen
the numeric limits RiskLimits already had, inside hard bounds validated
here. Defaults are exactly RiskLimits()'s defaults, so a session that never
touches a setting behaves as before.

Pausing new entries is not the kill switch: it is a soft, operator-owned
gate that blocks new trades while exits keep being processed, and it does
not engage a halt that needs reconciliation to clear.
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing
from dataclasses import asdict, fields, replace
from typing import Optional

from market_edge_exec.risk.engine import LEVERAGE_BANDS, RiskLimits

SCHEMA = """
CREATE TABLE IF NOT EXISTS control_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS control_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS control_reconcile_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciled INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""

DEFAULT_STALE_DATA_TIMEOUT_S = 120  # engine.MAX_MARK_AGE_SECONDS

# (min, max) per editable setting. Bounds are deliberately conservative:
# the ceiling on leverage is the largest band the risk engine knows about,
# and risk per trade cannot exceed 2% of equity from the UI.
BOUNDS = {
    "max_risk_per_trade_pct": (0.05, 2.0),
    "max_portfolio_exposure_pct": (1.0, 100.0),
    "max_concurrent_positions": (1, 20),
    "leverage_ceiling": (1.0, float(max(LEVERAGE_BANDS))),
    "daily_loss_limit_pct": (0.5, 20.0),
    "drawdown_limit_pct": (1.0, 50.0),
    "min_liquidation_buffer_pct": (0.5, 20.0),
    "stale_data_timeout_s": (10, 600),
}
INTEGER_SETTINGS = {"max_concurrent_positions", "stale_data_timeout_s"}
RISK_LIMIT_KEYS = {f.name for f in fields(RiskLimits)}


class SettingsError(ValueError):
    pass


def validate(update: dict) -> dict:
    """Returns the cleaned update or raises SettingsError naming every bad key."""
    if not isinstance(update, dict) or not update:
        raise SettingsError("EMPTY_UPDATE")
    errors, clean = [], {}
    for key, raw in update.items():
        if key not in BOUNDS:
            errors.append(f"{key}: not an editable setting")
            continue
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            errors.append(f"{key}: must be a number")
            continue
        value = int(raw) if key in INTEGER_SETTINGS else float(raw)
        if key in INTEGER_SETTINGS and float(raw) != int(raw):
            errors.append(f"{key}: must be a whole number")
            continue
        low, high = BOUNDS[key]
        if not (low <= value <= high):
            errors.append(f"{key}: {value} outside [{low}, {high}]")
            continue
        clean[key] = value
    if errors:
        raise SettingsError("; ".join(errors))
    return clean


class ControlStore:
    def __init__(self, path: str):
        self.path = path
        with closing(self._connect()) as conn:
            conn.executescript(SCHEMA)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _get(self, key: str) -> Optional[str]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT value FROM control_settings WHERE key = ?", (key,)).fetchone()
            return row["value"] if row else None

    def _set(self, conn: sqlite3.Connection, key: str, value) -> None:
        conn.execute(
            "INSERT INTO control_settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(value), time.time()),
        )

    def audit(self, action: str, payload: Optional[dict] = None) -> None:
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO control_audit (action, payload, created_at) VALUES (?, ?, ?)",
                         (action, json.dumps(payload or {}), time.time()))
            conn.commit()

    def audit_log(self, limit: int = 200) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT action, payload, created_at FROM control_audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"action": r["action"], "payload": json.loads(r["payload"]), "created_at": r["created_at"]} for r in rows]

    # ---- risk settings -------------------------------------------------
    def settings(self) -> dict:
        stored = json.loads(self._get("risk") or "{}")
        base = {k: v for k, v in asdict(RiskLimits()).items() if k in BOUNDS}
        base["stale_data_timeout_s"] = DEFAULT_STALE_DATA_TIMEOUT_S
        base.update({k: v for k, v in stored.items() if k in BOUNDS})
        return base

    def update_settings(self, update: dict) -> dict:
        clean = validate(update)
        merged = {**self.settings(), **clean}
        with closing(self._connect()) as conn:
            self._set(conn, "risk", merged)
            conn.execute("INSERT INTO control_audit (action, payload, created_at) VALUES (?, ?, ?)",
                         ("RISK_SETTINGS_UPDATED", json.dumps(clean), time.time()))
            conn.commit()
        return merged

    def risk_limits(self) -> RiskLimits:
        current = self.settings()
        return replace(RiskLimits(), **{k: v for k, v in current.items() if k in RISK_LIMIT_KEYS})

    def stale_data_timeout_s(self) -> int:
        return int(self.settings()["stale_data_timeout_s"])

    # ---- pause ---------------------------------------------------------
    def entries_paused(self) -> bool:
        return bool(json.loads(self._get("entries_paused") or "false"))

    def set_entries_paused(self, paused: bool, reason: Optional[str] = None) -> None:
        with closing(self._connect()) as conn:
            self._set(conn, "entries_paused", bool(paused))
            conn.execute("INSERT INTO control_audit (action, payload, created_at) VALUES (?, ?, ?)",
                         ("PAUSE_NEW_ENTRIES" if paused else "RESUME_NEW_ENTRIES", json.dumps({"reason": reason}), time.time()))
            conn.commit()

    # ---- reconciliation log -------------------------------------------
    def record_reconcile(self, result: dict) -> None:
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO control_reconcile_log (reconciled, payload, created_at) VALUES (?, ?, ?)",
                         (1 if result.get("reconciled") else 0, json.dumps(result), time.time()))
            conn.commit()

    def last_reconcile(self) -> Optional[dict]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT payload, created_at FROM control_reconcile_log ORDER BY id DESC LIMIT 1").fetchone()
        return {**json.loads(row["payload"]), "at": row["created_at"]} if row else None
