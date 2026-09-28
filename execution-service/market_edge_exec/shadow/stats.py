"""Evaluation helpers that refuse to count correlated rows as independent.

Nearby shadow observations share most of their future window
(overlap_fraction), so the unit of evidence is the cluster / market episode /
scan, not the row. Means and bootstrap intervals here resample whole groups.
"""
from __future__ import annotations

import random
from collections import defaultdict
from typing import Callable, Iterable, Optional


def effective_sample(rows: list[dict], group_key: str = "cluster") -> dict:
    groups = {r[group_key] for r in rows}
    return {"rows": len(rows), "groups": len(groups), "group_key": group_key,
            "rows_per_group": round(len(rows) / len(groups), 3) if groups else None}


def group_means(rows: Iterable[dict], value: Callable[[dict], Optional[float]], group_key: str = "cluster") -> dict[str, float]:
    """One value per group (the group's mean), so a 60-row cluster counts once."""
    acc: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        v = value(r)
        if v is not None:
            acc[r[group_key]].append(v)
    return {g: sum(vs) / len(vs) for g, vs in acc.items()}


def grouped_bootstrap(rows: list[dict], value: Callable[[dict], Optional[float]], group_key: str = "cluster",
                      n: int = 2000, seed: int = 7, alpha: float = .05) -> dict:
    means = list(group_means(rows, value, group_key).values())
    if len(means) < 2:
        return {"groups": len(means), "mean": means[0] if means else None, "ci": None}
    rng = random.Random(seed)
    stats = sorted(sum(rng.choice(means) for _ in means) / len(means) for _ in range(n))
    return {"groups": len(means), "mean": sum(means) / len(means),
            "ci": [stats[int(alpha / 2 * n)], stats[int((1 - alpha / 2) * n) - 1]], "resampled_unit": group_key}
