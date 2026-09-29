"""DATA 8 (#58): the mandatory placebo gate, calibrated on pure noise."""
import time

import pytest

from market_edge_exec.evaluation import placebo as P, walkforward as W
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.shadow.store import ShadowStore
from market_edge_exec.training import challengers as CH
from tests.test_walk_forward import synthetic


def noise_snapshot(seed):
    return synthetic(n_scans=110, signal=lambda i, x: 0.0, seed=seed, oos_scans=5)


def signal_snapshot():
    return synthetic(n_scans=240, oos_scans=20)


def evaluate(snap, name="ridge", seed=1):
    return W.evaluate_walk_forward(snap, model_factory=lambda sd: [m for m in CH.family(sd) if m.name == name], seed=seed, bootstrap_n=300)


def test_a_challenger_with_real_signal_passes_every_placebo_variant():
    snap = signal_snapshot()
    ev = evaluate(snap)
    assert ev["challengers"]["ridge"]["evidence"] == "PROMISING_PENDING_PLACEBO_GATE"
    g = P.run_gate(snap, ev, "ridge", runs=30)
    assert g["passed"] is True, g
    assert set(g["variants"]) == set(P.VARIANTS)
    assert all(v["p_value"] <= P.ALPHA for v in g["variants"].values())


def test_the_calibration_false_positive_rate_on_null_data_is_low():
    """Regression form of the calibration study: over 40 seeded pure-noise datasets, the placebo layer alone
    clears all four variants in well under 15% of them (design level 5%; measured value is recorded in the docs)."""
    cal = P.calibrate(noise_snapshot, "ridge", datasets=40, runs=20, seed=100)
    assert cal["false_positive_rate"] <= 0.15, cal
    assert abs(cal["mean_observed_delta_R"]) < 0.15
    print("CALIBRATION", cal)


def test_a_model_with_no_signal_fails_and_the_placebo_stage_is_not_run_without_evidence():
    snap = noise_snapshot(7)
    ev = evaluate(snap)
    g = P.run_gate(snap, ev, "ridge", runs=20)
    assert g["passed"] is False and g["reasons"][0].startswith("EVALUATION_HAS_NO_EVIDENCE") and g["variants"] == {}


def test_the_known_failing_case_the_current_quant_ranking_still_fails():
    snap = synthetic(n_scans=240, oos_scans=20)      # the label depends on a feature; the Quant score is unrelated noise
    ev = W.evaluate_walk_forward(snap, model_factory=lambda sd: [CH.QuantBaseline()], seed=1, bootstrap_n=200)
    assert ev["challengers"]["quant_baseline"]["evidence"] == "NO_EVIDENCE"
    assert P.run_gate(snap, ev, "quant_baseline", runs=20)["passed"] is False


def test_the_gate_is_reproducible_and_needs_enough_runs_to_be_meaningful():
    snap = signal_snapshot()
    ev = evaluate(snap)
    a, b = P.run_gate(snap, ev, "ridge", runs=20, seed=5), P.run_gate(snap, ev, "ridge", runs=20, seed=5)
    assert a["result_hash"] == b["result_hash"]
    with pytest.raises(P.PlaceboGateError, match="TOO_FEW_RUNS"):
        P.run_gate(snap, ev, "ridge", runs=10)
    with pytest.raises(P.PlaceboGateError, match="UNKNOWN_CHALLENGER"):
        P.run_gate(snap, ev, "nope", runs=20)


def test_shuffled_outcomes_really_remove_the_edge():
    snap = signal_snapshot()
    ev = evaluate(snap)
    dist = P.placebo_distribution(snap, "ridge", "shuffled_outcomes", 15, 3, n_folds=4, initial_train_fraction=0.4)
    assert sum(dist) / len(dist) < 0.5 * ev["challengers"]["ridge"]["vs"]["random"]["mean_delta_R"]


# ---- the hard check DATA 9 calls -------------------------------------------------------
@pytest.fixture
def world(tmp_path):
    reg = ExperimentRegistry(ShadowStore(str(tmp_path / "s.sqlite3")))
    snap = signal_snapshot()
    ev = evaluate(snap)
    eval_id = W.log_evaluation(reg, ev, now_ms=1)["experiment_id"]
    return reg, snap, ev, eval_id


def test_deployment_check_refuses_without_a_gate_result(world):
    reg, snap, ev, eval_id = world
    with pytest.raises(P.PlaceboGateError, match="PLACEBO_GATE_NOT_RUN"):
        P.assert_placebo_passed(reg, eval_id, "ridge")
    with pytest.raises(P.PlaceboGateError, match="NO_RECORDED_EVALUATION"):
        P.assert_placebo_passed(reg, "exp-missing", "ridge")


def test_deployment_check_accepts_only_a_passed_gate_for_exactly_this_evaluation(world):
    reg, snap, ev, eval_id = world
    P.log_gate(reg, P.run_gate(snap, ev, "ridge", runs=20), eval_id, now_ms=2)
    assert P.assert_placebo_passed(reg, eval_id, "ridge")["passed"] is True
    with pytest.raises(P.PlaceboGateError, match="PLACEBO_GATE_NOT_RUN"):
        P.assert_placebo_passed(reg, eval_id, "gbm_stumps")             # a gate for another model does not count
    other = W.log_evaluation(reg, W.evaluate_walk_forward(snap, model_factory=lambda sd: [m for m in CH.family(sd) if m.name == "ridge"], seed=99, bootstrap_n=100), now_ms=3)
    with pytest.raises(P.PlaceboGateError, match="PLACEBO_GATE_NOT_RUN"):
        P.assert_placebo_passed(reg, other["experiment_id"], "ridge")    # nor one for another evaluation


def test_a_failed_gate_blocks_and_a_tampered_evaluation_hash_is_detected(world):
    reg, snap, ev, eval_id = world
    failed = {**P.run_gate(snap, ev, "ridge", runs=20), "passed": False, "reasons": ["NOT_BETTER_THAN_PLACEBO: shuffled_features (p=0.300)"]}
    P.log_gate(reg, failed, eval_id, now_ms=2)
    with pytest.raises(P.PlaceboGateError, match="PLACEBO_GATE_FAILED"):
        P.assert_placebo_passed(reg, eval_id, "ridge")
    forged = {**P.run_gate(snap, ev, "ridge", runs=20), "evaluation_result_hash": "0" * 64}
    P.log_gate(reg, forged, eval_id, now_ms=4)
    with pytest.raises(P.PlaceboGateError, match="DIFFERENT_EVALUATION_RESULT"):
        P.assert_placebo_passed(reg, eval_id, "ridge")


def test_there_is_no_override_parameter():
    import inspect
    assert not {"force", "override", "skip", "bypass"} & set(inspect.signature(P.assert_placebo_passed).parameters)
