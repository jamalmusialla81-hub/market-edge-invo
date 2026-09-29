"""DATA 3 (#53): frozen, versioned, deterministic training snapshots."""
import json
import os
import sqlite3
from contextlib import closing

import pytest

from market_edge_exec.datasets import builder as B
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore
from tests.test_shadow import BAR, T0, bars_path, candidate, decision, scan_payload

DAY = 24 * C.HOUR
SPACING = 4 * DAY          # far enough apart that scans do not share a cluster
AS_OF = T0 + 120 * DAY


def make_source(tmp_path, n_scans=10, extra_same_cluster=True, unresolved_tail=False):
    """A shadow DB of BTC candidate scans, each with a long, later-resolved candle path."""
    store = ShadowStore(str(tmp_path / "shadow.sqlite3"))
    stamps = [T0 + i * SPACING for i in range(n_scans)]
    for i, ts in enumerate(stamps):
        obs = [{"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate(strategy="TREND CONTINUATION", rank=1))}]
        if i % 2 == 0:
            obs.append({"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate(direction="short", strategy="MEAN REVERSION", stop=102.0, tp1=98.0, tp2=96.0, rank=2, pick=False, scan_rank=2))})
        store.record_scan(scan_payload(scan_id=f"scan-{i}", ts=ts, observations=obs), now_ms=ts + 60_000)
    if extra_same_cluster:   # a second scan five minutes after scan-0: same cluster, so it must stay with scan-0
        store.record_scan(scan_payload(scan_id="scan-0b", ts=T0 + BAR, observations=[{"kind": "CANDIDATE", "asset": "BTC", "decision": decision(cand=candidate())}]), now_ms=T0 + BAR + 60_000)
    last = stamps[-1] + (0 if unresolved_tail else C.FULL_WINDOW_MS + 3 * C.HOUR)
    first = T0 - T0 % BAR
    n = (last - first) // BAR + 2
    closes = [100 + 4 * __import__("math").sin(i / 400) for i in range(n)]
    store.resolve("BTC", bars_path(first, closes, spread=0.05), "HYPERLIQUID", "5m", now_ms=last + C.HOUR)
    return store


def build(store, out, **kw):
    return B.build_snapshot(store.path, str(out), date="20261001", as_of_ms=AS_OF, source_commit="abc123", generated_at_ms=1, **kw)


def rows_of(folder):
    with closing(sqlite3.connect(os.path.join(folder, "snapshot.sqlite3"))) as c:
        c.row_factory = sqlite3.Row
        return [dict(r) for r in c.execute("SELECT * FROM snapshot_rows ORDER BY decision_ts, observation_id")]


def test_a_snapshot_is_built_with_a_matching_manifest(tmp_path):
    m = build(make_source(tmp_path), tmp_path / "out")
    folder = tmp_path / "out" / m["version"]
    rows = rows_of(folder)
    assert m["version"] == "FORWARD-SHADOW-RESOLVED-V1-SNAPSHOT-20261001" and m["status"] == "PUBLISHED"
    assert m["counts"]["rows"] == len(rows) > 0
    assert sum(m["counts"]["by_split"].values()) == len(rows)
    assert m["counts"]["scans"] == len({r["scan_id"] for r in rows}) and m["counts"]["clusters"] == len({r["cluster_id"] for r in rows})
    assert m["counts"]["assets"] == {"BTC": len(rows)}
    assert m["source"]["source_commit"] == "abc123" and m["source"]["shadow_schema_version"] == str(C.SHADOW_SCHEMA_VERSION)
    assert len(m["source"]["shadow_db_sha256"]) == 64 and len(m["content_hash"]) == 64
    assert m["registry_entry"]["status"] == "SNAPSHOT_PUBLISHED" and m["target"]["name"] == "72h.policy_r"
    assert json.load(open(folder / "manifest.json"))["content_hash"] == m["content_hash"]


def test_invalid_and_unresolved_rows_are_excluded_and_counted(tmp_path):
    store = make_source(tmp_path, unresolved_tail=True)
    with closing(sqlite3.connect(store.path)) as c:   # a damaged row, inserted (the triggers only forbid UPDATE/DELETE)
        c.execute("INSERT INTO shadow_observations SELECT 'bad-1', scan_id, kind, asset, coin, direction, strategy, decision_ts, first_bar_ts, production_rank, scan_candidate_rank, "
                  "is_production_pick, production_state, execution_status, execution_rejection_reason, research_candidate_valid, invalid_reason, observation_cluster_id, "
                  "market_episode_id, overlap_fraction, generator_version, '', model_version, dataset_version, outcome_venue, outcome_interval, decision, decision_hash, created_at_ms, "
                  "source_commit FROM shadow_observations LIMIT 1")
        c.commit()
    m = build(store, tmp_path / "out")
    assert m["excluded"].get("REQUIRED_OUTCOME_UNRESOLVED", 0) > 0 or m["excluded"].get("DATA_QUALITY_UNRESOLVED", 0) > 0
    assert any(k.startswith("DATA_QUALITY_INVALID") for k in m["excluded"]), m["excluded"]
    ids = {r["observation_id"] for r in rows_of(tmp_path / "out" / m["version"])}
    assert "bad-1" not in ids
    assert m["counts"]["rows"] == len(ids)


def test_correlated_scans_and_a_scans_candidates_never_split_across_splits(tmp_path):
    m = build(make_source(tmp_path), tmp_path / "out")
    rows = rows_of(tmp_path / "out" / m["version"])
    split_of_scan, split_of_cluster, split_of_episode = {}, {}, {}
    for r in rows:
        for table, key in ((split_of_scan, "scan_id"), (split_of_cluster, "cluster_id"), (split_of_episode, "episode_id")):
            assert table.setdefault(r[key], r["split"]) == r["split"], f"{key}={r[key]} crosses splits"
    assert split_of_scan.get("scan-0") == split_of_scan.get("scan-0b"), "same-cluster scans must stay together"


def test_splits_are_chronological_and_label_windows_do_not_reach_the_next_split(tmp_path):
    m = build(make_source(tmp_path), tmp_path / "out")
    rows = rows_of(tmp_path / "out" / m["version"])
    by = {sp: [r for r in rows if r["split"] == sp] for sp in B.SPLITS}
    assert all(by[sp] for sp in B.SPLITS), {sp: len(v) for sp, v in by.items()}
    assert max(r["decision_ts"] for r in by["TRAIN"]) < min(r["decision_ts"] for r in by["VALIDATION"]) <= max(r["decision_ts"] for r in by["VALIDATION"]) < min(r["decision_ts"] for r in by["OOS"])
    assert max(r["window_end_ts"] for r in by["TRAIN"]) < min(r["decision_ts"] for r in by["VALIDATION"])
    assert max(r["window_end_ts"] for r in by["VALIDATION"]) < min(r["decision_ts"] for r in by["OOS"])


def test_building_twice_from_unchanged_input_gives_the_same_hash(tmp_path):
    store = make_source(tmp_path)
    a = build(store, tmp_path / "out1")
    b = build(store, tmp_path / "out2")
    assert a["content_hash"] == b["content_hash"] and a["snapshot_file_sha256"] == b["snapshot_file_sha256"]
    assert {k: v for k, v in a.items() if k != "generated_at_ms"} == {k: v for k, v in b.items() if k != "generated_at_ms"}


def test_a_published_snapshot_is_immutable_and_never_overwritten(tmp_path):
    store = make_source(tmp_path)
    m = build(store, tmp_path / "out")
    assert build(store, tmp_path / "out")["status"] == "UNCHANGED_ALREADY_PUBLISHED"
    folder = tmp_path / "out" / m["version"]
    with closing(sqlite3.connect(folder / "snapshot.sqlite3")) as c:
        for sql in ("UPDATE snapshot_rows SET target=0", "DELETE FROM snapshot_rows", "UPDATE snapshot_meta SET value='x'"):
            with pytest.raises(sqlite3.DatabaseError, match="SNAPSHOT_IMMUTABLE"):
                c.execute(sql)
    assert not os.access(folder / "manifest.json", os.W_OK) or os.geteuid() == 0
    with pytest.raises(B.SnapshotError, match="SNAPSHOT_EXISTS"):
        build(store, tmp_path / "out", feature_paths=["features.h1.rsi"])   # different content, same version name: refused, not edited


def test_the_source_database_is_not_modified(tmp_path):
    store = make_source(tmp_path)
    before = open(store.path, "rb").read()
    build(store, tmp_path / "out")
    assert open(store.path, "rb").read() == before


def test_hindsight_feature_names_are_refused_before_anything_is_written(tmp_path):
    store = make_source(tmp_path)
    with pytest.raises(ValueError, match="HINDSIGHT_FIELD_AS_FEATURE"):
        build(store, tmp_path / "out", feature_paths=["features.h1.rsi", "mfe"])
    assert not (tmp_path / "out").exists()


def test_discovered_features_are_decision_time_only_and_missing_values_stay_null(tmp_path):
    m = build(make_source(tmp_path), tmp_path / "out")
    assert m["feature_paths"] and all(p.split(".")[0] in B.FEATURE_ROOTS for p in m["feature_paths"])
    C.assert_decision_features(m["feature_paths"])
    rows = rows_of(tmp_path / "out" / m["version"])
    assert all(set(json.loads(r["features"])) == set(m["feature_paths"]) for r in rows)


def test_nothing_to_freeze_is_refused_not_faked(tmp_path):
    store = ShadowStore(str(tmp_path / "empty.sqlite3"))
    with pytest.raises(B.SnapshotError, match="NO_VALID_RESOLVED_ROWS"):
        B.build_snapshot(store.path, str(tmp_path / "out"), date="20261001", as_of_ms=AS_OF)


def test_split_assignment_unit():
    units = {f"s{i}": {"n": 1, "start_ts": i * 100, "window_end_ts": i * 100 + 10, "clusters": {f"c{i}"}, "episodes": {f"e{i}"}} for i in range(10)}
    units["s3"]["clusters"].add("shared"); units["s4"]["clusters"].add("shared")
    out, report = B.assign_splits(units)
    assert out["s3"] == out["s4"]
    assert [out[f"s{i}"] for i in (0, 1, 2)] == ["TRAIN"] * 3 and out["s9"] == "OOS"
    with pytest.raises(B.SnapshotError):
        B.assign_splits(units, (0.5, 0.5, 0.5))
