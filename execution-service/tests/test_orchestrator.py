"""DATA 17 (#68): the orchestrator sequences the pipeline and stops where a person must decide. One test per out-of-scope invariant."""
import ast
import copy
import hashlib
import json
import os
import pathlib
import sqlite3
import stat
from contextlib import closing

import pytest

from market_edge_exec.api.app import create_app
from market_edge_exec.datasets import builder as B
from market_edge_exec.evaluation import placebo as P, walkforward as W
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.lifecycle import policy as LP
from market_edge_exec.orchestrator import cycle as O
from market_edge_exec.shadow.store import ShadowStore
from market_edge_exec.shadow_models import deploy as D
from market_edge_exec.training import challengers as CH, trigger as T
from tests.test_walk_forward import synthetic
from tests.test_placebo_gate import noise_snapshot, signal_snapshot

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
NOW = 1_800_000_000_000
POLICY = T.TriggerPolicy(min_new_episodes=30, min_new_choice_scans=20)
HUMAN = {"authorized_by": "Jakob", "authorization_ref": "thread: deploy the passing challenger to shadow", "statement": "I authorize a SHADOW deployment only"}
RUNS = 19


def fake_builder(snap):
    """Writes `snap` (a synthetic snapshot dict) as a real frozen snapshot folder, exactly like the DATA 3 builder would."""
    def build(shadow_path, out_dir, *, date, as_of_ms=None, source_commit=None, generated_at_ms=None, **kw):
        rows = sorted(snap["rows"], key=lambda r: (r["decision_ts"], r["observation_id"]))
        out_rows = [{**{k: r[k] for k in ("observation_id", "scan_id", "cluster_id", "episode_id", "split", "decision_ts", "window_end_ts", "asset", "strategy", "direction")},
                     "features": json.loads(r["features"]), "quant_score": r["quant_score"], "regime": r["regime"], "target": r["target"]} for r in rows]
        content_hash = hashlib.sha256(B._canon({"paths": snap["paths"], "target": "72h.policy_r", "rows": out_rows}).encode()).hexdigest()
        version = f"{B.BASE_DATASET}-SNAPSHOT-{date}"
        folder = os.path.join(out_dir, version)
        if os.path.exists(os.path.join(folder, "manifest.json")):
            existing = json.load(open(os.path.join(folder, "manifest.json")))
            if existing["content_hash"] == content_hash:
                return {**existing, "status": "UNCHANGED_ALREADY_PUBLISHED"}
            raise B.SnapshotError(f"SNAPSHOT_EXISTS: {version}")
        os.makedirs(folder)
        with closing(sqlite3.connect(os.path.join(folder, "snapshot.sqlite3"))) as c:
            c.executescript(B.SNAP_SCHEMA)
            c.executemany("INSERT INTO snapshot_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
                (x["observation_id"], x["scan_id"], x["cluster_id"], x["episode_id"], x["split"], x["decision_ts"], x["window_end_ts"], x["asset"], x["strategy"], x["direction"],
                 B._canon(x["features"]), x["quant_score"], x["regime"], x["target"]) for x in out_rows])
            c.executemany("INSERT INTO snapshot_meta VALUES (?,?)", [("version", version), ("content_hash", content_hash), ("target", "72h.policy_r")])
            c.commit()
        manifest = {"version": version, "content_hash": content_hash, "status": "PUBLISHED", "feature_paths": snap["paths"], "target": {"name": "72h.policy_r"},
                    "counts": {"rows": len(out_rows), "scans": len({x["scan_id"] for x in out_rows}), "by_split": {}}}
        json.dump(manifest, open(os.path.join(folder, "manifest.json"), "w"))
        return manifest
    return build


@pytest.fixture()
def shadow(tmp_path):
    return ShadowStore(str(tmp_path / "shadow.sqlite3"))


def go(shadow, tmp_path, snap, **kw):
    kw.setdefault("policy", POLICY)
    return O.run_cycle(shadow, work_dir=str(tmp_path / "work"), now_ms=NOW, placebo_runs=RUNS, snapshot_builder=fake_builder(snap), **kw)


@pytest.fixture(scope="module")
def signal():
    return signal_snapshot()


def names(report):
    return [s["step"] for s in report["steps"]]


# ---- sequencing ---------------------------------------------------------------------------------------------------
def test_the_full_sequence_runs_in_order_and_stops_at_the_authorization_boundary(shadow, tmp_path, signal):
    r = go(shadow, tmp_path, signal)
    assert names(r) == ["TRIGGER_CHECK", "FREEZE_SNAPSHOT", "TRAIN", "WALK_FORWARD", "PLACEBO_GATE", "REPORT", "DEPLOY"], names(r)
    by = {s["step"]: s for s in r["steps"]}
    assert by["TRIGGER_CHECK"]["status"] == "FIRED" and by["TRAIN"]["status"] == "TRAINED" and by["PLACEBO_GATE"]["status"] == "PASSED"
    assert by["DEPLOY"]["status"] == "AWAITING_AUTHORIZATION" and r["deployed"] == [] and r["awaiting_authorization"]
    assert r["outcome"] == "PASSED_PLACEBO_GATE" and r["production_touched"] is False
    assert os.path.isfile(by["REPORT"]["path"])
    reg = ExperimentRegistry(shadow)
    kinds = {e["model_type"]: e["status"] for e in reg.list()}
    assert {"ORCHESTRATED_CYCLE", "WALK_FORWARD_EVALUATION", "PLACEBO_GATE"} <= set(kinds) and any(k.startswith("CHALLENGER_FAMILY") for k in kinds)
    assert reg.status_of(r["cycle_experiment_id"]) == "PROMISING"
    assert all(reg.status_of(e["experiment_id"]) != "SHADOW_CANDIDATE" for e in reg.list())
    assert D.active(shadow) == []


def test_a_rerun_on_unchanged_data_duplicates_nothing(shadow, tmp_path, signal):
    go(shadow, tmp_path, signal)
    reg = ExperimentRegistry(shadow)
    before = {e["experiment_id"] for e in reg.list() if e["model_type"] != "ORCHESTRATED_CYCLE"}
    r = go(shadow, tmp_path, signal)
    assert r["outcome"] == "NOT_TRIGGERED" and names(r) == ["TRIGGER_CHECK"] and "SAME_SNAPSHOT_AS_LAST_TRAINED" in r["reason"]
    assert {e["experiment_id"] for e in reg.list() if e["model_type"] != "ORCHESTRATED_CYCLE"} == before
    assert reg.status_of(r["cycle_experiment_id"]) == "SUPERSEDED"


def test_a_supplied_person_authorization_deploys_to_shadow_only(shadow, tmp_path, signal):
    r = go(shadow, tmp_path, signal, deploy_authorization=HUMAN)
    assert r["deployed"] and all(d["status"] == "DEPLOYED_SHADOW_OBSERVATION_ONLY" and d["authorization"]["authorized_by"] == "Jakob" for d in r["deployed"])
    assert {a["model_key"] for a in D.active(shadow)} == {d["model_key"] for d in r["deployed"]}
    assert [s["status"] for s in r["steps"] if s["step"] == "DEPLOY"] == ["DEPLOYED_SHADOW_ONLY"]


@pytest.mark.parametrize("bad", [{"authorized_by": "system", "authorization_ref": "x", "statement": "y"}, {"authorized_by": "Jakob"}, {}])
def test_an_invalid_or_automated_authorization_deploys_nothing(shadow, tmp_path, signal, bad):
    r = go(shadow, tmp_path, signal, deploy_authorization=bad)
    assert r["deployed"] == [] and D.active(shadow) == [] and r["outcome"] == "PASSED_AWAITING_VALID_AUTHORIZATION"
    assert r["steps"][-1] == {"step": "DEPLOY", "status": "REFUSED", "reason": r["steps"][-1]["reason"]}


# ---- stopping cleanly ----------------------------------------------------------------------------------------------------
def test_a_placebo_gate_failure_means_deployment_never_runs(shadow, tmp_path, monkeypatch):
    noise = noise_snapshot(5)
    real = W.evaluate_walk_forward

    def forced_promising(snap, **kw):          # pretend walk-forward was fooled by noise, so the REAL gate must catch it
        ev = real(snap, **kw)
        for e in ev["challengers"].values():
            e["evidence"] = "PROMISING_PENDING_PLACEBO_GATE"
        return ev
    monkeypatch.setattr(O.W, "evaluate_walk_forward", forced_promising)
    deploys = []
    monkeypatch.setattr(O.D, "deploy", lambda *a, **k: deploys.append(k) or {})
    r = go(shadow, tmp_path, noise, deploy_authorization=HUMAN)
    assert names(r)[-1] == "PLACEBO_GATE" and r["steps"][-1]["status"] == "FAILED"
    assert r["outcome"] == "REJECTED_BY_PLACEBO_GATE" and "REPORT" not in names(r) and "DEPLOY" not in names(r)
    assert deploys == [] and D.active(shadow) == []


@pytest.mark.parametrize("target,after", [("TRAIN", ["TRIGGER_CHECK", "FREEZE_SNAPSHOT", "TRAIN"]),
                                          ("WALK_FORWARD", ["TRIGGER_CHECK", "FREEZE_SNAPSHOT", "TRAIN"]),
                                          ("PLACEBO_GATE", ["TRIGGER_CHECK", "FREEZE_SNAPSHOT", "TRAIN", "WALK_FORWARD"])])
def test_an_error_at_any_step_ends_the_run_and_nothing_later_runs(shadow, tmp_path, signal, monkeypatch, target, after):
    calls = {"n": 0}

    def boom(*a, **k):
        calls["n"] += 1
        raise RuntimeError("injected failure")
    monkeypatch.setattr({"TRAIN": CH, "WALK_FORWARD": O.W, "PLACEBO_GATE": O.P}[target], {"TRAIN": "train_family", "WALK_FORWARD": "evaluate_walk_forward", "PLACEBO_GATE": "run_gate"}[target], boom)
    if target == "PLACEBO_GATE":
        real = W.evaluate_walk_forward
        monkeypatch.setattr(O.W, "evaluate_walk_forward", lambda s, **k: (lambda ev: [e.__setitem__("evidence", "PROMISING_PENDING_PLACEBO_GATE") for e in ev["challengers"].values()] and ev or ev)(real(s, **k)))
    r = go(shadow, tmp_path, signal, deploy_authorization=HUMAN)
    assert r["outcome"] == "FAILED" and calls["n"] == 1, "a failing step must be attempted exactly once"
    assert names(r)[:len(after)] == after and not {"REPORT", "DEPLOY"} & set(names(r))
    assert ExperimentRegistry(shadow).status_of(r["cycle_experiment_id"]) == "FAILED" and D.active(shadow) == []


def test_below_threshold_publishes_nothing_and_logs_a_non_run(shadow, tmp_path):
    tiny = synthetic(n_scans=6, oos_scans=1)
    r = go(shadow, tmp_path, tiny)
    assert r["outcome"] == "NOT_TRIGGERED" and r["steps"][0]["status"] == "NOT_FIRED"
    assert not os.path.exists(tmp_path / "work" / "snapshots") or os.listdir(tmp_path / "work" / "snapshots") == []
    assert ExperimentRegistry(shadow).status_of(r["cycle_experiment_id"]) == "SUPERSEDED"


def test_no_data_yet_is_reported_plainly(shadow, tmp_path):
    r = O.run_cycle(shadow, work_dir=str(tmp_path / "work"), now_ms=NOW, policy=POLICY)          # the real builder on an empty shadow database
    assert r["outcome"] == "NO_DATA_YET" and "NO_VALID_RESOLVED_ROWS" in r["reason"] and names(r) == ["TRIGGER_CHECK"]


# ---- one test per OUT-OF-SCOPE invariant --------------------------------------------------------------------------------
TREE = ast.parse(pathlib.Path(O.__file__).read_text())
TREE.body = [n for n in TREE.body if not (isinstance(n, ast.Expr) and isinstance(getattr(n, "value", None), ast.Constant) and isinstance(n.value.value, str))]   # drop the docstring: code only
SRC = ast.unparse(TREE)
ALLOWED_PACKAGES = {"datasets", "evaluation", "experiments", "lifecycle", "orchestrator", "shadow", "shadow_models", "training"}


def imported_packages():
    out = set()
    for n in ast.walk(TREE):
        mods = [n.module] if isinstance(n, ast.ImportFrom) and n.module else [a.name for a in n.names] if isinstance(n, ast.Import) else []
        for m in mods:
            if m.startswith("market_edge_exec."):
                out.add(m.split(".")[1])
    return out


def test_invariant_1_it_cannot_change_production_quant(shadow, tmp_path, signal):
    assert imported_packages() <= ALLOWED_PACKAGES
    for name in ("quant_engine", "scan-core", "signal-bridge", "scan_core", "BEST_TRADE_NOW"):
        assert name not in SRC
    assert go(shadow, tmp_path, signal)["production_touched"] is False


def test_invariant_2_it_cannot_change_risk_policy(shadow, tmp_path, signal):
    assert "risk" not in imported_packages() and not any(w in SRC for w in ("sizing_v2", "risk_sizing", "RISK_SIZING", "RiskLimits"))
    app = create_app(db_path=str(tmp_path / "ledger.sqlite3"), shadow_db_path=shadow.path)
    before = hashlib.sha256(open(tmp_path / "ledger.sqlite3", "rb").read()).hexdigest()
    go(shadow, tmp_path, signal, deploy_authorization=HUMAN)
    assert hashlib.sha256(open(tmp_path / "ledger.sqlite3", "rb").read()).hexdigest() == before


def test_invariant_3_it_cannot_change_exit_policy(shadow, tmp_path, signal):
    assert "exits" not in imported_packages() and "paper" not in imported_packages() and "EXIT_" not in SRC and "exit_policy" not in SRC
    create_app(db_path=str(tmp_path / "ledger.sqlite3"), shadow_db_path=shadow.path)
    with closing(sqlite3.connect(tmp_path / "ledger.sqlite3")) as c:
        before = [c.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("exit_policy_counterfactuals", "exit_path_observations", "paper_trades")]
    go(shadow, tmp_path, signal, deploy_authorization=HUMAN)
    with closing(sqlite3.connect(tmp_path / "ledger.sqlite3")) as c:
        assert before == [c.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("exit_policy_counterfactuals", "exit_path_observations", "paper_trades")]


def test_invariant_4_it_cannot_enable_paper_mode(shadow, tmp_path, signal):
    from_lifecycle = {a.name for n in ast.walk(TREE) if isinstance(n, ast.ImportFrom) and n.module == "market_edge_exec.lifecycle.policy" for a in n.names}
    assert from_lifecycle == {"LifecycleError", "check_authorization"}
    assert "policy_lifecycle_events" not in SRC and "lifecycle.policy import" in SRC and "import policy" not in SRC     # only the validator is imported, never a transition
    LP.register(shadow, policy_id="p", policy_type="RANKING_MODEL", criteria={"shadow_entry": {"evidence_experiment_status": "PROMISING"}, "paper_entry": {"evidence_kind": "PROMISING_EXPERIMENT"}}, now_ms=1)
    go(shadow, tmp_path, signal, deploy_authorization=HUMAN)         # every upstream gate passes and a person authorized SHADOW deployment
    assert LP.state_of(shadow, "p") == "RESEARCH" and [e["event_type"] for e in LP.history(shadow, "p")["events"]] == ["REGISTERED"]
    assert "PAPER" not in SRC


def test_invariant_5_there_is_no_live_path(shadow, tmp_path, signal):
    for word in ("LIVE", "MAINNET", "live_trading", "place_order", "submit_order"):
        assert word not in SRC, word
    assert "LIVE" not in LP.STATES


def test_invariant_6_it_never_retrains_per_trade(shadow, tmp_path, signal):
    for other in pathlib.Path(O.__file__).parents[1].glob("**/*.py"):
        if "orchestrator" not in other.parts and "tests" not in other.parts:
            assert "orchestrator" not in other.read_text(), f"{other} calls the orchestrator: no hook on the trade path may retrain"
    assert not any(w in SRC for w in ("on_trade", "on_fill", "tick(", "after_close"))
    go(shadow, tmp_path, signal)
    one_more = copy.deepcopy(signal)             # one new trade's worth of data appears: far below every floor
    extra = dict(one_more["rows"][0], observation_id="new-1", scan_id="new-s", cluster_id="new-c", episode_id="new-c", decision_ts=one_more["rows"][-1]["decision_ts"] + 1000)
    one_more["rows"].append(extra)
    r = go(shadow, tmp_path, one_more, date="20270102")
    assert r["outcome"] == "NOT_TRIGGERED" and "TRAIN" not in names(r)


def test_invariant_7_a_rejected_result_is_never_retried_with_adjusted_parameters(shadow, tmp_path, monkeypatch):
    assert not any(isinstance(n, (ast.While,)) for n in ast.walk(TREE))
    assert not any(w in SRC.lower() for w in ("retry", "attempts", "grid", "sweep", "tune", "alpha=", "n_folds="))
    seen = {"evaluate": [], "gate": []}
    real_eval, real_gate = W.evaluate_walk_forward, P.run_gate
    monkeypatch.setattr(O.W, "evaluate_walk_forward", lambda s, **k: seen["evaluate"].append(k) or real_eval(s, **k))
    monkeypatch.setattr(O.P, "run_gate", lambda *a, **k: seen["gate"].append(k) or real_gate(*a, **k))
    r = go(shadow, tmp_path, noise_snapshot(9))
    assert r["outcome"] == "NO_EVIDENCE" and len(seen["evaluate"]) == 1 and seen["gate"] == []
    assert seen["evaluate"][0] == {"seed": O.run_cycle.__kwdefaults__["seed"]}, "the evaluation must run with the default, unadjusted parameters"
    again = go(shadow, tmp_path, noise_snapshot(9))                 # asking again cannot re-run it either
    assert again["outcome"] == "NOT_TRIGGERED" and len(seen["evaluate"]) == 1


def test_invariant_8_the_sealed_holdout_is_never_read(shadow, tmp_path):
    assert "OOS" not in SRC and "oos" not in SRC.replace("oos_rows_untouched", "").lower()
    a, b = signal_snapshot(), signal_snapshot()
    for r in b["rows"]:
        if r["split"] == "OOS":
            r["target"] = 1e6                                        # poison the holdout: any read of it changes the result
    ra = go(ShadowStore(str(tmp_path / "a.sqlite3")), tmp_path / "a", a)
    rb = go(ShadowStore(str(tmp_path / "b.sqlite3")), tmp_path / "b", b)
    stepa, stepb = ({s["step"]: s for s in r["steps"]} for r in (ra, rb))
    assert stepa["WALK_FORWARD"]["per_challenger"] == stepb["WALK_FORWARD"]["per_challenger"] and stepa["WALK_FORWARD"]["oos_rows_untouched"] == 20 * 3
    ea = ExperimentRegistry(ShadowStore(str(tmp_path / "a.sqlite3")))
    eb = ExperimentRegistry(ShadowStore(str(tmp_path / "b.sqlite3")))
    def folds(reg, eid):
        return reg.history(eid)["latest_results"]["challengers"]
    assert folds(ea, ra["evaluation_experiment_id"]) == folds(eb, rb["evaluation_experiment_id"])
