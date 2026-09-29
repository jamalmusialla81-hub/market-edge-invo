"""DATA 6 (#56): trigger discipline, simple challengers, every run logged."""
import json
import os
import random
import sqlite3
from contextlib import closing

import pytest

from market_edge_exec.datasets import builder as B
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.shadow.store import ShadowStore
from market_edge_exec.training import challengers as CH, run as RUN, trigger as T
from tests.test_snapshot_builder import AS_OF, make_source

POLICY = T.TriggerPolicy(min_new_episodes=5, min_new_choice_scans=5, min_new_cluster_fraction=0.25)


def stats(clusters, choice=(), version="v", digest="h", trained=None):
    ids = frozenset(clusters)
    return T.Stats(version, digest, episodes=ids, clusters=ids, scans=ids | frozenset(choice), choice_scans=frozenset(choice), trained_at_ms=trained)


# ---- trigger: pure --------------------------------------------------------------
def test_below_every_threshold_does_not_fire():
    d = T.decide(POLICY, stats({f"c{i}" for i in range(4)}), None, now_ms=1)
    assert d["fire"] is False and d["reasons"] == [] and d["new_episodes"] == 4


def test_enough_new_episodes_fires():
    d = T.decide(POLICY, stats({f"c{i}" for i in range(5)}), None, 1)
    assert d["fire"] and d["reasons"] == ["MIN_NEW_EPISODES"]


def test_enough_new_choice_scans_fires_even_with_few_new_episodes():
    last = stats({f"c{i}" for i in range(50)}, digest="old")
    cur = T.Stats("v2", "new", episodes=last.episodes, clusters=last.clusters | {"x1", "x2", "x3", "x4"}, scans=frozenset(), choice_scans=frozenset(f"s{i}" for i in range(5)))
    d = T.decide(T.TriggerPolicy(5, 5, min_new_cluster_fraction=0.05), cur, last, 1)
    assert d["fire"] and "MIN_NEW_CHOICE_SCANS" in d["reasons"] and "MIN_NEW_EPISODES" not in d["reasons"]


def test_scheduled_window_fires_only_after_it_elapses():
    pol = T.TriggerPolicy(5, 5, schedule_days=7, min_new_cluster_fraction=0.25)
    last = stats({f"c{i}" for i in range(20)}, digest="old", trained=0)
    cur = T.Stats("v2", "new", episodes=last.episodes, clusters=last.clusters | {f"n{i}" for i in range(20)}, scans=frozenset(), choice_scans=frozenset())
    assert T.decide(pol, cur, last, now_ms=6 * T.DAY_MS)["fire"] is False
    d = T.decide(pol, cur, last, now_ms=7 * T.DAY_MS)
    assert d["fire"] and d["reasons"] == ["SCHEDULED_WINDOW_ELAPSED"]


def test_near_identical_composition_does_not_retrain_even_with_enough_raw_rows():
    last = stats({f"c{i}" for i in range(100)}, digest="old")
    cur = stats({f"c{i}" for i in range(105)}, digest="new")      # 5 new episodes meets the minimum, but only ~5% of clusters are new
    d = T.decide(POLICY, cur, last, 1)
    assert d["fire"] is False and d["wanted_but_blocked"] == ["MIN_NEW_EPISODES"] and d["blocked_by"][0].startswith("NEAR_IDENTICAL_COMPOSITION")


def test_the_same_snapshot_never_fires_twice():
    s = stats({f"c{i}" for i in range(50)}, digest="same")
    d = T.decide(POLICY, s, s, 1)
    assert d["fire"] is False and d["blocked_by"] == ["SAME_SNAPSHOT_AS_LAST_TRAINED"]


def test_no_policy_can_be_satisfied_by_a_single_trade():
    for bad in (dict(min_new_episodes=1), dict(min_new_choice_scans=1), dict(min_new_episodes=0), dict(min_new_cluster_fraction=0.0)):
        with pytest.raises(T.PolicyError):
            T.TriggerPolicy(**bad)
    assert T.decide(T.TriggerPolicy(), stats({"one"}), None, 1)["fire"] is False


# ---- challengers -----------------------------------------------------------------
@pytest.fixture(scope="module")
def snapshot(tmp_path_factory):
    root = tmp_path_factory.mktemp("snap")
    store = make_source(root, n_scans=14)
    m = B.build_snapshot(store.path, str(root / "out"), date="20261001", as_of_ms=AS_OF, source_commit="abc", generated_at_ms=1)
    return str(root / "out" / m["version"])


def test_the_family_trains_on_the_train_split_only_and_is_deterministic(snapshot):
    snap = CH.load_snapshot(snapshot)
    a, b = CH.train_family(snap, 7), CH.train_family(snap, 7)
    assert {n: m["artifact_hash"] for n, m in a["models"].items()} == {n: m["artifact_hash"] for n, m in b["models"].items()}
    assert set(a["models"]) == {"random_baseline", "quant_baseline", "ridge", "gbm_stumps"}
    assert a["validation_rows_untouched"] > 0 and a["oos_rows_untouched"] > 0
    # Changing VALIDATION / OOS targets must not change anything that was fitted.
    for row in snap["rows"]:
        if row["split"] != "TRAIN":
            row["target"] = 999.0
    c = CH.train_family(snap, 7)
    assert {n: m["artifact_hash"] for n, m in c["models"].items()} == {n: m["artifact_hash"] for n, m in a["models"].items()}


def test_ridge_and_stumps_recover_a_planted_signal():
    rng = random.Random(1)
    rows = []
    for i in range(200):
        x1, x2 = rng.gauss(0, 1), rng.gauss(0, 1)
        rows.append({"features": json.dumps({"f.a": x1, "f.b": x2, "f.c": 1.0}), "quant_score": None, "target": 2.0 * x1 + rng.gauss(0, 0.1), "split": "TRAIN"})
    paths = ["f.a", "f.b", "f.c"]
    ridge = CH.Ridge(alpha=1.0).fit(rows, paths)
    coef = ridge.artifact()["coefficients"]
    assert coef["f.a"] > 1.5 and abs(coef["f.b"]) < 0.2 and "f.c" not in coef    # the constant column is dropped
    stumps = CH.BoostedStumps().fit(rows, paths)
    pred = stumps.predict(rows)
    corr = sum((p - sum(pred) / 200) * (r["target"] - sum(x["target"] for x in rows) / 200) for p, r in zip(pred, rows))
    assert corr > 0 and {s[0] for s in stumps.stumps} >= {"f.a"}


def test_a_tampered_snapshot_is_refused(snapshot, tmp_path):
    import shutil
    copy = str(tmp_path / "copy")
    shutil.copytree(snapshot, copy)
    os.chmod(os.path.join(copy, "snapshot.sqlite3"), 0o644)
    with closing(sqlite3.connect(os.path.join(copy, "snapshot.sqlite3"))) as c:
        c.execute("DROP TRIGGER snapshot_rows_no_update")
        c.execute("UPDATE snapshot_rows SET target = target + 1")
        c.commit()
    with pytest.raises(CH.TrainingError, match="SNAPSHOT_HASH_MISMATCH"):
        CH.load_snapshot(copy)


def test_no_neural_net_code_in_the_training_package():
    import pathlib
    text = "".join(p.read_text() for p in pathlib.Path(CH.__file__).parent.glob("*.py")).lower()
    for banned in ("torch", "tensorflow", "keras", "neural", "lstm", "transformer"):
        assert banned not in text.replace("no neural nets", "").replace("no neural-net", "")


# ---- the cycle ---------------------------------------------------------------------
def test_a_cycle_fires_once_then_refuses_the_same_snapshot_and_logs_both(snapshot, tmp_path):
    shadow = ShadowStore(str(tmp_path / "reg.sqlite3"))
    reg = ExperimentRegistry(shadow)
    first = RUN.run_cycle(reg, snapshot, str(tmp_path / "art"), POLICY, now_ms=1_000, source_commit="abc")
    assert first["ran"] and first["status"] == "NO_EVIDENCE" and first["results"]["evaluated"] is False
    assert os.path.isfile(os.path.join(first["results"]["artifact_dir"], "ridge.json"))
    second = RUN.run_cycle(reg, snapshot, str(tmp_path / "art"), POLICY, now_ms=2_000, source_commit="abc")
    assert second["ran"] is False and second["decision"]["blocked_by"] == ["SAME_SNAPSHOT_AS_LAST_TRAINED"]
    listed = reg.list()
    assert sorted((r["model_type"] == RUN.CHECK_TYPE, r["status"]) for r in listed) == [(False, "NO_EVIDENCE"), (True, "SUPERSEDED")]
    check = reg.history(second["check_id"])
    assert check["last_status_event"]["note"].startswith("NOT_RUN: SAME_SNAPSHOT")
    assert len([r for r in listed if r["model_type"] != RUN.CHECK_TYPE]) == 1     # exactly one training run happened


def test_a_run_never_reaches_promising_or_a_shadow_candidate_on_its_own(snapshot, tmp_path):
    reg = ExperimentRegistry(ShadowStore(str(tmp_path / "reg.sqlite3")))
    out = RUN.run_cycle(reg, snapshot, str(tmp_path / "art"), POLICY, now_ms=1)
    assert out["status"] == "NO_EVIDENCE"
    assert reg.history(out["experiment_id"])["config"]["baseline"] == "QUANT_BASELINE"


def test_a_failing_run_is_logged_as_failed(snapshot, tmp_path, monkeypatch):
    reg = ExperimentRegistry(ShadowStore(str(tmp_path / "reg.sqlite3")))
    monkeypatch.setattr(RUN.CH, "train_family", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    out = RUN.run_cycle(reg, snapshot, str(tmp_path / "art"), POLICY, now_ms=1)
    assert out["status"] == "FAILED" and reg.history(out["experiment_id"])["status"] == "FAILED"


def test_the_live_database_is_never_an_input(tmp_path):
    with pytest.raises(FileNotFoundError):
        RUN.run_cycle(ExperimentRegistry(ShadowStore(str(tmp_path / "reg.sqlite3"))), str(tmp_path / "shadow-live"), str(tmp_path / "a"), POLICY, 1)
