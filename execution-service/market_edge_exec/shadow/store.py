"""Shadow research store: its own SQLite file, never the paper ledger's.

Tables (each its own research store, each row stamped with its dataset):
  shadow_scans            one row per scan, incl. NO_TRADE scans     (RAW)
  shadow_observations     DECISION_TIME_DATA, one per candidate and per
                          market state; immutable                   (RAW)
  shadow_labels           FUTURE_LABEL_DATA per horizon batch; written
                          once when the batch window closed; immutable (RESOLVED)
  shadow_hindsight        post-outcome research labels + diagnostic
                          classification; immutable                 (RESOLVED)
  forward_paper_executed  a copy of what paper execution actually
                          accepted, for joining; the paper ledger stays
                          authoritative                              (PAPER_EXECUTED)
  shadow_resolution       mutable bookkeeping only (which batches are done)

UPDATE and DELETE on every research table are refused by triggers, so a
decision snapshot or a label cannot be rewritten after the fact.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import zlib
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow import resolve as R

DATA_EXPIRY_MS = 7 * 24 * C.HOUR   # a batch no candle set covered by then is closed as unavailable
IMMUTABLE = ("shadow_scans", "shadow_observations", "shadow_labels", "shadow_hindsight", "forward_paper_executed",
             "forward_execution_quality")

SCHEMA = """
CREATE TABLE IF NOT EXISTS shadow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shadow_scans (
    scan_id TEXT PRIMARY KEY, decision_ts INTEGER NOT NULL, scan_status TEXT, scan_state TEXT NOT NULL,
    execution_decision TEXT NOT NULL, execution_reason TEXT, submitted_signal_id TEXT,
    n_markets INTEGER NOT NULL, n_candidates INTEGER NOT NULL, observation_interval_ms INTEGER,
    generator_version TEXT NOT NULL, feature_version TEXT NOT NULL, model_version TEXT,
    dataset_version TEXT NOT NULL, detail BLOB NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow_observations (
    observation_id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, kind TEXT NOT NULL, asset TEXT NOT NULL, coin TEXT NOT NULL,
    direction TEXT, strategy TEXT, decision_ts INTEGER NOT NULL, first_bar_ts INTEGER NOT NULL,
    production_rank INTEGER, scan_candidate_rank INTEGER, is_production_pick INTEGER NOT NULL, production_state TEXT,
    execution_status TEXT NOT NULL, execution_rejection_reason TEXT,
    research_candidate_valid INTEGER NOT NULL, invalid_reason TEXT,
    observation_cluster_id TEXT NOT NULL, market_episode_id TEXT NOT NULL, overlap_fraction REAL NOT NULL,
    generator_version TEXT NOT NULL, feature_version TEXT NOT NULL, model_version TEXT,
    dataset_version TEXT NOT NULL, outcome_venue TEXT NOT NULL, outcome_interval TEXT NOT NULL,
    decision BLOB NOT NULL, decision_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_obs_coin_ts ON shadow_observations (coin, decision_ts);
CREATE INDEX IF NOT EXISTS shadow_obs_ts ON shadow_observations (decision_ts);
CREATE INDEX IF NOT EXISTS shadow_obs_key ON shadow_observations (asset, kind, direction, strategy, decision_ts);
CREATE TABLE IF NOT EXISTS shadow_labels (
    observation_id TEXT NOT NULL, batch TEXT NOT NULL, window_end_ts INTEGER NOT NULL, label_status TEXT NOT NULL,
    label_version TEXT NOT NULL, dataset_version TEXT NOT NULL, labels BLOB NOT NULL, label_hash TEXT NOT NULL,
    resolved_at_ms INTEGER NOT NULL, PRIMARY KEY (observation_id, batch)
);
CREATE TABLE IF NOT EXISTS shadow_hindsight (
    observation_id TEXT PRIMARY KEY, classification TEXT NOT NULL, label_version TEXT NOT NULL,
    dataset_version TEXT NOT NULL, labels BLOB NOT NULL, resolved_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS forward_paper_executed (
    signal_id TEXT PRIMARY KEY, observation_id TEXT, scan_id TEXT NOT NULL, decision_ts INTEGER NOT NULL,
    dataset_version TEXT NOT NULL, trade BLOB NOT NULL, created_at_ms INTEGER NOT NULL
);
-- DATA 1: what execution actually cost, copied from the paper ledger when a
-- paper trade closed (the ledger stays authoritative). OUTCOME / EVENT data:
-- only knowable after the fill, so it is never a decision-time feature.
CREATE TABLE IF NOT EXISTS forward_execution_quality (
    signal_id TEXT PRIMARY KEY, observation_id TEXT, scan_id TEXT, dataset_version TEXT NOT NULL, field_class TEXT NOT NULL,
    source TEXT NOT NULL, source_commit TEXT, record BLOB NOT NULL, record_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow_resolution (
    observation_id TEXT PRIMARY KEY, coin TEXT NOT NULL, first_bar_ts INTEGER NOT NULL, batches_done TEXT NOT NULL,
    resolution_status TEXT NOT NULL, next_due_ts INTEGER, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_res_due ON shadow_resolution (resolution_status, next_due_ts);
"""


def _blob(value: Any) -> bytes:
    return zlib.compress(C.canonical(value).encode(), 6)


def _unblob(value: bytes) -> Any:
    return json.loads(zlib.decompress(value).decode())


def default_path(paper_db_path: str) -> str:
    """Next to the paper database, in its own file."""
    override = os.environ.get("MARKET_EDGE_SHADOW_DB")
    if override:
        return override
    base = os.path.dirname(os.path.abspath(paper_db_path))
    return os.path.join(base, "market_edge_shadow_research.sqlite3")


SHADOW_TABLES = ("shadow_meta", "shadow_scans", "shadow_observations", "shadow_labels", "shadow_hindsight",
                 "forward_paper_executed", "forward_execution_quality", "shadow_resolution")


def inspect_database(path: str) -> dict:
    """Read-only validation of a shadow research database (backup/restore).
    Never creates tables, never writes."""
    if not os.path.isfile(path):
        return {"ok": False, "error": "NOT_FOUND", "path": path}
    try:
        uri = "file:" + os.path.abspath(path).replace(os.sep, "/") + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as conn:
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            meta = dict(conn.execute("SELECT key, value FROM shadow_meta").fetchall()) if "shadow_meta" in tables else {}
            counts = {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in SHADOW_TABLES if t in tables and t != "shadow_meta"}
            datasets = sorted({r[0] for t in ("shadow_scans", "shadow_observations", "shadow_labels", "forward_paper_executed")
                               if t in tables for r in conn.execute(f"SELECT DISTINCT dataset_version FROM {t}")})
            triggers = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
    except sqlite3.DatabaseError as error:
        return {"ok": False, "error": f"NOT_A_VALID_DATABASE: {error}", "path": path}
    problems = []
    if integrity != "ok":
        problems.append(f"INTEGRITY_CHECK_FAILED: {integrity}")
    optional_v2 = {"forward_execution_quality"} if version_of(meta) < 2 else set()
    missing = [t for t in SHADOW_TABLES if t not in tables and t not in optional_v2]
    if missing:
        problems.append(f"MISSING_TABLES: {missing}")
    version = int(meta.get("schema_version") or 0)
    if version > C.SHADOW_SCHEMA_VERSION:
        problems.append(f"SHADOW_SCHEMA_NEWER: v{version} > supported v{C.SHADOW_SCHEMA_VERSION}")
    missing_guards = [f"{t}_no_{op}" for t in IMMUTABLE if t not in optional_v2 for op in ("update", "delete") if f"{t}_no_{op}" not in triggers]
    if missing_guards and not missing:
        problems.append(f"MISSING_IMMUTABILITY_TRIGGERS: {missing_guards}")
    return {"ok": not problems, "problems": problems, "path": path, "kind": "shadow_research",
            "shadow_schema_version": version, "supported_shadow_schema_version": C.SHADOW_SCHEMA_VERSION,
            "integrity": integrity, "counts": counts, "dataset_versions": datasets}


def version_of(meta: dict) -> int:
    try:
        return int(meta.get("schema_version") or 0)
    except (TypeError, ValueError):
        return 0


def backup_database(src: str, dst: str) -> str:
    """Consistent copy of the live shadow database (SQLite online backup
    API: safe while the execution-service is writing)."""
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with closing(sqlite3.connect(src, timeout=30)) as source, closing(sqlite3.connect(dst)) as target:
        source.backup(target)
    return dst


def _batch_due(first_bar_ts: int, decision_ts: int, batch: str) -> int:
    return decision_ts + max(C.HORIZONS[h] for h in C.LABEL_BATCHES[batch])


def _next_due(decision_ts: int, first_bar_ts: int, done: list[str]) -> Optional[int]:
    pending = [b for b in C.LABEL_BATCHES if b not in done]
    return min((_batch_due(first_bar_ts, decision_ts, b) for b in pending), default=None)


class ShadowStore:
    def __init__(self, path: str, source_commit: Optional[str] = None):
        self.path = path
        # The git SHA of the running build (not a content hash). "dev" in a
        # source checkout; None only when a caller did not say.
        self.source_commit = source_commit
        with closing(self._connect()) as conn:
            conn.executescript(SCHEMA)
            self._migrate(conn)
            for table in IMMUTABLE:
                for op in ("UPDATE", "DELETE"):
                    conn.execute(f"CREATE TRIGGER IF NOT EXISTS {table}_no_{op.lower()} BEFORE {op} ON {table} "
                                 f"BEGIN SELECT RAISE(ABORT, 'SHADOW_RESEARCH_ROW_IMMUTABLE'); END;")
            conn.execute("INSERT OR IGNORE INTO shadow_meta VALUES ('schema_version', ?)", (str(C.SHADOW_SCHEMA_VERSION),))
            conn.execute("UPDATE shadow_meta SET value=? WHERE key='schema_version' AND CAST(value AS INTEGER) < ?",
                         (str(C.SHADOW_SCHEMA_VERSION), C.SHADOW_SCHEMA_VERSION))
            conn.commit()

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        """Forward-only, additive: a v1 database gains nullable columns. Old
        rows keep NULL (never backfilled with a guess); the immutability
        triggers are unaffected because adding a column is not an UPDATE."""
        for table in ("shadow_scans", "shadow_observations"):
            cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            if "source_commit" not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN source_commit TEXT")

    def versions(self) -> dict:
        """Version identifiers for the About screen / bug reports. The schema
        version is read from this database's own shadow_meta (not assumed
        from code); the label, classification and dataset identifiers are
        the ones this build writes on every new row."""
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT value FROM shadow_meta WHERE key='schema_version'").fetchone()
        return {"shadow_schema_version": int(row["value"]) if row else None,
                "supported_shadow_schema_version": C.SHADOW_SCHEMA_VERSION,
                "label_version": C.LABEL_VERSION, "classification_version": C.CLASSIFICATION_VERSION,
                "datasets_written": [C.DATASET_RAW, C.DATASET_RESOLVED, C.DATASET_PAPER_EXECUTED]}

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    # ---- ingest ----------------------------------------------------------
    @staticmethod
    def _validity(kind: str, decision: dict, decision_ts: int) -> tuple[bool, Optional[str]]:
        market = decision.get("market") or {}
        price, age = market.get("price"), market.get("data_age_ms")
        if not isinstance(price, (int, float)) or not price > 0:
            return False, "NO_MARKET_PRICE"
        if not isinstance(age, (int, float)) or age < 0 or age > C.MAX_SNAPSHOT_AGE_MS:
            return False, "STALE_SNAPSHOT"
        if kind == C.KIND_MARKET_STATE:
            return True, None
        cand = decision.get("candidate") or {}
        d, entry, stop = cand.get("direction"), cand.get("entry"), cand.get("stop")
        if d not in ("long", "short"):
            return False, "NO_DIRECTION"
        if not all(isinstance(v, (int, float)) and v > 0 for v in (entry, stop, cand.get("tp1"))):
            return False, "INCOMPLETE_GEOMETRY"
        if (d == "long" and not stop < entry) or (d == "short" and not stop > entry):
            return False, "STOP_ON_WRONG_SIDE_OF_ENTRY"
        if (d == "long" and price <= stop) or (d == "short" and price >= stop):
            return False, "STOP_ALREADY_BREACHED_AT_DECISION"
        return True, None

    def _cluster(self, conn: sqlite3.Connection, asset: str, kind: str, direction: Optional[str],
                 strategy: Optional[str], ts: int) -> tuple[str, float]:
        prev = conn.execute(
            "SELECT observation_cluster_id, decision_ts FROM shadow_observations WHERE asset=? AND kind=? AND "
            "IFNULL(direction,'')=? AND IFNULL(strategy,'')=? AND decision_ts < ? ORDER BY decision_ts DESC LIMIT 1",
            (asset, kind, direction or "", strategy or "", ts)).fetchone()
        if prev is None:
            return f"clu-{asset}-{kind}-{direction or 'none'}-{strategy or 'none'}-{ts}", 0.0
        gap = ts - prev["decision_ts"]
        overlap = max(0.0, 1.0 - gap / C.OVERLAP_WINDOW_MS)
        cluster = prev["observation_cluster_id"] if gap <= C.CLUSTER_GAP_MS else f"clu-{asset}-{kind}-{direction or 'none'}-{strategy or 'none'}-{ts}"
        return cluster, round(overlap, 6)

    def record_scan(self, payload: dict, now_ms: Optional[int] = None) -> dict:
        now_ms = now_ms or int(time.time() * 1000)
        scan = payload.get("scan") or {}
        scan_id, ts = scan.get("scan_id"), scan.get("decision_ts")
        if not isinstance(scan_id, str) or not scan_id or not isinstance(ts, int) or ts <= 0:
            raise ValueError("SHADOW_SCAN_REQUIRES_SCAN_ID_AND_DECISION_TS")
        versions = {k: scan.get(k) for k in ("generator_version", "feature_version", "model_version")}
        if not versions["generator_version"] or not versions["feature_version"]:
            raise ValueError("SHADOW_SCAN_REQUIRES_GENERATOR_AND_FEATURE_VERSION")
        execution = scan.get("execution") or {}
        exec_decision = execution.get("decision") or "NO_SIGNAL"
        if exec_decision not in C.EXECUTION_STATUSES:
            raise ValueError(f"UNKNOWN_EXECUTION_DECISION: {exec_decision}")
        observations = payload.get("observations") or []
        for obs in observations:          # leakage guard at ingest, before anything is written
            if obs.get("kind") not in C.KINDS:
                raise ValueError(f"UNKNOWN_OBSERVATION_KIND: {obs.get('kind')}")
            C.assert_decision_payload(obs.get("decision") or {})
        C.assert_decision_payload({k: v for k, v in scan.items() if k != "execution"})
        inserted = 0
        with closing(self._connect()) as conn:
            if conn.execute("SELECT 1 FROM shadow_scans WHERE scan_id=?", (scan_id,)).fetchone():
                return {"scan_id": scan_id, "inserted": 0, "duplicate": True}
            n_cand = sum(1 for o in observations if o.get("kind") == C.KIND_CANDIDATE)
            state = ("RESEARCH_SUPPLEMENT" if scan.get("scan_scope") == "RESEARCH_SUPPLEMENT"
                     else "TRADE_SELECTED" if scan.get("submitted_signal_id") else "NO_TRADE")
            conn.execute(
                "INSERT INTO shadow_scans (scan_id, decision_ts, scan_status, scan_state, execution_decision, execution_reason, "
                "submitted_signal_id, n_markets, n_candidates, observation_interval_ms, generator_version, feature_version, model_version, "
                "dataset_version, detail, created_at_ms, source_commit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (scan_id, ts, scan.get("scan_status"), state, exec_decision, execution.get("reason"), scan.get("submitted_signal_id"),
                 int(scan.get("n_markets") or 0), n_cand, scan.get("observation_interval_ms"), versions["generator_version"],
                 versions["feature_version"], versions["model_version"], C.DATASET_RAW,
                 _blob({"failures": scan.get("failures") or [], "universe": scan.get("universe"), "cross_market": scan.get("cross_market"),
                        "scan_scope": scan.get("scan_scope") or "PRODUCTION_SCAN"}), now_ms, self.source_commit))
            for obs in observations:
                kind, decision = obs["kind"], obs.get("decision") or {}
                asset, coin = str(obs.get("asset") or ""), str(obs.get("coin") or obs.get("asset") or "")
                if not asset:
                    raise ValueError("SHADOW_OBSERVATION_REQUIRES_ASSET")
                cand = decision.get("candidate") or {}
                direction, strategy = cand.get("direction"), cand.get("strategy")
                oid = C.observation_id(scan_id, kind, asset, direction, strategy)
                valid, invalid = self._validity(kind, decision, ts)
                submitted = bool(obs.get("submitted"))
                if kind == C.KIND_MARKET_STATE:
                    status, reason = "NOT_APPLICABLE", None
                elif submitted:
                    status, reason = exec_decision, execution.get("reason")
                else:
                    status, reason = "NOT_SUBMITTED", obs.get("not_submitted_reason") or "NOT_PRODUCTION_SELECTION"
                cluster, overlap = self._cluster(conn, asset, kind, direction, strategy, ts)
                first_bar = R.first_bar_open(ts)
                full_decision = {**decision, "production_state": obs.get("production_state"), "kind": kind, "asset": asset, "coin": coin}
                cur = conn.execute(
                    "INSERT OR IGNORE INTO shadow_observations (observation_id, scan_id, kind, asset, coin, direction, strategy, decision_ts, "
                    "first_bar_ts, production_rank, scan_candidate_rank, is_production_pick, production_state, execution_status, "
                    "execution_rejection_reason, research_candidate_valid, invalid_reason, observation_cluster_id, market_episode_id, "
                    "overlap_fraction, generator_version, feature_version, model_version, dataset_version, outcome_venue, outcome_interval, "
                    "decision, decision_hash, created_at_ms, source_commit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (oid, scan_id, kind, asset, coin, direction, strategy, ts, first_bar, cand.get("production_rank"),
                     cand.get("scan_candidate_rank"), int(bool(cand.get("is_production_pick"))), obs.get("production_state"),
                     status, reason, int(valid), invalid, cluster, f"ep-{asset}-{ts // C.EPISODE_MS}", overlap,
                     versions["generator_version"], versions["feature_version"], versions["model_version"], C.DATASET_RAW,
                     C.OUTCOME_VENUE, C.OUTCOME_INTERVAL, _blob(full_decision), C.content_hash(full_decision), now_ms, self.source_commit))
                if cur.rowcount:
                    inserted += 1
                    conn.execute("INSERT OR IGNORE INTO shadow_resolution VALUES (?,?,?,?,?,?,?)",
                                 (oid, coin, first_bar, "[]", "PENDING" if valid else "NOT_RESOLVABLE_INVALID_SNAPSHOT",
                                  _next_due(ts, first_bar, []) if valid else None, now_ms))
                if submitted and exec_decision == "EXECUTED" and execution.get("signal_id"):
                    conn.execute("INSERT OR IGNORE INTO forward_paper_executed VALUES (?,?,?,?,?,?,?)",
                                 (execution["signal_id"], oid, scan_id, ts, C.DATASET_PAPER_EXECUTED,
                                  _blob(execution.get("trade") or {}), now_ms))
            conn.commit()
        return {"scan_id": scan_id, "inserted": inserted, "duplicate": False}

    # ---- execution quality (outcome data, copied from the paper ledger) --------
    @staticmethod
    def execution_quality_of(trade: dict) -> dict:
        """The execution-quality view of a CLOSED paper trade, read from the
        ledger's own figures (never recomputed from prices). Latency is
        signal time -> paper fill time; stop overshoot is how far past its
        level a stop exit filled (adverse, >= 0)."""
        long = trade.get("direction") == "long"
        exits = trade.get("exits") or []
        overshoot = []
        for e in exits:
            level, fill = e.get("level"), e.get("fill_price")
            if "STOP" in str(e.get("kind")) and isinstance(level, (int, float)) and isinstance(fill, (int, float)):
                overshoot.append({"kind": e["kind"], "level": level, "fill_price": fill,
                                  "overshoot": max(0.0, (level - fill) if long else (fill - level))})
        signal_ts, opened = trade.get("signal_timestamp"), trade.get("opened_at_ms")
        return {
            "signal_id": trade.get("signal_id"), "trade_id": trade.get("trade_id"), "asset": trade.get("asset"), "direction": trade.get("direction"),
            "opened_at_ms": opened, "closed_at_ms": trade.get("closed_at_ms"), "exit_reason": trade.get("exit_reason"),
            "entry_fill": trade.get("entry_fill"), "signal_entry": trade.get("signal_entry"), "quantity": trade.get("quantity"),
            "fees": trade.get("fees"), "entry_slippage_cost": trade.get("slippage_cost"),
            "latency_to_fill_ms": (opened - signal_ts) if isinstance(opened, int) and isinstance(signal_ts, int) else None,
            "stop_overshoot": overshoot,
            "exit_fills": [{"kind": e.get("kind"), "quantity": e.get("quantity"), "fill_price": e.get("fill_price"),
                            "level": e.get("level"), "at_ms": e.get("at_ms"), "trigger": e.get("trigger")} for e in exits],
            "best_price": trade.get("best_price"), "best_price_at_ms": trade.get("best_price_at_ms"), "best_price_precision": trade.get("best_price_precision"),
            "worst_price": trade.get("worst_price"), "worst_price_at_ms": trade.get("worst_price_at_ms"), "worst_price_precision": trade.get("worst_price_precision"),
        }

    def record_execution_quality(self, trade: dict, now_ms: Optional[int] = None) -> bool:
        """Once per closed paper trade (first write wins; immutable)."""
        if trade.get("status") != "CLOSED" or not trade.get("signal_id"):
            return False
        now_ms = now_ms or int(time.time() * 1000)
        record = self.execution_quality_of(trade)
        with closing(self._connect()) as conn:
            link = conn.execute("SELECT observation_id, scan_id FROM forward_paper_executed WHERE signal_id=?", (trade["signal_id"],)).fetchone()
            cur = conn.execute(
                "INSERT OR IGNORE INTO forward_execution_quality (signal_id, observation_id, scan_id, dataset_version, field_class, source, "
                "source_commit, record, record_hash, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (trade["signal_id"], link["observation_id"] if link else None, link["scan_id"] if link else None, C.DATASET_PAPER_EXECUTED,
                 "OUTCOME_EVENT", "PAPER_LEDGER", self.source_commit, _blob(record), C.content_hash(record), now_ms))
            conn.commit()
            return bool(cur.rowcount)

    def execution_quality(self, signal_id: str) -> Optional[dict]:
        with closing(self._connect()) as conn:
            r = conn.execute("SELECT * FROM forward_execution_quality WHERE signal_id=?", (signal_id,)).fetchone()
        if r is None:
            return None
        record = _unblob(r["record"])
        return {"signal_id": r["signal_id"], "observation_id": r["observation_id"], "scan_id": r["scan_id"], "field_class": r["field_class"],
                "source": r["source"], "source_commit": r["source_commit"], "record": record,
                "record_hash_ok": C.content_hash(record) == r["record_hash"]}

    # ---- resolution ------------------------------------------------------
    def pending(self, now_ms: Optional[int] = None, limit: int = 50) -> list[dict]:
        """Coins with at least one label batch whose window has closed."""
        now_ms = now_ms or int(time.time() * 1000)
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT coin, MIN(first_bar_ts) AS since_ms, COUNT(*) AS due FROM shadow_resolution "
                "WHERE resolution_status IN ('PENDING','PARTIAL') AND next_due_ts <= ? GROUP BY coin ORDER BY since_ms LIMIT ?",
                (now_ms, limit)).fetchall()
        return [dict(r) for r in rows]

    def resolve(self, coin: str, candles: list[dict], venue: str, interval: str, now_ms: Optional[int] = None) -> dict:
        """Labels every due batch of this coin's observations from the given
        same-venue completed candles. Nothing else is consulted."""
        now_ms = now_ms or int(time.time() * 1000)
        if venue != C.OUTCOME_VENUE or interval != C.OUTCOME_INTERVAL:
            raise ValueError(f"SHADOW_OUTCOMES_REQUIRE_{C.OUTCOME_VENUE}_{C.OUTCOME_INTERVAL}: got {venue} {interval}")
        by_time: dict[int, dict] = {}
        for c in candles or []:
            try:
                bar = {k: float(c[k]) for k in ("open", "high", "low", "close")}
                t = int(c["time"])
            except (KeyError, TypeError, ValueError):
                continue
            if t % C.BAR_MS or t + C.BAR_MS > now_ms or bar["low"] <= 0 or bar["high"] < max(bar["open"], bar["close"]) or bar["low"] > min(bar["open"], bar["close"]):
                continue   # incomplete or malformed bars are dropped, never repaired
            by_time[t] = {"time": t, **bar}
        # Coverage of THIS candle set: a batch whose span it doesn't cover is
        # simply not resolvable from it (skipped, retried with other data);
        # only a gap *inside* covered data is a real missing candle. Batches
        # nobody could cover within DATA_EXPIRY_MS are closed as unavailable.
        lo, hi = (min(by_time), max(by_time)) if by_time else (None, None)
        written = {"labels": 0, "hindsight": 0, "unresolved": 0}
        with closing(self._connect()) as conn:
            due = conn.execute(
                "SELECT r.observation_id, r.batches_done, o.kind, o.decision_ts, o.first_bar_ts, o.execution_status, o.decision "
                "FROM shadow_resolution r JOIN shadow_observations o USING (observation_id) "
                "WHERE r.coin=? AND r.resolution_status IN ('PENDING','PARTIAL') AND r.next_due_ts <= ?", (coin, now_ms)).fetchall()
            for row in due:
                done = json.loads(row["batches_done"])
                decision = _unblob(row["decision"])
                final_label, batch_statuses = None, []
                for batch, horizons in C.LABEL_BATCHES.items():
                    if batch in done or _batch_due(row["first_bar_ts"], row["decision_ts"], batch) > now_ms:
                        continue
                    end_ts = _batch_due(row["first_bar_ts"], row["decision_ts"], batch)
                    last_bar = R.first_bar_open(end_ts) - C.BAR_MS
                    if lo is None or row["first_bar_ts"] < lo or last_bar > hi:
                        if now_ms - end_ts < DATA_EXPIRY_MS:
                            continue
                        labels = {h: {"label_status": "UNRESOLVED_DATA_UNAVAILABLE"} for h in horizons}
                        conn.execute("INSERT OR IGNORE INTO shadow_labels VALUES (?,?,?,?,?,?,?,?,?)",
                                     (row["observation_id"], batch, end_ts, "UNRESOLVED_DATA_UNAVAILABLE", C.LABEL_VERSION,
                                      C.DATASET_RESOLVED, _blob(labels), C.content_hash(labels), now_ms))
                        written["labels"] += 1
                        written["unresolved"] += 1
                        done.append(batch)
                        batch_statuses.append("UNRESOLVED_DATA_UNAVAILABLE")
                        continue
                    labels, statuses = {}, []
                    for h in horizons:
                        status, bars = R.window_bars(by_time, row["decision_ts"], C.HORIZONS[h], now_ms)
                        if status == "DUE_NOT_CLOSED":
                            break
                        if status != "OK":
                            labels[h] = {"label_status": status, "missing_bars": bars}
                            statuses.append(status)
                            continue
                        lab = (R.candidate_horizon(decision, bars, row["decision_ts"], C.HORIZONS[h]) if row["kind"] == C.KIND_CANDIDATE
                               else R.market_state_horizon(bars, row["decision_ts"], C.HORIZONS[h]))
                        if h == "72h":
                            lab = {**lab, "excursion_path": R.excursion_path(bars, bars[0]["open"])}
                        labels[h] = {"label_status": "OK", **lab}
                        statuses.append("OK")
                    else:
                        batch_status = "OK" if all(s == "OK" for s in statuses) else "PARTIAL_UNRESOLVED"
                        end = _batch_due(row["first_bar_ts"], row["decision_ts"], batch)
                        conn.execute("INSERT OR IGNORE INTO shadow_labels VALUES (?,?,?,?,?,?,?,?,?)",
                                     (row["observation_id"], batch, end, batch_status, C.LABEL_VERSION, C.DATASET_RESOLVED,
                                      _blob(labels), C.content_hash(labels), now_ms))
                        written["labels"] += 1
                        written["unresolved"] += batch_status != "OK"
                        done.append(batch)
                        batch_statuses.append(batch_status)
                        if batch == C.FINAL_BATCH:
                            final_label = labels.get("72h") if (labels.get("72h") or {}).get("label_status") == "OK" else None
                            # Hindsight on the longest contiguous complete prefix of the full window.
                            _, full = R.window_bars(by_time, row["decision_ts"], C.FULL_WINDOW_MS, now_ms)
                            bars_used = full if isinstance(full, list) else self._prefix(by_time, row["first_bar_ts"], row["decision_ts"])
                            if bars_used:
                                h = R.hindsight(row["kind"], decision, bars_used, row["execution_status"], final_label)
                                conn.execute("INSERT OR IGNORE INTO shadow_hindsight VALUES (?,?,?,?,?,?)",
                                             (row["observation_id"], h["classification"], C.LABEL_VERSION, C.DATASET_RESOLVED, _blob(h), now_ms))
                                written["hindsight"] += 1
                if not batch_statuses:
                    continue
                all_done = len(done) == len(C.LABEL_BATCHES)
                prior = conn.execute("SELECT COUNT(*) FROM shadow_labels WHERE observation_id=? AND label_status!='OK'", (row["observation_id"],)).fetchone()[0]
                status = ("RESOLVED" if not prior else "RESOLVED_WITH_GAPS") if all_done else "PARTIAL"
                conn.execute("UPDATE shadow_resolution SET batches_done=?, resolution_status=?, next_due_ts=?, updated_at_ms=? WHERE observation_id=?",
                             (json.dumps(done), status, _next_due(row["decision_ts"], row["first_bar_ts"], done), now_ms, row["observation_id"]))
            conn.commit()
        return {"coin": coin, "candles_used": len(by_time), **written}

    @staticmethod
    def _prefix(by_time: dict[int, dict], first_bar: int, decision_ts: int) -> list[dict]:
        bars, t = [], first_bar
        while t < decision_ts + C.FULL_WINDOW_MS and t in by_time:
            bars.append(by_time[t])
            t += C.BAR_MS
        return bars

    # ---- reads -----------------------------------------------------------
    def summary(self, since_ms: Optional[int] = None, now_ms: Optional[int] = None) -> dict:
        now_ms = now_ms or int(time.time() * 1000)
        since_ms = since_ms if since_ms is not None else now_ms - now_ms % 86_400_000
        with closing(self._connect()) as conn:
            one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]
            classes = {r[0]: r[1] for r in conn.execute(
                "SELECT h.classification, COUNT(*) FROM shadow_hindsight h JOIN shadow_observations o USING (observation_id) "
                "WHERE o.decision_ts >= ? GROUP BY h.classification", (since_ms,))}
            res = {r[0]: r[1] for r in conn.execute(
                "SELECT r.resolution_status, COUNT(*) FROM shadow_resolution r JOIN shadow_observations o USING (observation_id) "
                "WHERE o.decision_ts >= ? GROUP BY r.resolution_status", (since_ms,))}
            return {
                "since_ms": since_ms, "research_only": True,
                "scans": one("SELECT COUNT(*) FROM shadow_scans WHERE decision_ts >= ?", since_ms),
                "no_trade_scans": one("SELECT COUNT(*) FROM shadow_scans WHERE decision_ts >= ? AND scan_state='NO_TRADE'", since_ms),
                "observations": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ?", since_ms),
                "candidate_observations": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND kind='CANDIDATE'", since_ms),
                "market_state_observations": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND kind='MARKET_STATE'", since_ms),
                "no_trade_states": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND kind='MARKET_STATE' AND production_state='NO_TRADE'", since_ms),
                "paper_executed": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND execution_status='EXECUTED'", since_ms),
                "rejected_but_tracked": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND execution_status='REJECTED'", since_ms),
                "not_submitted_tracked": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND execution_status='NOT_SUBMITTED'", since_ms),
                "invalid_snapshots": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND research_candidate_valid=0", since_ms),
                "resolved": res.get("RESOLVED", 0) + res.get("RESOLVED_WITH_GAPS", 0),
                "partially_resolved": res.get("PARTIAL", 0),
                "unresolved": res.get("PENDING", 0),
                "resolution": res,
                "classifications": classes,
                "missed_opportunities": classes.get("GOOD_TRADE_MISSED", 0) + classes.get("MISSED_OPPORTUNITY", 0),
                "bad_trades_avoided": classes.get("BAD_TRADE_AVOIDED", 0),
                "clusters": one("SELECT COUNT(DISTINCT observation_cluster_id) FROM shadow_observations WHERE decision_ts >= ?", since_ms),
                "episodes": one("SELECT COUNT(DISTINCT market_episode_id) FROM shadow_observations WHERE decision_ts >= ?", since_ms),
                "research_supplement_observations": one("SELECT COUNT(*) FROM shadow_observations WHERE decision_ts >= ? AND production_state='OUTSIDE_PRODUCTION_UNIVERSE'", since_ms),
                "observations_by_asset": {r[0]: r[1] for r in conn.execute(
                    "SELECT asset, COUNT(*) FROM shadow_observations WHERE decision_ts >= ? GROUP BY asset ORDER BY asset", (since_ms,))},
                "db_bytes": os.path.getsize(self.path) if os.path.exists(self.path) else 0,
            }

    def observations(self, limit: int = 100, kind: Optional[str] = None, execution_status: Optional[str] = None,
                     classification: Optional[str] = None) -> list[dict]:
        sql = ("SELECT o.observation_id, o.scan_id, o.kind, o.asset, o.direction, o.strategy, o.decision_ts, o.production_rank, "
               "o.scan_candidate_rank, o.is_production_pick, o.production_state, o.execution_status, o.execution_rejection_reason, "
               "o.research_candidate_valid, o.invalid_reason, o.observation_cluster_id, o.market_episode_id, o.overlap_fraction, "
               "r.resolution_status, h.classification FROM shadow_observations o LEFT JOIN shadow_resolution r USING (observation_id) "
               "LEFT JOIN shadow_hindsight h USING (observation_id) WHERE 1=1")
        args: list[Any] = []
        for col, val in (("o.kind", kind), ("o.execution_status", execution_status), ("h.classification", classification)):
            if val:
                sql += f" AND {col}=?"
                args.append(val)
        sql += " ORDER BY o.decision_ts DESC, o.observation_id LIMIT ?"
        args.append(max(1, min(int(limit), 1000)))
        with closing(self._connect()) as conn:
            return [dict(r) for r in conn.execute(sql, args)]

    def observation(self, observation_id: str) -> Optional[dict]:
        with closing(self._connect()) as conn:
            o = conn.execute("SELECT * FROM shadow_observations WHERE observation_id=?", (observation_id,)).fetchone()
            if o is None:
                return None
            decision = _unblob(o["decision"])
            labels = {r["batch"]: {"label_status": r["label_status"], "window_end_ts": r["window_end_ts"], "labels": _unblob(r["labels"]),
                                   "label_hash_ok": C.content_hash(_unblob(r["labels"])) == r["label_hash"]}
                      for r in conn.execute("SELECT * FROM shadow_labels WHERE observation_id=? ORDER BY batch", (observation_id,))}
            h = conn.execute("SELECT * FROM shadow_hindsight WHERE observation_id=?", (observation_id,)).fetchone()
            res = conn.execute("SELECT resolution_status, batches_done, next_due_ts FROM shadow_resolution WHERE observation_id=?", (observation_id,)).fetchone()
        meta = {k: o[k] for k in o.keys() if k not in ("decision",)}
        return {
            **meta, "resolution": dict(res) if res else None,
            "DECISION_TIME_DATA": decision, "decision_hash_ok": C.content_hash(decision) == o["decision_hash"],
            "FUTURE_LABEL_DATA": labels,
            "POST_OUTCOME_RESEARCH_ONLY": ({"notice": "Hindsight labels describe what the market offered after the fact. They are not predictions and are never model features.",
                                            **_unblob(h["labels"])} if h else None),
        }

    def link_for_signal(self, signal_id: str) -> Optional[dict]:
        """Shadow side of an executed paper trade, joined by its stable
        signal_id (forward_paper_executed -> observation). Read only: returns
        ids and resolution progress, never copies of the decision or labels.
        post_outcome is only present once the final batch (and with it the
        hindsight record) has been written."""
        if not signal_id:
            return None
        with closing(self._connect()) as conn:
            link = conn.execute("SELECT observation_id, scan_id, decision_ts FROM forward_paper_executed WHERE signal_id=?",
                                (signal_id,)).fetchone()
            if link is None or not link["observation_id"]:
                return None
            oid = link["observation_id"]
            res = conn.execute("SELECT resolution_status, batches_done, next_due_ts FROM shadow_resolution WHERE observation_id=?",
                               (oid,)).fetchone()
            rows = conn.execute("SELECT batch, label_status, window_end_ts, labels FROM shadow_labels WHERE observation_id=? ORDER BY batch",
                                (oid,)).fetchall()
            batches = [(r["batch"], r["label_status"], r["window_end_ts"]) for r in rows]
            # per-horizon status only (the label values stay in the store)
            horizon_status = {hz: (lab or {}).get("label_status") for r in rows for hz, lab in _unblob(r["labels"]).items()
                              if hz in C.HORIZONS}
            h = conn.execute("SELECT labels, resolved_at_ms FROM shadow_hindsight WHERE observation_id=?", (oid,)).fetchone()
        resolved = [hz for hz in C.HORIZONS if horizon_status.get(hz) == "OK"]
        return {
            "observation_id": oid, "scan_id": link["scan_id"], "decision_ts": link["decision_ts"],
            "resolution_status": res["resolution_status"] if res else None,
            "next_due_ts": res["next_due_ts"] if res else None,
            "batches": [{"batch": b, "label_status": st, "window_end_ts": w} for b, st, w in batches],
            "resolved_horizons": resolved,
            "unresolvable_horizons": [hz for hz in C.HORIZONS if hz in horizon_status and horizon_status[hz] != "OK"],
            "pending_horizons": [hz for hz in C.HORIZONS if hz not in horizon_status],
            "post_outcome": ({"resolved_at_ms": h["resolved_at_ms"], "labels": _unblob(h["labels"])} if h else None),
        }

    def training_rows(self, feature_paths: list[str], target_batch: str = C.FINAL_BATCH, target_horizon: str = "72h",
                      target: str = "policy_r", kind: str = C.KIND_CANDIDATE) -> dict:
        """The only export for model research: decision-time features (by
        explicit dotted path) plus one target, with grouping keys. The
        leakage guard runs on the feature names before anything is read."""
        C.assert_decision_features(feature_paths)
        rows = []
        with closing(self._connect()) as conn:
            for r in conn.execute(
                    "SELECT o.observation_id, o.scan_id, o.observation_cluster_id, o.market_episode_id, o.decision, l.labels "
                    "FROM shadow_observations o JOIN shadow_labels l ON l.observation_id=o.observation_id AND l.batch=? "
                    "WHERE o.research_candidate_valid=1 AND o.kind=?", (target_batch, kind)):
                decision, labels = _unblob(r["decision"]), _unblob(r["labels"])
                feats = {}
                for path in feature_paths:
                    value: Any = decision
                    for part in path.split("."):
                        value = value.get(part) if isinstance(value, dict) else None
                    feats[path] = value
                y = (labels.get(target_horizon) or {}).get(target)
                rows.append({"observation_id": r["observation_id"], "scan_id": r["scan_id"], "cluster": r["observation_cluster_id"],
                             "episode": r["market_episode_id"], "features": feats, "target": y})
        return {"feature_paths": feature_paths, "kind": kind, "target": f"{target_horizon}.{target}", "rows": rows,
                "grouping": "cluster/episode -- never treat rows as independent"}
