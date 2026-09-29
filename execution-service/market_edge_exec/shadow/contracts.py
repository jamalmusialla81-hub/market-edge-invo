"""Versions, dataset names, the observation contract and the hindsight
leakage guard.

Every observation has two isolated sections:
  DECISION_TIME_DATA  -- only what was known at the scan timestamp T; written
                         once, hashed, never updated (SQLite triggers refuse).
  FUTURE_LABEL_DATA   -- written only after an evaluation window has closed,
                         in separate immutable label rows.

Anything describing the future (outcomes, excursions, "optimal" hindsight
labels, missed-opportunity classes) is a target/diagnostic field. The guard
below makes any attempt to use one as a model feature, or to smuggle one into
DECISION_TIME_DATA at ingest, fail loudly.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable

# v2 (DATA 1): source_commit on scans/observations, forward_execution_quality table.
# v3 (DATA 2): data_quality_verdicts (append-only validity verdicts).
# v4 (DATA 5): experiment_events (append-only experiment lifecycle). Additive only.
SHADOW_SCHEMA_VERSION = 7
LABEL_VERSION = "SHADOW-LABELS-V1"
CLASSIFICATION_VERSION = "SHADOW-CLASS-V1-DIAGNOSTIC"

# Separate research stores; never mixed silently (each is its own table and
# carries its own dataset_version on every row).
DATASET_RAW = "FORWARD-SHADOW-RAW-V1"
DATASET_RESOLVED = "FORWARD-SHADOW-RESOLVED-V1"
DATASET_PAPER_EXECUTED = "FORWARD-PAPER-EXECUTED-V1"

KIND_CANDIDATE = "CANDIDATE"
KIND_MARKET_STATE = "MARKET_STATE"
KINDS = (KIND_CANDIDATE, KIND_MARKET_STATE)

OUTCOME_VENUE = "HYPERLIQUID"
OUTCOME_INTERVAL = "5m"
BAR_MS = 5 * 60 * 1000
# The latest completed 5m candle must close within this of the scan, the same
# freshness rule the V2-CLEAN research data uses (assertFresh: 2 bars).
MAX_SNAPSHOT_AGE_MS = 2 * BAR_MS

HOUR = 3_600_000
MINUTE = 60_000
HORIZONS: dict[str, int] = {
    "15m": 15 * MINUTE, "30m": 30 * MINUTE, "1h": HOUR, "2h": 2 * HOUR, "4h": 4 * HOUR,
    "6h": 6 * HOUR, "12h": 12 * HOUR, "24h": 24 * HOUR, "48h": 48 * HOUR, "72h": 72 * HOUR,
}
# Horizons are written in batches, each once its longest window has closed;
# the final batch also carries the hindsight labels and the classification.
LABEL_BATCHES: dict[str, tuple[str, ...]] = {
    "B1": ("15m", "30m", "1h", "2h"),
    "B2": ("4h", "6h", "12h"),
    "B3": ("24h",),
    "B4": ("48h", "72h"),
}
FINAL_BATCH = "B4"
FULL_WINDOW_MS = HORIZONS["72h"]

# Clustering: correlated nearby observations are grouped so evaluation never
# treats every 5-minute row as independent.
CLUSTER_GAP_MS = 30 * MINUTE     # same asset/kind/direction/strategy within this -> same cluster
OVERLAP_WINDOW_MS = 4 * HOUR     # overlap_fraction is measured on this window
EPISODE_MS = 24 * HOUR           # market_episode_id = asset + UTC day

EXECUTION_STATUSES = ("EXECUTED", "REJECTED", "NOT_SUBMITTED", "NO_SIGNAL", "NOT_APPLICABLE")

# ---- leakage guard -------------------------------------------------------
# Exact names produced by the label builders (resolve.py registers every key
# it emits here at import time, and a test checks nothing escapes the set).
FUTURE_LABEL_KEYS: set[str] = set()
# Any field whose name says it describes the future is a target, never a
# feature, even if a future label builder forgets to register it.
HINDSIGHT_PATTERN = re.compile(
    r"(optimal|hindsight|best_achievable|best_direction|best_holding|mfe|mae|future|outcome|reali[sz]ed_(?!vol)|"
    r"classification|efficiency|excursion|time_to_|policy_|_hit$|hit_at|first_touch|label|resolved|"
    r"missed|opportunity|window_end|"
    # DATA 1: execution quality is only knowable after the fill (outcome/event data)
    r"execution_quality|latency_to_fill|stop_overshoot|entry_slippage_cost|exit_fills?|^fees$|"
    # exit-policy counterfactuals and giveback describe what happened after entry
    r"giveback|counterfactual_exit|counterfactual_r$|counterfactual_net|counterfactual_fees|counterfactual_slippage)", re.IGNORECASE)


class LeakageError(ValueError):
    """A hindsight/future field was offered where only decision-time data is allowed."""


def _flatten(value: Any, prefix: str = "") -> Iterable[str]:
    if isinstance(value, dict):
        for key, inner in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            yield path
            yield from _flatten(inner, path)


def is_hindsight_name(name: str) -> bool:
    leaf = name.rsplit(".", 1)[-1]
    return leaf in FUTURE_LABEL_KEYS or bool(HINDSIGHT_PATTERN.search(leaf))


def assert_decision_features(names: Iterable[str]) -> None:
    """Raises LeakageError if any feature name is a hindsight/future field.
    Every training/export path must call this on its feature columns."""
    bad = sorted({n for n in names if is_hindsight_name(n)})
    if bad:
        raise LeakageError(f"HINDSIGHT_FIELD_AS_FEATURE: {bad}")


def assert_decision_payload(decision: dict) -> None:
    """At ingest: DECISION_TIME_DATA may not contain any future/hindsight key."""
    bad = sorted({p for p in _flatten(decision) if is_hindsight_name(p)})
    if bad:
        raise LeakageError(f"HINDSIGHT_FIELD_IN_DECISION_TIME_DATA: {bad}")


# ---- hashing -------------------------------------------------------------
def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def observation_id(scan_id: str, kind: str, asset: str, direction: str | None, strategy: str | None) -> str:
    return "obs-" + content_hash([scan_id, kind, asset, direction or "", strategy or ""])[:24]
