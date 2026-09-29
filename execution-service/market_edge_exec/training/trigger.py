"""When is training allowed to fire? A pure function of what is NEW since the last run on this lineage.

Never per-trade: every threshold has a floor, so no policy can be satisfied by one trade.
Never on effectively unchanged data: if too small a share of the current snapshot's
clusters is new relative to the last trained snapshot, training is refused even when
the raw row count is large (near-duplicate composition is not new evidence).
"""
from __future__ import annotations

import os
import sqlite3
from collections import Counter
from contextlib import closing
from dataclasses import dataclass, field
from typing import Optional

DAY_MS = 86_400_000
FLOOR_EPISODES, FLOOR_CHOICE_SCANS, FLOOR_NEW_CLUSTER_FRACTION = 5, 5, 0.05


class PolicyError(ValueError):
    pass


@dataclass(frozen=True)
class TriggerPolicy:
    min_new_episodes: int = 30
    min_new_choice_scans: int = 20
    schedule_days: Optional[float] = None          # a scheduled window; only ever fires together with the dedup rule below
    min_new_cluster_fraction: float = 0.25          # share of the current snapshot's clusters that must be new

    def __post_init__(self):
        if self.min_new_episodes < FLOOR_EPISODES or self.min_new_choice_scans < FLOOR_CHOICE_SCANS:
            raise PolicyError(f"THRESHOLD_BELOW_FLOOR: episodes >= {FLOOR_EPISODES}, choice scans >= {FLOOR_CHOICE_SCANS} (training is never per-trade)")
        if self.min_new_cluster_fraction < FLOOR_NEW_CLUSTER_FRACTION:
            raise PolicyError(f"DEDUP_FRACTION_BELOW_FLOOR: >= {FLOOR_NEW_CLUSTER_FRACTION}")
        if self.schedule_days is not None and self.schedule_days <= 0:
            raise PolicyError("SCHEDULE_DAYS_MUST_BE_POSITIVE")


@dataclass(frozen=True)
class Stats:
    snapshot_version: str
    content_hash: str
    episodes: frozenset = field(default_factory=frozenset)
    clusters: frozenset = field(default_factory=frozenset)
    scans: frozenset = field(default_factory=frozenset)
    choice_scans: frozenset = field(default_factory=frozenset)   # scans with at least two candidates
    trained_at_ms: Optional[int] = None


def stats_from_snapshot(folder: str, trained_at_ms: Optional[int] = None) -> Stats:
    path = os.path.join(folder, "snapshot.sqlite3")
    with closing(sqlite3.connect("file:" + os.path.abspath(path).replace("\\", "/") + "?mode=ro", uri=True)) as c:
        meta = dict(c.execute("SELECT key, value FROM snapshot_meta"))
        rows = c.execute("SELECT scan_id, cluster_id, episode_id FROM snapshot_rows").fetchall()
    per_scan = Counter(r[0] for r in rows)
    return Stats(meta["version"], meta["content_hash"], frozenset(r[2] for r in rows), frozenset(r[1] for r in rows), frozenset(per_scan),
                 frozenset(s for s, n in per_scan.items() if n >= 2), trained_at_ms)


def decide(policy: TriggerPolicy, current: Stats, last: Optional[Stats], now_ms: int) -> dict:
    """{fire, reasons, blocked_by, ...counts}. Pure: no I/O, no clock."""
    base_eps, base_cl, base_choice = (last.episodes, last.clusters, last.choice_scans) if last else (frozenset(), frozenset(), frozenset())
    new_eps, new_choice = len(current.episodes - base_eps), len(current.choice_scans - base_choice)
    new_clusters = len(current.clusters - base_cl)
    frac = new_clusters / len(current.clusters) if current.clusters else 0.0
    reasons, blocked = [], []
    if new_eps >= policy.min_new_episodes:
        reasons.append("MIN_NEW_EPISODES")
    if new_choice >= policy.min_new_choice_scans:
        reasons.append("MIN_NEW_CHOICE_SCANS")
    if policy.schedule_days is not None and (last is None or last.trained_at_ms is None or now_ms - last.trained_at_ms >= policy.schedule_days * DAY_MS):
        reasons.append("SCHEDULED_WINDOW_ELAPSED")
    if last is not None and current.content_hash == last.content_hash:
        blocked.append("SAME_SNAPSHOT_AS_LAST_TRAINED")
    elif last is not None and reasons and frac < policy.min_new_cluster_fraction:
        blocked.append(f"NEAR_IDENTICAL_COMPOSITION: only {frac:.0%} of clusters are new (need {policy.min_new_cluster_fraction:.0%})")
    if not current.clusters:
        blocked.append("EMPTY_SNAPSHOT")
    fire = bool(reasons) and not blocked
    return {"fire": fire, "reasons": reasons if fire else [], "wanted_but_blocked": reasons if blocked else [], "blocked_by": blocked,
            "new_episodes": new_eps, "new_choice_scans": new_choice, "new_cluster_fraction": round(frac, 4),
            "policy": {"min_new_episodes": policy.min_new_episodes, "min_new_choice_scans": policy.min_new_choice_scans,
                       "schedule_days": policy.schedule_days, "min_new_cluster_fraction": policy.min_new_cluster_fraction}}
