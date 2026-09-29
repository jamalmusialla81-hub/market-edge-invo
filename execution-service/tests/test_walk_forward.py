"""DATA 7 (#57): chronological, scan-grouped, cluster-aware walk-forward evaluation."""
import json
import random

import pytest

from market_edge_exec.evaluation import walkforward as W
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.shadow.store import ShadowStore

HOUR = 3_600_000
DAY = 24 * HOUR
T0 = 1_800_000_000_000


def synthetic(n_scans=240, signal=lambda i, x: 1.0 * x, seed=3, cands=3, oos_scans=20, shared_cluster_every=0):
    """Chronological scans, `cands` candidates each, one feature `features.f` that drives the label via `signal`."""
    rng = random.Random(seed)
    rows = []
    for i in range(n_scans):
        ts = T0 + i * DAY
        for k in range(cands):
            x = rng.gauss(0, 1)
            cluster = f"c{i}" if not (shared_cluster_every and i % shared_cluster_every == 1) else f"c{i - 1}"
            rows.append({"observation_id": f"o{i:04d}-{k}", "scan_id": f"s{i:04d}", "cluster_id": cluster, "episode_id": cluster, "split": "TRAIN",
                         "decision_ts": ts + k, "window_end_ts": ts + 3 * DAY, "asset": ["BTC", "ETH"][k % 2], "strategy": "TREND", "direction": "long",
                         "features": json.dumps({"features.f": x, "features.g": rng.gauss(0, 1)}), "quant_score": rng.gauss(60, 5), "regime": "UP",
                         "target": signal(i, x) + rng.gauss(0, 0.5)})
    for r in rows[len(rows) - oos_scans * cands:]:
        r["split"] = "OOS"
    return {"manifest": {"version": "FORWARD-SHADOW-RESOLVED-V1-SNAPSHOT-20261001", "content_hash": "a" * 64}, "paths": ["features.f", "features.g"], "rows": rows}


def rows_of(snap, split=("TRAIN", "VALIDATION")):
    return [r for r in snap["rows"] if r["split"] in split]


def test_folds_are_chronological_with_no_lookahead():
    snap = synthetic()
    res = W.evaluate_walk_forward(snap, bootstrap_n=50)
    ran = [f for f in res["folds"] if "skipped" not in f]
    assert len(ran) == 4
    for f in ran:
        assert f["train_max_window_end_ts"] < f["test_min_decision_ts"], "a training label window reaches into the test fold"
    starts = [f["test_start_ts"] for f in ran]
    assert starts == sorted(starts)
    assert [f["train_rows"] for f in ran] == sorted(f["train_rows"] for f in ran), "training grows (expanding window), never shrinks"


def test_a_scan_is_never_split_across_folds_and_correlated_scans_stay_together():
    snap = synthetic(shared_cluster_every=5)
    folds = W.make_folds(rows_of(snap), 4)
    seen = {}
    for f in folds:
        for s in f["test_scans"]:
            assert s not in seen, f"{s} is a test scan in two folds"
            seen[s] = f["index"]
        assert not set(f["train_scans"]) & set(f["test_scans"])
    rows = {r["scan_id"]: r for r in snap["rows"]}
    by_cluster = {}
    for r in rows_of(snap):
        by_cluster.setdefault(r["cluster_id"], set()).add(seen.get(r["scan_id"], "train-only"))
    assert all(len(v) == 1 for v in by_cluster.values()), "a cluster straddles folds"
    for f in folds:   # a test scan's cluster-mates are never in the training set
        train_clusters = {r["cluster_id"] for r in rows_of(snap) if r["scan_id"] in set(f["train_scans"])}
        test_clusters = {r["cluster_id"] for r in rows_of(snap) if r["scan_id"] in set(f["test_scans"])}
        assert not train_clusters & test_clusters


def test_one_very_favourable_fold_is_surfaced_not_averaged_away():
    d = W.stability([0.6, 0.0, -0.01, 0.0], 0.15)
    assert d["verdict"] == "UNSTABLE_ONE_FOLD_CARRIES" and d["carried_by_single_fold"] and d["best_fold"] == 0
    assert W.stability([0.2, 0.15, 0.1, 0.12], 0.14)["verdict"] == "STABLE_POSITIVE"
    assert W.stability([0.2, 0.1, -0.1, -0.1, 0.3], 0.08)["verdict"] == "MIXED"
    assert W.stability([0.5, 0.5], 0.5)["verdict"] == "INSUFFICIENT_FOLDS"
    # end to end: the signal exists only in the last quarter of the data
    snap = synthetic(signal=lambda i, x: 2.0 * x if i >= 150 else 0.0, n_scans=220)
    res = W.evaluate_walk_forward(snap, bootstrap_n=100)
    ridge = res["challengers"]["ridge"]
    assert len(ridge["vs"]["random"]["per_fold_delta_R"]) == 4
    assert ridge["vs"]["random"]["stability"]["verdict"] != "STABLE_POSITIVE"
    assert ridge["evidence"] == "NO_EVIDENCE"


def test_real_signal_is_stable_across_folds_and_beats_quant_and_random_with_cluster_ci():
    res = W.evaluate_walk_forward(synthetic(), bootstrap_n=300)
    for name in ("ridge", "gbm_stumps"):
        e = res["challengers"][name]
        for comp in ("quant", "random"):
            assert e["vs"][comp]["stability"]["verdict"] == "STABLE_POSITIVE", (name, comp, e["vs"][comp]["per_fold_delta_R"])
            assert e["vs"][comp]["ci95"][0] > 0
        assert e["evidence"] == "PROMISING_PENDING_PLACEBO_GATE"
    assert res["challengers"]["ridge"]["breakdown"]["asset"] and res["challengers"]["ridge"]["breakdown"]["regime"]
    assert all(f["rank"]["ridge"]["spearman_all_rows"] > 0.3 for f in res["folds"])


def test_pure_noise_shows_no_evidence():
    res = W.evaluate_walk_forward(synthetic(signal=lambda i, x: 0.0, seed=11), bootstrap_n=200)
    assert all(e["evidence"] == "NO_EVIDENCE" for e in res["challengers"].values())


def test_the_oos_split_is_never_touched():
    snap = synthetic()
    a = W.evaluate_walk_forward(snap, bootstrap_n=50)
    for r in snap["rows"]:
        if r["split"] == "OOS":
            r["target"] = 1e6
            r["features"] = json.dumps({"features.f": 1e6, "features.g": 1e6})
    b = W.evaluate_walk_forward(snap, bootstrap_n=50)
    assert a["result_hash"] == b["result_hash"] and a["oos_rows_untouched"] == 60


def test_deterministic_and_exposes_per_fold_structures_for_placebo_variants():
    snap = synthetic()
    assert W.evaluate_walk_forward(snap, bootstrap_n=50)["result_hash"] == W.evaluate_walk_forward(snap, bootstrap_n=50)["result_hash"]
    calls = []

    def shuffle_outcomes(train, fold):
        rng = random.Random(fold)
        ys = [r["target"] for r in train]
        rng.shuffle(ys)
        calls.append(fold)
        return [{**r, "target": y} for r, y in zip(train, ys)]

    res = W.evaluate_walk_forward(snap, row_transform=shuffle_outcomes, bootstrap_n=50)
    assert calls == [0, 1, 2, 3]
    assert res["challengers"]["ridge"]["evidence"] == "NO_EVIDENCE"       # breaking the outcomes removes the "edge"
    assert all("policies" in f for f in res["folds"])


def test_random_comparator_is_the_exact_scan_mean_and_quant_uses_the_quant_score():
    rows = [{"observation_id": f"o{k}", "scan_id": "s", "cluster_id": "c", "episode_id": "c", "split": "TRAIN", "decision_ts": 1, "window_end_ts": 2, "asset": "BTC",
             "strategy": "T", "direction": "long", "features": "{}", "quant_score": q, "regime": None, "target": t} for k, (q, t) in enumerate([(10, 1.0), (90, -1.0), (50, 3.0)])]
    fold = W.score_fold(rows, {"m": {"o0": 0.1, "o1": 0.2, "o2": 0.9}})
    assert fold["policies"]["random"]["mean_R"] == pytest.approx(1.0)
    assert fold["policies"]["quant"]["mean_R"] == -1.0
    assert fold["policies"]["m"]["mean_R"] == 3.0 and fold["policies"]["m"]["hit_best_share"] == 1.0


def test_result_is_logged_and_never_marked_shadow_candidate(tmp_path):
    reg = ExperimentRegistry(ShadowStore(str(tmp_path / "s.sqlite3")))
    res = W.evaluate_walk_forward(synthetic(), bootstrap_n=200)
    out = W.log_evaluation(reg, res, source_commit="abc", now_ms=5)
    assert out["status"] == "PROMISING"
    h = reg.history(out["experiment_id"])
    assert h["status"] == "PROMISING" and h["latest_results"]["result_hash"] == res["result_hash"]
    assert "Not promotable" in h["last_status_event"]["note"]
    noise = W.log_evaluation(reg, W.evaluate_walk_forward(synthetic(signal=lambda i, x: 0.0, seed=11), bootstrap_n=100), now_ms=6)
    assert noise["status"] == "NO_EVIDENCE"


def test_too_little_data_skips_folds_instead_of_faking_them():
    res = W.evaluate_walk_forward(synthetic(n_scans=8, oos_scans=1), bootstrap_n=20)
    assert any("skipped" in f for f in res["folds"]) or all(e["evidence"] == "NO_EVIDENCE" for e in res["challengers"].values())
