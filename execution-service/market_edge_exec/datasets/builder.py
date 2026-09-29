"""DATA 3: freeze the live shadow database into an immutable, versioned snapshot.

Read-only against the source (SQLite `mode=ro`). Trains nothing. Never reads
the sealed holdout (this module only knows forward shadow data).

What goes in:
  - observations the DATA 2 gate calls VALID (computed in memory with the same
    checks, nothing written), of kind CANDIDATE, research_candidate_valid = 1
  - whose required outcome (target horizon, final label batch) is resolved
  - decision-time features only: every feature path goes through the leakage guard
What it decides:
  - the unit of splitting is a connected component of scans that share an
    observation cluster or market episode, so correlated rows and a scan's own
    candidates are never separated
  - chronological train / validation / OOS by each unit's first decision time,
    no shuffling, and a purge: a unit whose outcome window is still open when
    the next split starts is dropped, so no label window overlaps a later split
What comes out: <out_dir>/<version>/snapshot.sqlite3 (read-only, triggers refuse
UPDATE/DELETE) and manifest.json. A version is never overwritten.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
import zlib
from collections import Counter, defaultdict
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.datasets import BUILDER_VERSION
from market_edge_exec.quality import runner as quality_runner, checks as K
from market_edge_exec.shadow import contracts as C

BASE_DATASET = C.DATASET_RESOLVED            # FORWARD-SHADOW-RESOLVED-V1
SPLITS = ("TRAIN", "VALIDATION", "OOS")
DEFAULT_FRACTIONS = (0.6, 0.2, 0.2)
FEATURE_ROOTS = ("features", "derivatives", "cross_market")


class SnapshotError(ValueError):
    pass


def _unblob(value: bytes) -> Any:
    return json.loads(zlib.decompress(value).decode())


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class _ReadOnlyShadow:
    """Just enough of ShadowStore for quality_runner.compute(), opened read-only."""

    def __init__(self, path: str):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect("file:" + os.path.abspath(self.path).replace("\\", "/") + "?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn


def _leaves(node: Any, prefix: str = ""):
    if isinstance(node, dict):
        for k in sorted(node):
            yield from _leaves(node[k], f"{prefix}.{k}" if prefix else k)
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        yield prefix


def discover_feature_paths(decisions: list[dict]) -> list[str]:
    """Every numeric leaf under the decision-time roots, sorted. Frame blocks that are absent for some rows stay null there."""
    paths: set[str] = set()
    for d in decisions:
        for root in FEATURE_ROOTS:
            paths.update(_leaves(d.get(root) or {}, root))
    return sorted(paths)


def _get(decision: dict, path: str) -> Any:
    value: Any = decision
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _quant_score(decision: dict) -> Optional[float]:
    """The production Quant score at decision time (the current-policy baseline's own input). Stored beside the rows, not as a feature."""
    v = (decision.get("candidate") or {}).get("quant_score")
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _regime(decision: dict) -> Optional[str]:
    v = (decision.get("candidate") or {}).get("regime") or decision.get("regime")
    return str(v) if v else None


def _components(units: dict[str, dict]) -> list[list[str]]:
    """Connected components of scans linked by a shared cluster id or market episode id."""
    parent = {s: s for s in units}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    owner: dict[tuple[str, str], str] = {}
    for scan, u in sorted(units.items()):
        for key in sorted(u["clusters"]) + sorted(u["episodes"]):
            k = (("c" if key in u["clusters"] else "e"), key)
            if k in owner:
                a, b = find(scan), find(owner[k])
                if a != b:
                    parent[max(a, b)] = min(a, b)
            else:
                owner[k] = scan
    groups: dict[str, list[str]] = defaultdict(list)
    for s in sorted(units):
        groups[find(s)].append(s)
    return [sorted(v) for v in groups.values()]


def assign_splits(units: dict[str, dict], fractions=DEFAULT_FRACTIONS) -> tuple[dict[str, str], dict]:
    """{scan_id: split} plus a report. `units[scan]` needs: n, start_ts, window_end_ts, clusters, episodes."""
    if abs(sum(fractions) - 1) > 1e-9 or any(f <= 0 for f in fractions):
        raise SnapshotError("SPLIT_FRACTIONS_MUST_BE_POSITIVE_AND_SUM_TO_ONE")
    comps = _components(units)
    comp_info = [{"scans": c, "start": min(units[s]["start_ts"] for s in c), "end": max(units[s]["window_end_ts"] for s in c),
                  "n": sum(units[s]["n"] for s in c)} for c in comps]
    comp_info.sort(key=lambda c: (c["start"], c["scans"][0]))
    total = sum(c["n"] for c in comp_info)
    cuts = (fractions[0] * total, (fractions[0] + fractions[1]) * total)
    seen, assigned = 0, []
    for c in comp_info:   # a component goes wholly to the split its FIRST row falls in
        split = SPLITS[0] if seen < cuts[0] else SPLITS[1] if seen < cuts[1] else SPLITS[2]
        assigned.append((c, split))
        seen += c["n"]
    starts = {sp: min((c["start"] for c, s in assigned if s == sp), default=None) for sp in SPLITS}
    out: dict[str, str] = {}
    purged = Counter()
    for c, split in assigned:
        nxt = SPLITS[SPLITS.index(split) + 1:] if split != SPLITS[-1] else ()
        boundary = min((starts[s] for s in nxt if starts[s] is not None), default=None)
        if boundary is not None and c["end"] >= boundary:
            purged[split] += c["n"]
            continue
        for s in c["scans"]:
            out[s] = split
    report = {"fractions": list(fractions), "component_count": len(comp_info), "purged_rows": dict(purged),
              "split_start_ts": starts, "rule": "chronological by component start; components never split; rows whose outcome window reaches the next split are purged"}
    return out, report


SNAP_SCHEMA = """
CREATE TABLE snapshot_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE snapshot_rows (
    observation_id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, cluster_id TEXT NOT NULL, episode_id TEXT NOT NULL, split TEXT NOT NULL,
    decision_ts INTEGER NOT NULL, window_end_ts INTEGER NOT NULL, asset TEXT NOT NULL, strategy TEXT, direction TEXT,
    features TEXT NOT NULL, quant_score REAL, regime TEXT, target REAL NOT NULL
);
CREATE INDEX snapshot_rows_split ON snapshot_rows (split, decision_ts);
"""


def build_snapshot(shadow_db_path: str, out_dir: str, *, date: str, as_of_ms: Optional[int] = None, source_commit: Optional[str] = None,
                   feature_paths: Optional[list[str]] = None, target: str = "policy_r", horizon: str = "72h",
                   fractions=DEFAULT_FRACTIONS, generated_at_ms: Optional[int] = None) -> dict:
    if not os.path.isfile(shadow_db_path):
        raise SnapshotError("SOURCE_NOT_FOUND")
    if not (len(date) == 8 and date.isdigit()):
        raise SnapshotError("DATE_MUST_BE_YYYYMMDD")
    if horizon not in C.HORIZONS:
        raise SnapshotError("UNKNOWN_HORIZON")
    ro = _ReadOnlyShadow(shadow_db_path)
    with closing(ro._connect()) as conn:
        schema_version = (conn.execute("SELECT value FROM shadow_meta WHERE key='schema_version'").fetchone() or [None])[0]
        newest = conn.execute("SELECT MAX(created_at_ms) FROM shadow_observations").fetchone()[0]
    as_of_ms = as_of_ms if as_of_ms is not None else (newest or 0)

    verdicts = {v["subject_id"]: v for v in quality_runner.compute(ro, None, as_of_ms) if v["subject_kind"] == quality_runner.SHADOW_OBSERVATION}
    excluded: Counter = Counter()
    kept: list[dict] = []
    with closing(ro._connect()) as conn:
        rows = conn.execute("SELECT o.*, l.labels AS label_blob, l.window_end_ts AS label_window_end FROM shadow_observations o "
                            "LEFT JOIN shadow_labels l ON l.observation_id = o.observation_id AND l.batch = ? ORDER BY o.observation_id", (C.FINAL_BATCH,)).fetchall()
    for r in rows:
        if r["kind"] != C.KIND_CANDIDATE:
            excluded["NOT_A_CANDIDATE"] += 1
        elif not r["research_candidate_valid"]:
            excluded["NOT_RESEARCH_VALID"] += 1
        elif verdicts.get(r["observation_id"], {}).get("verdict") != K.VALID:
            excluded["DATA_QUALITY_" + str(verdicts.get(r["observation_id"], {}).get("verdict", "NO_VERDICT"))] += 1
        elif r["label_blob"] is None:
            excluded["REQUIRED_OUTCOME_UNRESOLVED"] += 1
        else:
            label = (_unblob(r["label_blob"]).get(horizon) or {})
            y = label.get(target)
            if label.get("label_status") != "OK" or not isinstance(y, (int, float)) or isinstance(y, bool):
                excluded["REQUIRED_OUTCOME_UNRESOLVED"] += 1
            else:
                kept.append({"row": r, "y": float(y), "decision": _unblob(r["decision"])})

    paths = list(feature_paths) if feature_paths else discover_feature_paths([k["decision"] for k in kept])
    C.assert_decision_features(paths)   # the guard, unchanged: a hindsight name raises before anything is written

    units: dict[str, dict] = {}
    for k in kept:
        r = k["row"]
        u = units.setdefault(r["scan_id"], {"n": 0, "start_ts": r["decision_ts"], "window_end_ts": 0, "clusters": set(), "episodes": set()})
        u["n"] += 1
        u["start_ts"] = min(u["start_ts"], r["decision_ts"])
        u["window_end_ts"] = max(u["window_end_ts"], r["label_window_end"])
        u["clusters"].add(r["observation_cluster_id"])
        u["episodes"].add(r["market_episode_id"])
    split_of, split_report = assign_splits(units, fractions) if units else ({}, {"fractions": list(fractions), "component_count": 0, "purged_rows": {}, "split_start_ts": {}})
    out_rows = []
    for k in kept:
        r = k["row"]
        if r["scan_id"] not in split_of:
            excluded["PURGED_LABEL_WINDOW_OVERLAPS_NEXT_SPLIT"] += 1
            continue
        out_rows.append({"observation_id": r["observation_id"], "scan_id": r["scan_id"], "cluster_id": r["observation_cluster_id"], "episode_id": r["market_episode_id"],
                         "split": split_of[r["scan_id"]], "decision_ts": r["decision_ts"], "window_end_ts": r["label_window_end"], "asset": r["asset"],
                         "strategy": r["strategy"], "direction": r["direction"], "features": {p: _get(k["decision"], p) for p in paths}, "quant_score": _quant_score(k["decision"]), "regime": _regime(k["decision"]), "target": k["y"]})
    out_rows.sort(key=lambda x: (x["decision_ts"], x["observation_id"]))
    if not out_rows:
        raise SnapshotError("NO_VALID_RESOLVED_ROWS: nothing to freeze yet (" + json.dumps(dict(excluded), sort_keys=True) + ")")

    content_hash = hashlib.sha256(_canon({"paths": paths, "target": f"{horizon}.{target}", "rows": out_rows}).encode()).hexdigest()
    version = f"{BASE_DATASET}-SNAPSHOT-{date}"
    folder = os.path.join(out_dir, version)
    manifest_path = os.path.join(folder, "manifest.json")
    if os.path.exists(manifest_path):
        existing = json.load(open(manifest_path))
        if existing.get("content_hash") == content_hash:
            return {**existing, "status": "UNCHANGED_ALREADY_PUBLISHED"}
        raise SnapshotError(f"SNAPSHOT_EXISTS: {version} is immutable; build a new dated snapshot instead")
    os.makedirs(folder)
    snap_path = os.path.join(folder, "snapshot.sqlite3")
    with closing(sqlite3.connect(snap_path)) as conn:
        conn.executescript(SNAP_SCHEMA)
        conn.executemany("INSERT INTO snapshot_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            (x["observation_id"], x["scan_id"], x["cluster_id"], x["episode_id"], x["split"], x["decision_ts"], x["window_end_ts"], x["asset"],
             x["strategy"], x["direction"], _canon(x["features"]), x["quant_score"], x["regime"], x["target"]) for x in out_rows])
        conn.executemany("INSERT INTO snapshot_meta VALUES (?,?)", [("version", version), ("content_hash", content_hash), ("target", f"{horizon}.{target}")])
        for op in ("UPDATE", "DELETE"):
            for table in ("snapshot_rows", "snapshot_meta"):
                conn.execute(f"CREATE TRIGGER {table}_no_{op.lower()} BEFORE {op} ON {table} BEGIN SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE'); END;")
        conn.commit()
    by_split = {sp: [x for x in out_rows if x["split"] == sp] for sp in SPLITS}
    manifest = {
        "manifest_schema": "forward-snapshot/v1", "builder_version": BUILDER_VERSION, "version": version, "base_dataset": BASE_DATASET,
        "status": "PUBLISHED", "content_hash": content_hash, "snapshot_file": "snapshot.sqlite3", "snapshot_file_sha256": _sha256_file(snap_path),
        "source": {"shadow_db_sha256": _sha256_file(shadow_db_path), "shadow_schema_version": schema_version, "source_commit": source_commit,
                   "as_of_ms": as_of_ms, "quality_checker_version": quality_runner.CHECKER_VERSION},
        "target": {"name": f"{horizon}.{target}", "label_batch": C.FINAL_BATCH, "required_label_status": "OK"},
        "feature_paths": paths, "feature_guard": "assert_decision_features passed (no hindsight names)",
        "counts": {"rows": len(out_rows), "scans": len({x["scan_id"] for x in out_rows}), "clusters": len({x["cluster_id"] for x in out_rows}),
                   "episodes": len({x["episode_id"] for x in out_rows}), "assets": dict(sorted(Counter(x["asset"] for x in out_rows).items())),
                   "strategies": dict(sorted(Counter(str(x["strategy"]) for x in out_rows).items())), "by_split": {sp: len(v) for sp, v in by_split.items()},
                   "scans_by_split": {sp: len({x["scan_id"] for x in v}) for sp, v in by_split.items()}},
        "excluded": dict(sorted(excluded.items())), "splits": {**split_report,
            "ranges": {sp: ([min(x["decision_ts"] for x in v), max(x["decision_ts"] for x in v)] if v else None) for sp, v in by_split.items()}},
        "generated_at_ms": generated_at_ms,
        "registry_entry": {"status": "SNAPSHOT_PUBLISHED", "trainable": True, "developmentOnly": False, "derivedFrom": BASE_DATASET,
                           "reason": "Frozen, hashed, versioned snapshot of VALID resolved forward shadow rows. Immutable; superseded, never edited. Train only against this, never the live database. Splits are chronological; correlated rows and a scan's candidates never cross splits.",
                           "evidence": f"manifest.json in {version}; content_hash {content_hash}"},
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
        f.write("\n")
    for p in (snap_path, manifest_path):
        os.chmod(p, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    return manifest


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    import time
    ap = argparse.ArgumentParser(description="Freeze the shadow database into a versioned training snapshot (read-only on the source).")
    ap.add_argument("--shadow-db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--date", default=time.strftime("%Y%m%d", time.gmtime()))
    ap.add_argument("--source-commit")
    ap.add_argument("--target", default="policy_r")
    ap.add_argument("--horizon", default="72h")
    a = ap.parse_args(argv)
    try:
        m = build_snapshot(a.shadow_db, a.out, date=a.date, source_commit=a.source_commit, target=a.target, horizon=a.horizon, generated_at_ms=int(time.time() * 1000))
    except SnapshotError as e:
        print(f"REFUSED: {e}")
        return 2
    print(json.dumps({k: m[k] for k in ("version", "status", "content_hash", "counts", "excluded")}, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
