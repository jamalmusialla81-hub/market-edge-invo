"""Persistent forward-paper account: per-trade ledger, equity history,
signal history. Lives in the same SQLite file as the execution Store, so a
restored endurance-segment DB carries the account, open trades, trade
history, signal history and idempotency history together -- nothing resets
between segments.

The account-level numbers the risk engine sees (equity, open positions,
open notional, daily PnL, peak equity) are derived from this ledger on every
call via account_state(), never held in a long-lived object. A stale
in-memory AccountState is exactly what let endurance segment 1 stack ENA
twelve times past the exposure cap.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from contextlib import closing
from typing import Optional

from market_edge_exec.exits.store import DDL as EXIT_DDL
from market_edge_exec.risk.engine import AccountState

DEFAULT_STARTING_EQUITY = 10_000.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS paper_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    starting_equity REAL NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_trades (
    trade_id TEXT PRIMARY KEY,
    instrument TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (trade_id, kind)
);
CREATE TABLE IF NOT EXISTS paper_equity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL,
    equity REAL NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT,
    at_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    payload TEXT NOT NULL
);
-- Post-outcome research labels (e.g. Universal Shadow Learning's optimal
-- executable entry/TP/exit). Kept in their own table so hindsight can never
-- be written into, or read back as, a trade's decision-time record.
CREATE TABLE IF NOT EXISTS paper_hindsight (
    trade_id TEXT PRIMARY KEY,
    resolved_at_ms INTEGER NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL
);
-- Risk Sizing V2: the ORIGINAL sizing decision(s) of every candidate that
-- reached sizing (authoritative and counterfactual), and after-trade
-- measurements. Both immutable (triggers below; also migration 0003).
CREATE TABLE IF NOT EXISTS risk_sizing_decisions (
    decision_id TEXT PRIMARY KEY,
    signal_id TEXT,
    asset TEXT,
    mode TEXT NOT NULL,
    role TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    approved INTEGER NOT NULL,
    reason TEXT,
    created_at_ms INTEGER NOT NULL,
    record TEXT NOT NULL,
    record_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_sizing_signal ON risk_sizing_decisions (signal_id);
CREATE TABLE IF NOT EXISTS risk_sizing_outcomes (
    signal_id TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    record TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS risk_sizing_decisions_no_update BEFORE UPDATE ON risk_sizing_decisions
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS risk_sizing_decisions_no_delete BEFORE DELETE ON risk_sizing_decisions
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS risk_sizing_outcomes_no_update BEFORE UPDATE ON risk_sizing_outcomes
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS risk_sizing_outcomes_no_delete BEFORE DELETE ON risk_sizing_outcomes
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
CREATE TABLE IF NOT EXISTS paper_runtime (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER
);
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


class PaperLedger:
    def __init__(self, path: str, starting_equity: float = DEFAULT_STARTING_EQUITY):
        self.path = path
        with closing(self._connect()) as conn:
            conn.executescript(SCHEMA)
            conn.executescript(EXIT_DDL)
            conn.execute("INSERT OR IGNORE INTO paper_account (id, starting_equity, created_at) VALUES (1, ?, ?)",
                         (starting_equity, time.time()))
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    # ---- account -------------------------------------------------------
    def starting_equity(self) -> float:
        with closing(self._connect()) as conn:
            return conn.execute("SELECT starting_equity FROM paper_account WHERE id = 1").fetchone()[0]

    def trades(self, status: Optional[str] = None) -> list[dict]:
        with closing(self._connect()) as conn:
            if status == "OPEN":
                rows = conn.execute("SELECT payload FROM paper_trades WHERE status != 'CLOSED' ORDER BY opened_at_ms").fetchall()
            elif status:
                rows = conn.execute("SELECT payload FROM paper_trades WHERE status = ? ORDER BY opened_at_ms", (status,)).fetchall()
            else:
                rows = conn.execute("SELECT payload FROM paper_trades ORDER BY opened_at_ms").fetchall()
            return [json.loads(r["payload"]) for r in rows]

    def trade(self, trade_id: str) -> Optional[dict]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT payload FROM paper_trades WHERE trade_id = ?", (trade_id,)).fetchone()
            return json.loads(row["payload"]) if row else None

    def open_trade_for(self, instrument: str) -> Optional[dict]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT payload FROM paper_trades WHERE instrument = ? AND status != 'CLOSED'", (instrument,)).fetchone()
            return json.loads(row["payload"]) if row else None

    def totals(self) -> dict:
        trades = self.trades()
        realized = sum(t["realized_pnl"] for t in trades)
        fees = sum(t["fees"] for t in trades)
        slippage = sum(t["slippage_cost"] for t in trades)
        open_trades = [t for t in trades if t["status"] != "CLOSED"]
        unrealized = sum(t.get("unrealized_pnl", 0.0) for t in open_trades)
        open_notional = sum(t["remaining_qty"] * (t.get("mark_price") or t["entry_fill"]) for t in open_trades)
        start = self.starting_equity()
        return {
            "starting_equity": start, "realized_pnl": realized, "unrealized_pnl": unrealized, "fees": fees,
            "slippage_cost": slippage, "equity": start + realized - fees + unrealized,
            "balance": start + realized - fees, "open_positions": len(open_trades), "open_notional": open_notional,
        }

    def peak_equity(self) -> float:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT MAX(equity) FROM paper_equity").fetchone()
        return max(row[0] or 0.0, self.starting_equity())

    def daily_pnl(self, now_ms: Optional[int] = None) -> float:
        now_ms = now_ms or _now_ms()
        day_start = now_ms - (now_ms % 86_400_000)
        total = 0.0
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT payload FROM paper_trade_events WHERE at_ms >= ?", (day_start,)).fetchall()
        for r in rows:
            event = json.loads(r["payload"])
            total += event.get("pnl", 0.0) - event.get("fee", 0.0)
        return total

    def account_state(self, killed: bool = False, now_ms: Optional[int] = None) -> AccountState:
        t = self.totals()
        return AccountState(equity=t["equity"], open_positions=t["open_positions"], daily_pnl=self.daily_pnl(now_ms),
                            peak_equity=self.peak_equity(), killed=killed, open_notional=t["open_notional"])

    # ---- writes --------------------------------------------------------
    def _save_trade(self, conn: sqlite3.Connection, trade: dict) -> None:
        conn.execute(
            "INSERT INTO paper_trades (trade_id, instrument, status, opened_at_ms, closed_at_ms, payload) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(trade_id) DO UPDATE SET status=excluded.status, closed_at_ms=excluded.closed_at_ms, payload=excluded.payload",
            (trade["trade_id"], trade["instrument"], trade["status"], trade["opened_at_ms"], trade.get("closed_at_ms"), json.dumps(trade)),
        )

    def open_trade(self, trade: dict) -> None:
        with closing(self._connect()) as conn:
            self._save_trade(conn, trade)
            conn.execute("INSERT INTO paper_trade_events (trade_id, kind, at_ms, payload) VALUES (?, 'ENTRY', ?, ?)",
                         (trade["trade_id"], trade["opened_at_ms"], json.dumps({"fee": trade["fees"], "pnl": 0.0,
                                                                                 "fill_price": trade["entry_fill"], "quantity": trade["quantity"]})))
            conn.commit()

    def apply_exit(self, trade: dict, kind: str, quantity: float, fill_price: float, level: float,
                   pnl: float, fee: float, slippage_cost: float, at_ms: int, extra: Optional[dict] = None) -> bool:
        """Returns False (and changes nothing) if this exit kind was already
        recorded for this trade -- a duplicate callback cannot double-close.
        `extra` (e.g. which trigger path observed the price) is recorded on
        the exit, never used to change it."""
        record = {"quantity": quantity, "fill_price": fill_price, "level": level, "pnl": pnl, "fee": fee, **(extra or {})}
        with closing(self._connect()) as conn:
            try:
                conn.execute("INSERT INTO paper_trade_events (trade_id, kind, at_ms, payload) VALUES (?, ?, ?, ?)",
                             (trade["trade_id"], kind, at_ms, json.dumps(record)))
            except sqlite3.IntegrityError:
                return False
            trade["remaining_qty"] = max(0.0, trade["remaining_qty"] - quantity)
            trade["realized_pnl"] += pnl
            trade["fees"] += fee
            trade["slippage_cost"] += slippage_cost
            trade["exits"].append({"kind": kind, "quantity": quantity, "fill_price": fill_price, "level": level, "pnl": pnl,
                                   "at_ms": at_ms, **(extra or {})})
            # Milestone state is persisted with the trade so a restart
            # resumes exactly where it left off (the UNIQUE (trade_id, kind)
            # event row above is what makes each milestone fire only once).
            if kind == "TP1":
                trade["tp1_hit"] = True
                trade["status"] = "PARTIAL"
                trade["tp1_fill_at_ms"], trade["tp1_fill_price"] = at_ms, fill_price
                trade["stop_status"] = "BREAKEVEN"
            elif kind == "TP2":
                trade["tp2_status"] = "HIT"
                trade["tp2_fill_at_ms"], trade["tp2_fill_price"] = at_ms, fill_price
            elif kind in ("STOP", "BREAKEVEN_STOP"):
                trade["stop_status"] = "HIT"
            if trade["remaining_qty"] <= 1e-12:
                trade["remaining_qty"] = 0.0
                trade["status"] = "CLOSED"
                trade["closed_at_ms"] = at_ms
                trade["exit_reason"] = kind
                trade["unrealized_pnl"] = 0.0
                if trade.get("stop_status") in ("ACTIVE", "BREAKEVEN", None):
                    trade["stop_status"] = "CANCELLED"
                if trade.get("tp2_status") in ("PENDING", None) and trade.get("tp2") is not None:
                    trade["tp2_status"] = "CANCELLED"
            self._save_trade(conn, trade)
            if trade["status"] == "CLOSED":
                self._record_outcome(conn, trade)
            conn.commit()
            return True

    # ---- risk sizing records (immutable) ---------------------------------
    def record_sizing(self, signal_id: Optional[str], asset: Optional[str], mode: str, role: str, record: dict,
                      at_ms: Optional[int] = None) -> str:
        at_ms = at_ms or _now_ms()
        body = json.dumps(record, sort_keys=True, default=str)
        digest = hashlib.sha256(body.encode()).hexdigest()
        decision_id = f"siz-{digest[:20]}-{role[:4].lower()}"
        with closing(self._connect()) as conn:
            conn.execute("INSERT OR IGNORE INTO risk_sizing_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (decision_id, signal_id, asset, mode, role, record.get("sizing_rule_version") or "UNKNOWN",
                          int(bool(record.get("approved"))), record.get("rejection_reason"), at_ms, body, digest))
            conn.commit()
        return decision_id

    def sizing_records(self, signal_id: str) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT * FROM risk_sizing_decisions WHERE signal_id=? ORDER BY created_at_ms, role", (signal_id,)).fetchall()
        out = []
        for r in rows:
            record = json.loads(r["record"])
            out.append({"decision_id": r["decision_id"], "mode": r["mode"], "role": r["role"], "policy_version": r["policy_version"],
                        "approved": bool(r["approved"]), "reason": r["reason"], "created_at_ms": r["created_at_ms"],
                        "record_hash_ok": hashlib.sha256(r["record"].encode()).hexdigest() == r["record_hash"], "record": record})
        return out

    def authoritative_sizing(self, signal_id: str) -> Optional[dict]:
        for r in self.sizing_records(signal_id):
            if r["role"] == "AUTHORITATIVE":
                return r["record"]
        return None

    def sizing_outcome(self, signal_id: str) -> Optional[dict]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT record FROM risk_sizing_outcomes WHERE signal_id=?", (signal_id,)).fetchone()
        return json.loads(row["record"]) if row else None

    def sizing_counts(self) -> dict:
        with closing(self._connect()) as conn:
            return {"decisions": conn.execute("SELECT COUNT(*) FROM risk_sizing_decisions").fetchone()[0],
                    "outcomes": conn.execute("SELECT COUNT(*) FROM risk_sizing_outcomes").fetchone()[0]}

    def _record_outcome(self, conn: sqlite3.Connection, trade: dict) -> None:
        """After-trade measurement, written once when the trade closes.
        Outcome fields only -- never read back into a sizing decision."""
        qty = float(trade.get("quantity") or 0.0)
        entry = float(trade["entry_fill"])
        long = trade["direction"] == "long"
        row = conn.execute("SELECT record FROM risk_sizing_decisions WHERE signal_id=? AND role='AUTHORITATIVE' "
                           "ORDER BY created_at_ms LIMIT 1", (trade["trade_id"],)).fetchone()
        original = json.loads(row["record"]) if row else {}
        planned = original.get("planned_loss_dollars") or trade.get("planned_loss_dollars") or trade.get("max_loss")
        net = float(trade.get("realized_pnl") or 0.0) - float(trade.get("fees") or 0.0)
        exits = trade.get("exits") or []
        best, worst = trade.get("best_price") or entry, trade.get("worst_price") or entry
        mfe = (best - entry) if long else (entry - best)
        mae = (entry - worst) if long else (worst - entry)
        record = {
            "signal_id": trade["trade_id"], "closed_at_ms": trade.get("closed_at_ms"), "exit_reason": trade.get("exit_reason"),
            "realised_fees": trade.get("fees"),
            "realised_entry_slippage": abs(entry - float(trade.get("mark_at_entry") or entry)) * qty,
            "realised_exit_slippage": sum(abs(e["fill_price"] - e["level"]) * e["quantity"] for e in exits),
            "realised_stop_slippage": sum(abs(e["fill_price"] - e["level"]) * e["quantity"] for e in exits
                                          if e["kind"] in ("STOP", "BREAKEVEN_STOP")),
            "realised_max_loss": max(0.0, mae) * qty,
            "realised_net_pnl": net,
            "realised_R": net / planned if planned else None,
            "planned_loss_dollars_original": planned,
            "loss_vs_planned": (-net / planned) if planned and net < 0 else 0.0,
            "mfe_price": mfe, "mae_price": mae,
            "mfe_R": mfe * qty / planned if planned else None, "mae_R": mae * qty / planned if planned else None,
            "sizing_policy_version": original.get("sizing_rule_version") or trade.get("risk_policy_version"),
        }
        conn.execute("INSERT OR IGNORE INTO risk_sizing_outcomes VALUES (?,?,?)",
                     (trade["trade_id"], trade.get("closed_at_ms") or _now_ms(), json.dumps(record, default=str)))

    def update_mark(self, trade: dict, mark_price: float, checked_to_ms: int, unrealized: float) -> None:
        trade["mark_price"] = mark_price
        trade["last_checked_ms"] = checked_to_ms
        trade["unrealized_pnl"] = unrealized
        with closing(self._connect()) as conn:
            self._save_trade(conn, trade)
            conn.commit()

    def save(self, trade: dict) -> None:
        """Persist a trade's non-exit state (live price, excursions, monitor status)."""
        with closing(self._connect()) as conn:
            self._save_trade(conn, trade)
            conn.commit()

    def signal_payload(self, signal_id: str) -> Optional[dict]:
        """The payload the forward loop sent when this signal was EXECUTED:
        the original signal geometry plus display-only scan context (meta)."""
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT payload FROM paper_signals WHERE signal_id = ? AND outcome = 'EXECUTED' ORDER BY id LIMIT 1",
                               (signal_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def record_hindsight(self, trade_id: str, resolved_at_ms: int, source: str, labels: dict) -> None:
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO paper_hindsight (trade_id, resolved_at_ms, source, payload) VALUES (?, ?, ?, ?) "
                         "ON CONFLICT(trade_id) DO UPDATE SET resolved_at_ms=excluded.resolved_at_ms, source=excluded.source, payload=excluded.payload",
                         (trade_id, resolved_at_ms, source, json.dumps(labels)))
            conn.commit()

    def hindsight(self, trade_id: str) -> Optional[dict]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT resolved_at_ms, source, payload FROM paper_hindsight WHERE trade_id = ?", (trade_id,)).fetchone()
        return {"resolved_at_ms": row["resolved_at_ms"], "source": row["source"], "labels": json.loads(row["payload"])} if row else None

    def record_equity(self, at_ms: Optional[int] = None) -> dict:
        t = self.totals()
        at_ms = at_ms or _now_ms()
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO paper_equity (at_ms, equity, payload) VALUES (?, ?, ?)", (at_ms, t["equity"], json.dumps(t)))
            conn.commit()
        return t

    def equity_history(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT at_ms, equity, payload FROM paper_equity ORDER BY at_ms, id").fetchall()
        return [{"at_ms": r["at_ms"], "equity": r["equity"], **json.loads(r["payload"])} for r in rows]

    def record_signal(self, signal_id: Optional[str], outcome: str, reason: Optional[str] = None,
                      payload: Optional[dict] = None, at_ms: Optional[int] = None) -> None:
        with closing(self._connect()) as conn:
            conn.execute("INSERT INTO paper_signals (signal_id, at_ms, outcome, reason, payload) VALUES (?, ?, ?, ?, ?)",
                         (signal_id, at_ms or _now_ms(), outcome, reason, json.dumps(payload or {})))
            conn.commit()

    def signal_history(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT signal_id, at_ms, outcome, reason FROM paper_signals ORDER BY at_ms, id").fetchall()
        return [dict(r) for r in rows]

    def start_segment(self, segment: str, at_ms: Optional[int] = None) -> int:
        with closing(self._connect()) as conn:
            cursor = conn.execute("INSERT INTO paper_runtime (segment, started_at_ms) VALUES (?, ?)", (segment, at_ms or _now_ms()))
            conn.commit()
            return cursor.lastrowid

    def end_segment(self, segment_row: int, at_ms: Optional[int] = None) -> None:
        with closing(self._connect()) as conn:
            conn.execute("UPDATE paper_runtime SET ended_at_ms = ? WHERE id = ?", (at_ms or _now_ms(), segment_row))
            conn.commit()

    def runtime_segments(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute("SELECT segment, started_at_ms, ended_at_ms FROM paper_runtime ORDER BY id").fetchall()
        return [dict(r) for r in rows]
