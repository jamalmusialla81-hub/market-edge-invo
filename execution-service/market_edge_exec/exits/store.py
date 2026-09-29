"""Persistence for the exit shadow engine. Two additive tables:

  exit_path_observations       append-only log of what a real trade's engine
                               actually observed (monitor prices, 5m candles);
                               UPDATE/DELETE are refused.
  exit_policy_counterfactuals  one row per (trade_id, policy_version), the
                               counterfactual result. Updated while the trade is
                               open; frozen (finalized) once it has closed.

Neither table is ever read back into a trade record, an order or the router.
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing
from typing import Callable, Optional

from market_edge_exec.exits.model import Observation

DDL = """
CREATE TABLE IF NOT EXISTS exit_path_observations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    eval_ms INTEGER NOT NULL,
    price REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    open REAL NOT NULL,
    batch INTEGER NOT NULL,
    last INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exit_obs_trade ON exit_path_observations (trade_id, seq);
CREATE TABLE IF NOT EXISTS exit_policy_counterfactuals (
    trade_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL,
    finalized INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    params TEXT NOT NULL,
    state TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (trade_id, policy_version)
);
CREATE INDEX IF NOT EXISTS idx_exit_cf_policy ON exit_policy_counterfactuals (policy_version, finalized);
CREATE TRIGGER IF NOT EXISTS exit_path_observations_no_update BEFORE UPDATE ON exit_path_observations
    BEGIN SELECT RAISE(ABORT, 'EXIT_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS exit_path_observations_no_delete BEFORE DELETE ON exit_path_observations
    BEGIN SELECT RAISE(ABORT, 'EXIT_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS exit_cf_finalized_no_update BEFORE UPDATE ON exit_policy_counterfactuals
    WHEN OLD.finalized = 1 BEGIN SELECT RAISE(ABORT, 'EXIT_COUNTERFACTUAL_FINALIZED'); END;
CREATE TRIGGER IF NOT EXISTS exit_cf_finalized_no_delete BEFORE DELETE ON exit_policy_counterfactuals
    WHEN OLD.finalized = 1 BEGIN SELECT RAISE(ABORT, 'EXIT_COUNTERFACTUAL_FINALIZED'); END;
"""


class ExitStore:
    def __init__(self, connect: Callable[[], sqlite3.Connection]):
        self._connect = connect

    # ---- observations ----------------------------------------------------
    def append_observations(self, trade_id: str, rows: list[dict]) -> None:
        if not rows:
            return
        with closing(self._connect()) as conn:
            conn.executemany(
                "INSERT INTO exit_path_observations (trade_id, kind, at_ms, eval_ms, price, high, low, open, batch, last) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                [(trade_id, r["kind"], int(r["at_ms"]), int(r["eval_ms"]), float(r["price"]), float(r["high"]), float(r["low"]),
                  float(r["open"]), int(r["batch"]), int(bool(r.get("last", True)))) for r in rows])
            conn.commit()

    def observations(self, trade_id: str, after_seq: int = 0) -> list[Observation]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT * FROM exit_path_observations WHERE trade_id=? AND seq>? ORDER BY seq", (trade_id, after_seq)).fetchall()
        return [Observation(seq=r["seq"], kind=r["kind"], at_ms=r["at_ms"], eval_ms=r["eval_ms"], price=r["price"], high=r["high"],
                            low=r["low"], open=r["open"], batch=r["batch"], last=bool(r["last"])) for r in rows]

    def observation_count(self, trade_id: str) -> int:
        with closing(self._connect()) as conn:
            return conn.execute("SELECT COUNT(*) FROM exit_path_observations WHERE trade_id=?", (trade_id,)).fetchone()[0]

    # ---- counterfactuals -------------------------------------------------
    def load(self, trade_id: str) -> dict:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT * FROM exit_policy_counterfactuals WHERE trade_id=?", (trade_id,)).fetchall()
        return {r["policy_version"]: {"status": r["status"], "finalized": bool(r["finalized"]), "last_seq": r["last_seq"],
                                      "state": json.loads(r["state"]), "record": json.loads(r["record"]), "params": json.loads(r["params"])}
                for r in rows}

    def save(self, trade_id: str, policy_version: str, params: dict, state: dict, record: dict, finalized: bool = False,
             now_ms: Optional[int] = None) -> None:
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT INTO exit_policy_counterfactuals (trade_id, policy_version, status, finalized, updated_at_ms, last_seq, params, state, record) "
                "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(trade_id, policy_version) DO UPDATE SET status=excluded.status, "
                "finalized=excluded.finalized, updated_at_ms=excluded.updated_at_ms, last_seq=excluded.last_seq, params=excluded.params, "
                "state=excluded.state, record=excluded.record",
                (trade_id, policy_version, record["status"], int(finalized), now_ms or int(time.time() * 1000), state["last_seq"],
                 json.dumps(params, sort_keys=True), json.dumps(state, sort_keys=True), json.dumps(record, sort_keys=True, default=str)))
            conn.commit()

    def finalized_records(self) -> list[dict]:
        """Every finalized counterfactual with its trade-level attributes, for the evaluation harness."""
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT trade_id, policy_version, record FROM exit_policy_counterfactuals WHERE finalized=1 "
                                "ORDER BY trade_id, policy_version").fetchall()
        return [{"trade_id": r["trade_id"], "policy_version": r["policy_version"], **json.loads(r["record"])} for r in rows]

    def counts(self) -> dict:
        with closing(self._connect()) as conn:
            return {"observations": conn.execute("SELECT COUNT(*) FROM exit_path_observations").fetchone()[0],
                    "counterfactuals": conn.execute("SELECT COUNT(*) FROM exit_policy_counterfactuals").fetchone()[0]}
