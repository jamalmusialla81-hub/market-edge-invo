"""DATA 17: the learning loop, automated, and stopped exactly where a human must decide.

    check trigger -> freeze snapshot (DATA 3) -> train (DATA 6) -> walk-forward (DATA 7) -> placebo gate (DATA 8)
      -> report -> [deploy to SHADOW only with an explicit person's authorization (DATA 9)] -> record (DATA 5)

It only SEQUENCES those modules; it reimplements none of them. Each out-of-scope item is a code-level fact with a test:
  - it imports nothing that can change production Quant, risk policy or exit policy, and nothing from the paper/execution/api layers
  - it never calls a lifecycle transition, so it cannot enable PAPER, and no LIVE state exists in the framework
  - training is triggered by DATA 6's episode / choice-scan / schedule gate, never by a trade
  - a rejected or NO_EVIDENCE result ends the run: each step runs at most once, there is no loop and no parameter adjustment. A genuinely new
    attempt is a new call with a new research question, logged as such
  - the sealed OOS split is never read here (DATA 6/7 leave it untouched and record the count)
  - the deploy step defaults to "awaiting authorization"; it deploys only with a named person's logged authorization, and only to SHADOW
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import tempfile
from typing import Any, Callable, Optional

from market_edge_exec.datasets import builder as B
from market_edge_exec.evaluation import placebo as P, walkforward as W
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.lifecycle.policy import LifecycleError, check_authorization
from market_edge_exec.orchestrator import ORCHESTRATOR_VERSION
from market_edge_exec.shadow.store import ShadowStore
from market_edge_exec.shadow_models import deploy as D
from market_edge_exec.training import challengers as CH, run as RUN, trigger as T

ACTOR = "ORCHESTRATOR"
STEPS = ("TRIGGER_CHECK", "FREEZE_SNAPSHOT", "TRAIN", "WALK_FORWARD", "PLACEBO_GATE", "REPORT", "DEPLOY", "RECORD")


class _Stop(Exception):
    def __init__(self, outcome: str, reason: str):
        super().__init__(reason)
        self.outcome, self.reason = outcome, reason


def _date(now_ms: int) -> str:
    return datetime.datetime.fromtimestamp(now_ms / 1000, datetime.timezone.utc).strftime("%Y%m%d")


def run_cycle(shadow: ShadowStore, *, work_dir: str, now_ms: int, policy: Optional[T.TriggerPolicy] = None, source_commit: Optional[str] = None,
              seed: int = 20260929, placebo_runs: int = 40, deploy_authorization: Optional[dict] = None, date: Optional[str] = None,
              snapshot_builder: Callable[..., dict] = B.build_snapshot) -> dict:
    policy = policy or T.TriggerPolicy()
    registry = ExperimentRegistry(shadow)
    os.makedirs(work_dir, exist_ok=True)
    date = date or _date(now_ms)
    cycle = registry.create({"research_question": "Orchestrated learning cycle: trigger, snapshot, train, walk-forward, placebo gate, report",
                             "dataset_version": B.BASE_DATASET, "feature_set_version": "FEATURE-SET-V2", "model_type": "ORCHESTRATED_CYCLE",
                             "hyperparameters": {"orchestrator_version": ORCHESTRATOR_VERSION, "policy": vars(policy), "placebo_runs": placebo_runs, "date": date,
                                                 "deploy_authorization_supplied": deploy_authorization is not None},
                             "random_seed": seed, "baseline": "QUANT_BASELINE", "source_commit": source_commit}, actor=ACTOR, now_ms=now_ms)
    cid = cycle["experiment_id"]
    report: dict[str, Any] = {"orchestrator_version": ORCHESTRATOR_VERSION, "cycle_experiment_id": cid, "now_ms": now_ms, "steps": [], "outcome": None, "stopped_at": None,
                              "production_touched": False, "deployed": [], "awaiting_authorization": []}

    def done(name: str, status: str, **detail):
        report["steps"].append({"step": name, "status": status, **detail})

    try:
        # 1. Is there enough NEW evidence? Judged on a scratch build, so nothing is published unless the trigger fires.
        scratch = tempfile.mkdtemp(prefix="cycle-", dir=work_dir)
        try:
            try:
                manifest = snapshot_builder(shadow.path, scratch, date=date, as_of_ms=now_ms, source_commit=source_commit, generated_at_ms=now_ms)
            except B.SnapshotError as error:
                done("TRIGGER_CHECK", "NOT_RUN", reason=str(error))
                raise _Stop("NO_DATA_YET", str(error))
            decision = T.decide(policy, T.stats_from_snapshot(os.path.join(scratch, manifest["version"])), RUN.last_trained(registry), now_ms)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        done("TRIGGER_CHECK", "FIRED" if decision["fire"] else "NOT_FIRED", decision=decision)
        if not decision["fire"]:
            raise _Stop("NOT_TRIGGERED", "; ".join(decision["blocked_by"] or ["NO_THRESHOLD_MET"]))
        registry.transition(cid, "RUNNING", actor=ACTOR, now_ms=now_ms)

        # 2. Freeze the published, immutable snapshot (same content the trigger judged).
        out_dir = os.path.join(work_dir, "snapshots")
        os.makedirs(out_dir, exist_ok=True)
        try:
            manifest = snapshot_builder(shadow.path, out_dir, date=date, as_of_ms=now_ms, source_commit=source_commit, generated_at_ms=now_ms)
        except B.SnapshotError as error:
            done("FREEZE_SNAPSHOT", "FAILED", error=str(error))
            raise _Stop("FAILED", f"FREEZE_SNAPSHOT: {error}")
        folder = os.path.join(out_dir, manifest["version"])
        done("FREEZE_SNAPSHOT", manifest.get("status", "PUBLISHED"), snapshot_version=manifest["version"], content_hash=manifest["content_hash"], counts=manifest["counts"])
        report["snapshot"] = {"version": manifest["version"], "content_hash": manifest["content_hash"], "path": folder}

        # 3. Train (DATA 6). Its own trigger check runs again on the same frozen snapshot; a refusal there is honoured.
        trained = RUN.run_cycle(registry, folder, os.path.join(work_dir, "artifacts"), policy, now_ms, source_commit=source_commit, seed=seed)
        if not trained["ran"] or trained["status"] != "NO_EVIDENCE":
            done("TRAIN", "FAILED" if trained.get("ran") else "NOT_RUN", detail=trained.get("error") or trained["decision"].get("blocked_by"))
            raise _Stop("FAILED" if trained.get("ran") else "NOT_TRIGGERED", "TRAIN did not complete")
        done("TRAIN", "TRAINED", experiment_id=trained["experiment_id"], artifact_hashes=trained["results"]["artifact_hashes"])
        report["training_experiment_id"] = trained["experiment_id"]

        # 4. Walk-forward on TRAIN + VALIDATION only (DATA 7). One attempt.
        snap = CH.load_snapshot(folder)
        evaluation = W.evaluate_walk_forward(snap, seed=seed)
        logged = W.log_evaluation(registry, evaluation, source_commit=source_commit, now_ms=now_ms)
        promising = [m for m, e in evaluation["challengers"].items() if e["evidence"] == "PROMISING_PENDING_PLACEBO_GATE"]
        done("WALK_FORWARD", logged["status"], experiment_id=logged["experiment_id"], oos_rows_untouched=evaluation["oos_rows_untouched"], promising=promising,
             per_challenger={m: e["evidence"] for m, e in evaluation["challengers"].items()})
        report["evaluation_experiment_id"] = logged["experiment_id"]
        if not promising:
            raise _Stop("NO_EVIDENCE", "no challenger showed stable, cluster-CI-backed improvement; the run ends here and is not repeated with other settings")

        # 5. Placebo / noise gate (DATA 8) for each challenger that earned it.
        gates, passed = {}, []
        for name in promising:
            gate = P.run_gate(snap, evaluation, name, runs=placebo_runs, seed=seed)
            gates[name] = P.log_gate(registry, gate, logged["experiment_id"], source_commit=source_commit, now_ms=now_ms)
            gates[name]["variants"] = {v: {"p_value": r["p_value"], "passed": r["passed"]} for v, r in gate["variants"].items()}
            if gate["passed"]:
                passed.append(name)
        done("PLACEBO_GATE", "PASSED" if passed else "FAILED", gates=gates, passed=passed)
        if not passed:
            raise _Stop("REJECTED_BY_PLACEBO_GATE", "every promising challenger failed the placebo gate; nothing is deployed and no step retries")

        # 6. Report, then the only optional step.
        report_path = _write_report(work_dir, cid, report, evaluation, passed)
        done("REPORT", "WRITTEN", path=report_path)
        if deploy_authorization is None:
            report["awaiting_authorization"] = passed
            done("DEPLOY", "AWAITING_AUTHORIZATION", candidates=passed, note="a named person's authorization is required before a SHADOW deployment; none was supplied")
        else:
            try:
                auth = check_authorization(deploy_authorization)
            except LifecycleError as error:
                done("DEPLOY", "REFUSED", reason=str(error))
                raise _Stop("PASSED_AWAITING_VALID_AUTHORIZATION", str(error))
            for name in passed:
                try:
                    out = D.deploy(registry, shadow, evaluation_experiment_id=logged["experiment_id"], training_experiment_id=trained["experiment_id"], model_name=name,
                                   actor=auth["authorized_by"], now_ms=now_ms)
                    report["deployed"].append({**out, "authorization": auth})
                except D.DeploymentError as error:
                    done("DEPLOY", "REFUSED", model=name, reason=str(error))
            done("DEPLOY", "DEPLOYED_SHADOW_ONLY" if report["deployed"] else "NOTHING_DEPLOYED", deployed=[d["model_key"] for d in report["deployed"]])
        report["outcome"] = "PASSED_PLACEBO_GATE"
    except _Stop as stop:
        report["outcome"], report["stopped_at"], report["reason"] = stop.outcome, report["steps"][-1]["step"] if report["steps"] else None, stop.reason
    except Exception as error:  # noqa: BLE001 -- every failure is recorded and ends the run; nothing retries
        report["outcome"], report["reason"] = "FAILED", f"{type(error).__name__}: {error}"
        report["stopped_at"] = report["steps"][-1]["step"] if report["steps"] else None
    _record(registry, cid, report, now_ms)
    return report


def _write_report(work_dir: str, cid: str, report: dict, evaluation: dict, passed: list[str]) -> str:
    folder = os.path.join(work_dir, "reports")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{cid}.json")
    with open(path, "w") as f:
        json.dump({"cycle": {k: v for k, v in report.items() if k != "steps"}, "steps": report["steps"], "evaluation_result_hash": evaluation["result_hash"],
                   "passed_placebo_gate": passed, "note": "Evidence for a human. Nothing here promotes anything; DATA 11 requires a person's authorization."}, f, indent=1, sort_keys=True, default=str)
    return path


def _record(registry: ExperimentRegistry, cid: str, report: dict, now_ms: int) -> None:
    status = registry.status_of(cid)
    outcome = report["outcome"]
    note = f"{outcome}" + (f": {report.get('reason')}" if report.get("reason") else "")
    if status == "PLANNED":
        registry.transition(cid, "SUPERSEDED", note="NOT_RUN: " + note, actor=ACTOR, now_ms=now_ms)
    elif outcome == "FAILED":
        registry.transition(cid, "FAILED", note=note, actor=ACTOR, now_ms=now_ms)
    elif outcome == "PASSED_PLACEBO_GATE":
        registry.transition(cid, "PROMISING", results=report, note="Passed the placebo gate. NOT deployed and NOT promoted unless a person authorized SHADOW deployment; DATA 11 governs anything further.", actor=ACTOR, now_ms=now_ms)
    else:
        registry.transition(cid, "NO_EVIDENCE", results=report, note=note, actor=ACTOR, now_ms=now_ms)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="One orchestrated learning cycle. Paper/shadow only; never changes production.")
    ap.add_argument("--shadow-db", required=True)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--source-commit")
    ap.add_argument("--placebo-runs", type=int, default=40)
    ap.add_argument("--deploy-authorization-file", help="JSON with authorized_by, authorization_ref, statement from a person; omit to stop before deployment")
    args = ap.parse_args(argv)
    auth = json.load(open(args.deploy_authorization_file)) if args.deploy_authorization_file else None
    import time
    out = run_cycle(ShadowStore(args.shadow_db), work_dir=args.work_dir, now_ms=int(time.time() * 1000), source_commit=args.source_commit, placebo_runs=args.placebo_runs, deploy_authorization=auth)
    print(json.dumps({k: out[k] for k in ("cycle_experiment_id", "outcome", "stopped_at", "deployed", "awaiting_authorization")}, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
