"""Read-only data for the exit-evidence dashboard (#122). Nothing here writes, decides or promotes; it only counts what the
completeness check (#119) and the Shadow replay (#120) already recorded, so it is obvious why adaptive exits stay disabled."""
from __future__ import annotations

import time
from collections import defaultdict
from contextlib import closing
from typing import Callable, Optional

from market_edge_exec.exits import completeness as cp, policies as pol, shadow_replay as sr
from market_edge_exec.exits.evaluation import EVIDENCE_BAR_V1

LABEL = "POST-OUTCOME RESEARCH ONLY · NOT AN ACTION THE BOT TOOK"
DAY_MS = 86_400_000


def _shadow_counts(shadow_connect: Callable) -> dict:
    marks = ",".join("?" * len(sr.B_REASONS))
    with closing(shadow_connect()) as conn:
        one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]
        return {
            "raw_observations": one("SELECT COUNT(*) FROM shadow_observations"),
            "candidate_observations": one("SELECT COUNT(*) FROM shadow_observations WHERE kind='CANDIDATE'"),
            # cheap column-level split; the decision-time field checks run when a candidate is replayed (#120)
            "candidates_not_executed_for_a_selection_reason": one(
                f"SELECT COUNT(*) FROM shadow_observations WHERE kind='CANDIDATE' AND research_candidate_valid=1 AND execution_status IN ('NOT_SUBMITTED','REJECTED') "
                f"AND execution_rejection_reason IN ({marks})", *sorted(sr.B_REASONS)),
            "candidates_research_only": one(
                f"SELECT COUNT(*) FROM shadow_observations WHERE kind='CANDIDATE' AND research_candidate_valid=1 AND execution_status IN ('NOT_SUBMITTED','REJECTED') "
                f"AND IFNULL(execution_rejection_reason,'') NOT IN ({marks})", *sorted(sr.B_REASONS)),
            "unique_market_episodes": one("SELECT COUNT(DISTINCT market_episode_id) FROM shadow_observations WHERE kind='CANDIDATE'"),
            "unique_observation_clusters": one("SELECT COUNT(DISTINCT observation_cluster_id) FROM shadow_observations WHERE kind='CANDIDATE'"),
        }


def _daily(shadow_connect: Callable, complete_open_days: list[int]) -> list[dict]:
    """Finalized replays (one per replayed observation) and complete-path paper trades per UTC day: whether evidence is accelerating."""
    days: dict = defaultdict(lambda: {"shadow_replays": 0, "paper_complete_trades": 0})
    if sr.has_table(shadow_connect):
        with closing(shadow_connect()) as conn:
            for day, n in conn.execute("SELECT opened_at_ms / ?, COUNT(DISTINCT observation_id) FROM shadow_exit_replays GROUP BY 1", (DAY_MS,)):
                days[int(day)]["shadow_replays"] = n
    for day in complete_open_days:
        days[day]["paper_complete_trades"] += 1
    return [{"day_utc_ms": d * DAY_MS, **v} for d, v in sorted(days.items())]


def build(exit_connect: Callable, shadow_connect: Callable, now_ms: Optional[int] = None) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    integrity = cp.assess(exit_connect)
    evaluation = cp.evaluate_eligible(exit_connect)
    cohorts = sr.cohort_report(shadow_connect, now_ms)
    bar = EVIDENCE_BAR_V1
    passing = sorted(name for name, m in evaluation["policies"].items() if m.get("verdict") == "PASS")
    verdicts: dict = defaultdict(int)
    for m in evaluation["policies"].values():
        verdicts[m.get("verdict")] += 1
    trades_by_id = {t["trade_id"]: t for t in integrity["trades"]}
    complete_days = []
    with closing(exit_connect()) as conn:
        for row in conn.execute("SELECT trade_id, opened_at_ms FROM paper_trades").fetchall():
            if trades_by_id.get(row[0], {}).get("label") == cp.COMPLETE:
                complete_days.append(int(row[1]) // DAY_MS)
    n_trades, n_eps = evaluation["trades_with_baseline"], evaluation["independent_episodes"]
    classes = {c: v["episode_classes"] for c, v in cohorts["cohorts"].items()}
    counts = lambda label: integrity["counts"].get(label, 0)
    return {
        "label": LABEL, "read_only": True, "generated_at_ms": now_ms,
        "shadow": _shadow_counts(shadow_connect),
        "paper": {"complete_path_finalized_trades": counts(cp.COMPLETE), "legacy_unlinked": counts(cp.LEGACY), "open": counts(cp.OPEN),
                  "path_incomplete": counts(cp.PATH_INCOMPLETE), "replays_missing": counts(cp.REPLAYS_MISSING)},
        "executable_shadow": {c: {"replayed_observations": v["replayed_observations"], "observation_clusters": v["observation_clusters"],
                                  "market_episodes": v["market_episodes"], "independence_units_3h": v["independence_units_3h"]}
                              for c, v in cohorts["cohorts"].items()},
        "episode_classes": classes,
        "entry_failure_episodes": sum(c.get("ENTRY_FAILURE", 0) for c in classes.values()),
        "giveback_failure_episodes": sum(c.get("GIVEBACK_FAILURE", 0) for c in classes.values()),
        "gate": {"bar": bar["version"], "paper_finalized": n_trades, "paper_finalized_needed": bar["min_trades"],
                 "independent_episodes": n_eps, "independent_episodes_needed": bar["min_independent_episodes"],
                 "verdicts": dict(sorted((str(k), v) for k, v in verdicts.items())), "passing_policies": passing,
                 "passing_summary": ", ".join(passing) if passing else "NONE"},
        "current_vs_adaptive": {name: {"trades": m["trades"], "mean_R": m["mean_R"], "baseline_mean_R": m["baseline"]["mean_R"],
                                       "delta_mean_R": m["delta_mean_R"], "verdict": m["verdict"]} for name, m in evaluation["policies"].items()},
        "pipeline": {"status": integrity["pipeline_status"], "degraded_trades": integrity["degraded_trades"]},
        "cohort_B_C_note": "Executable-Shadow and research-only episodes are supporting evidence. They never count toward the paper bar or enable any adaptive exit.",
        "next_evaluation_condition": (f"The paper bar needs {bar['min_trades']} finalized complete-path trades in {bar['min_independent_episodes']} independent "
                                      f"{bar['cluster_hours']}h episodes (now {n_trades} / {n_eps}). Until a policy passes every check, PAPER and PAPER_CANARY stay disabled."),
        "adaptive_exits_enabled": {"PAPER": False, "PAPER_CANARY": False},
        "daily": _daily(shadow_connect, complete_days),
    }
