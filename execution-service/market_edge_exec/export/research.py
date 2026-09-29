"""Read-only export of research data to CSV (or Parquet when pyarrow is
importable) for offline analysis.

Both databases are opened with SQLite's read-only URI mode, so an export can
never write back. Decision-time, outcome-label and post-outcome/hindsight data
go to separate files whose names start with DECISION__, OUTCOME__ or
HINDSIGHT__ (paper-ledger trade records, which hold the entry plus realized
exits, are LEDGER__); no row mixes decision-time and hindsight values. Settings and secrets tables are never read.

This is not a backup format (see desktop backup.rs for that)."""
from __future__ import annotations

import csv
import json
import os
import sqlite3
import time
import zlib
from contextlib import closing
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional

from market_edge_exec import __version__

FORMATS = ("csv", "parquet")
MANIFEST_SCHEMA = "research-export/v1"

# Categories the roadmap asks for that have no persisted data yet. Reported
# in the manifest so an analyst can tell "not available" from "empty".
NOT_YET_AVAILABLE = {
    "risk_sizing": "No risk-sizing decision records are persisted yet (MAJOR 2, #15).",
    "adaptive_exit_counterfactuals": "No adaptive-exit counterfactuals are persisted yet (MAJOR 3G, #23).",
}


def _unblob(value: Any) -> Any:
    """Shadow blobs are zlib-compressed canonical JSON."""
    return json.loads(zlib.decompress(value).decode())


def _json_text(value: Any) -> Optional[str]:
    return None if value is None else json.dumps(value, sort_keys=True, separators=(",", ":"))


def _from_blob(value: Any) -> Optional[str]:
    return None if value is None else _json_text(_unblob(value))


def _from_text(value: Any) -> Optional[str]:
    return None if value is None else _json_text(json.loads(value))


# (file stem, database, SQL, {column: converter}). Every SELECT names its
# columns explicitly, so a column added later is never exported by accident.
FILES: tuple[tuple[str, str, str, dict[str, Callable[[Any], Any]]], ...] = (
    ("DECISION__shadow_observations", "shadow",
     "SELECT o.observation_id, o.scan_id, o.kind, o.asset, o.coin, o.direction, o.strategy, o.decision_ts, o.first_bar_ts, "
     "o.production_rank, o.scan_candidate_rank, o.is_production_pick, o.production_state, o.execution_status, "
     "o.execution_rejection_reason, o.research_candidate_valid, o.invalid_reason, o.observation_cluster_id, "
     "o.market_episode_id, o.overlap_fraction, o.generator_version, o.feature_version, o.model_version, "
     "o.dataset_version, o.outcome_venue, o.outcome_interval, o.decision_hash, o.created_at_ms, o.decision AS decision_json "
     "FROM shadow_observations o ORDER BY o.decision_ts, o.observation_id",
     {"decision_json": _from_blob}),
    ("DECISION__shadow_scans", "shadow",
     "SELECT scan_id, decision_ts, scan_status, scan_state, execution_decision, execution_reason, submitted_signal_id, "
     "n_markets, n_candidates, observation_interval_ms, generator_version, feature_version, model_version, dataset_version, "
     "created_at_ms, detail AS detail_json FROM shadow_scans ORDER BY decision_ts, scan_id",
     {"detail_json": _from_blob}),
    ("OUTCOME__shadow_resolution_status", "shadow",
     "SELECT observation_id, coin, first_bar_ts, batches_done, resolution_status, next_due_ts, updated_at_ms "
     "FROM shadow_resolution ORDER BY observation_id", {}),
    ("OUTCOME__shadow_labels", "shadow",
     "SELECT observation_id, batch, window_end_ts, label_status, label_version, dataset_version, label_hash, resolved_at_ms, "
     "labels AS labels_json FROM shadow_labels ORDER BY observation_id, batch",
     {"labels_json": _from_blob}),
    ("HINDSIGHT__shadow_post_outcome_research_only", "shadow",
     "SELECT observation_id, classification, label_version, dataset_version, resolved_at_ms, labels AS hindsight_json "
     "FROM shadow_hindsight ORDER BY observation_id",
     {"hindsight_json": _from_blob}),
    ("DECISION__forward_paper_executed", "shadow",
     "SELECT signal_id, observation_id, scan_id, decision_ts, dataset_version, created_at_ms, trade AS trade_json "
     "FROM forward_paper_executed ORDER BY decision_ts, signal_id",
     {"trade_json": _from_blob}),
    ("LEDGER__paper_trades", "paper",
     "SELECT trade_id, instrument, status, opened_at_ms, closed_at_ms, payload AS trade_json FROM paper_trades "
     "ORDER BY opened_at_ms, trade_id",
     {"trade_json": _from_text}),
    ("OUTCOME__paper_trade_events", "paper",
     "SELECT id, trade_id, kind, at_ms, payload AS event_json FROM paper_trade_events ORDER BY trade_id, at_ms, id",
     {"event_json": _from_text}),
    ("HINDSIGHT__paper_post_outcome_research_only", "paper",
     "SELECT trade_id, resolved_at_ms, source, payload AS hindsight_json FROM paper_hindsight ORDER BY trade_id",
     {"hindsight_json": _from_text}),
)


def _open_ro(path: str) -> sqlite3.Connection:
    uri = "file:" + os.path.abspath(path).replace(os.sep, "/") + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _rows(conn: sqlite3.Connection, sql: str, converters: dict) -> tuple[list[str], Iterable[list]]:
    cur = conn.execute(sql)
    columns = [d[0] for d in cur.description]
    conv = [converters.get(c) for c in columns]

    def gen():
        for row in cur:
            yield [f(v) if f else v for f, v in zip(conv, row)]
    return columns, gen()


def _write_csv(path: str, columns: list[str], rows: Iterable[list]) -> int:
    n = 0
    with open(path, "x", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(columns)
        for row in rows:
            w.writerow(row)
            n += 1
    return n


def _write_parquet(path: str, columns: list[str], rows: Iterable[list]) -> int:
    import pyarrow as pa
    import pyarrow.parquet as pq
    data = list(rows)
    table = pa.table({c: [r[i] for r in data] for i, c in enumerate(columns)})
    if os.path.exists(path):
        raise FileExistsError(path)
    pq.write_table(table, path)
    return len(data)


def parquet_available() -> bool:
    try:
        import pyarrow.parquet  # noqa: F401
        return True
    except Exception:
        return False


def export_research(paper_db: str, shadow_db: Optional[str], out_dir: str, fmt: str = "csv",
                    now: Optional[float] = None) -> dict:
    """Write one file per category into a new folder under out_dir and return
    the manifest. Never overwrites: the folder is new and files open with 'x'."""
    if fmt not in FORMATS:
        raise ValueError(f"UNSUPPORTED_FORMAT: {fmt}")
    if fmt == "parquet" and not parquet_available():
        raise ValueError("PARQUET_UNAVAILABLE: pyarrow is not importable in this build; use csv")
    if not os.path.isabs(out_dir) or not os.path.isdir(out_dir):
        raise ValueError("OUT_DIR_INVALID: must be an existing absolute directory")
    now = time.time() if now is None else now
    stamp = datetime.fromtimestamp(now, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = os.path.join(out_dir, f"market-edge-research-{stamp}")
    os.makedirs(folder, exist_ok=False)

    sources = {"paper": paper_db if paper_db and os.path.isfile(paper_db) else None,
               "shadow": shadow_db if shadow_db and os.path.isfile(shadow_db) else None}
    conns = {k: _open_ro(v) for k, v in sources.items() if v}
    files, missing = [], []
    writer = _write_csv if fmt == "csv" else _write_parquet
    try:
        tables = {k: _tables(c) for k, c in conns.items()}
        for stem, db, sql, converters in FILES:
            table = sql.split(" FROM ", 1)[1].split()[0]
            if db not in conns or table not in tables[db]:
                missing.append({"file": stem, "reason": f"{db} database has no {table} table" if db in conns else f"no {db} database"})
                continue
            columns, rows = _rows(conns[db], sql, converters)
            name = f"{stem}.{fmt}"
            count = writer(os.path.join(folder, name), columns, rows)
            files.append({"file": name, "rows": count, "columns": columns,
                          "section": stem.split("__", 1)[0], "source": f"{db}:{table}"})
    finally:
        for c in conns.values():
            c.close()

    manifest = {
        "schema": MANIFEST_SCHEMA, "created_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        "backend_version": __version__, "format": fmt, "folder": folder, "read_only": True,
        "sections": {"DECISION": "known at decision time",
                     "LEDGER": "paper-ledger trade records: the entry as decided plus realized exits; no hindsight fields",
                     "OUTCOME": "labels and events written after the fact (evaluation windows, fills)",
                     "HINDSIGHT": "POST-OUTCOME RESEARCH ONLY; never a decision-time value or model feature"},
        "files": files, "skipped": missing,
        "not_yet_available": [{"category": k, "reason": v} for k, v in NOT_YET_AVAILABLE.items()],
    }
    with open(os.path.join(folder, "manifest.json"), "x", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
    return manifest
