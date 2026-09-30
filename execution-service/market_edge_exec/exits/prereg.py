"""Pre-registration of the STATE_AWARE_GIVEBACK_V1 grid in the Experiment Registry (#121, DATA 5).

The grid is declared in `policies.STATE_AWARE_GRID` before any evaluation. This records it as ONE planned experiment (idempotent) so that
every tested variant, including the ones that fail, is on the append-only record with a config hash. It runs nothing and changes no policy.
"""
from __future__ import annotations

from typing import Optional

from market_edge_exec.exits import EXIT_MANAGER_VERSION, policies as pol
from market_edge_exec.exits.evaluation import EVIDENCE_BAR_V1
from market_edge_exec.experiments.registry import ExperimentRegistry, RegistryError
from market_edge_exec.paper import lifecycle

EXPERIMENT_ID = "exp-STATE_AWARE_GIVEBACK_V1"


def variants() -> list[str]:
    return [name for name, p in pol.REGISTRY.items() if p.study == "3Q"]


def config() -> dict:
    return {
        "research_question": "Does holding a winner while its peak is recent or momentum is healthy, and protecting it only after a large "
                             "fractional giveback with stalled momentum, beat CURRENT_POLICY after costs without sacrificing rare large winners?",
        "dataset_version": "EXIT-COUNTERFACTUALS-PAPER-AND-SHADOW-COHORTS",
        "feature_set_version": EXIT_MANAGER_VERSION + "/PositionState",
        "model_type": "DETERMINISTIC_RULE_FAMILY (no fitted model)",
        "hyperparameters": {"family": "STATE_AWARE_GIVEBACK_V1", "registry_version": pol.POLICY_REGISTRY_VERSION, "grid": {
            "activate_R": pol.STATE_AWARE_GRID["activate_R"], "vol_mult": pol.STATE_AWARE_GRID["vol_mult"],
            "variants": [{"mode": m, "giveback_fraction": g, "stall_h": h} for m, g, h in pol.STATE_AWARE_GRID["variants"]]},
            "variant_names": variants()},
        "random_seed": EVIDENCE_BAR_V1["seed"],
        "cost_assumptions": {"fee_pct_per_side": lifecycle.FEE_PCT, "slippage_pct_per_side": lifecycle.SLIPPAGE_PCT},
        "evaluation_horizon": "to the exit of CURRENT_POLICY on the same recorded path",
        "cluster_resampling": {"cluster_hours": EVIDENCE_BAR_V1["cluster_hours"], "resamples": EVIDENCE_BAR_V1["bootstrap_resamples"]},
        "baseline": pol.BASELINE,
    }


def register(registry: ExperimentRegistry, actor: str = "exit-research", now_ms: Optional[int] = None) -> dict:
    """Idempotent: a second call returns the existing record instead of creating a repeat."""
    try:
        return {"created": True, **registry.create(config(), experiment_id=EXPERIMENT_ID, actor=actor, now_ms=now_ms)}
    except RegistryError as error:
        if str(error).startswith("EXPERIMENT_EXISTS"):
            return {"created": False, "experiment_id": EXPERIMENT_ID, "status": registry.status_of(EXPERIMENT_ID)}
        raise
