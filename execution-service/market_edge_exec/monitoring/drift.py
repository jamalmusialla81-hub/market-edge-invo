"""DATA 12: model / policy drift monitor. ALERT-ONLY.

One statistic throughout: the Population Stability Index,
    PSI = sum_i (cur_i - base_i) * ln(cur_i / base_i)
over baseline-decile bins (numeric) or categories (categorical), with a
1e-4 floor on each proportion. Conventional reading: < 0.10 stable,
0.10-0.25 moderate shift, > 0.25 major shift. Those cut-offs are the FLAG and
ALERT thresholds below; they are conventions, not tuned values. The level is
judged on PSI minus the sampling-noise floor (see noise_floor), otherwise
small windows of unchanged data would alert.

A dimension with fewer than MIN_SAMPLES on either side is INSUFFICIENT_DATA
and never raises anything, so thin data cannot produce a false alarm.

The only thing this module writes is its own append-only alert record.
"""
from __future__ import annotations

import json
import math
import sqlite3
from collections import Counter
from contextlib import closing
from typing import Any, Iterable, Optional

from market_edge_exec.monitoring import DRIFT_VERSION
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore, _unblob

MIN_SAMPLES = 30
FLAG_PSI, ALERT_PSI = 0.10, 0.25
RATE_FLAG_RATIO, RATE_ALERT_RATIO = 2.0, 4.0   # activity per day, either direction
EPS = 1e-4
N_BINS = 10
MAX_FEATURES = 60
LEVELS = ("STABLE", "FLAG", "ALERT")
COST_DIMENSIONS = ("cost.fees", "cost.entry_slippage", "cost.stop_overshoot", "cost.latency_ms")
DAY_MS = 86_400_000
LABEL = "RESEARCH ONLY · ALERT-ONLY · CHANGES NOTHING IN PRODUCTION"


# ---- the statistic -----------------------------------------------------------
def psi(base: Iterable[float], cur: Iterable[float]) -> float:
    base, cur = list(base), list(cur)
    total = 0.0
    for b, c in zip(base, cur):
        b, c = max(b, EPS), max(c, EPS)
        total += (c - b) * math.log(c / b)
    return total


def _edges(values: list[float]) -> list[float]:
    s = sorted(values)
    edges = sorted({s[min(len(s) - 1, int(len(s) * i / N_BINS))] for i in range(1, N_BINS)})
    return edges


def _bin_props(values: list[float], edges: list[float]) -> list[float]:
    counts = [0] * (len(edges) + 1)
    for v in values:
        i = 0
        while i < len(edges) and v > edges[i]:
            i += 1
        counts[i] += 1
    n = len(values) or 1
    return [c / n for c in counts]


def _cat_props(values: list[str], cats: list[str]) -> list[float]:
    counts = Counter(values)
    n = len(values) or 1
    other = sum(v for k, v in counts.items() if k not in cats)
    return [counts.get(k, 0) / n for k in cats] + [other / n]


def noise_floor(k: int, n_base: int, n_cur: int) -> float:
    """Expected PSI between two samples of the SAME distribution: (k-1)(1/n_base + 1/n_cur). With 100 rows a side
    and 10 bins that is already ~0.18, above the usual 0.10 cut-off, so the level is judged on PSI minus this floor."""
    return max(k - 1, 0) * (1 / max(n_base, 1) + 1 / max(n_cur, 1))


def level_of(value: float) -> str:
    return "ALERT" if value > ALERT_PSI else "FLAG" if value > FLAG_PSI else "STABLE"


# ---- collecting a window --------------------------------------------------------
def _numeric_leaves(node: Any, path: str = "") -> Iterable[tuple[str, float]]:
    if isinstance(node, bool):
        return
    if isinstance(node, (int, float)):
        if math.isfinite(node):
            yield path, float(node)
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _numeric_leaves(v, f"{path}.{k}" if path else str(k))


def _ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:" + path.replace("\\", "/") + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def collect(shadow: ShadowStore, paper_db_path: Optional[str], start_ms: int, end_ms: int) -> dict:
    """{'numeric': {name: [floats]}, 'categorical': {name: [str]}, 'activity': {name: count}, 'days': float}
    for records timestamped in [start_ms, end_ms)."""
    numeric: dict[str, list[float]] = {}
    cat: dict[str, list[str]] = {"asset_mix": [], "strategy_mix": [], "rejection_reason": [], "outcome": [], "exit_reason": []}
    activity: Counter = Counter()

    def add(name: str, value: Any) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            numeric.setdefault(name, []).append(float(value))

    with closing(shadow._connect()) as conn:
        for r in conn.execute("SELECT * FROM shadow_observations WHERE decision_ts >= ? AND decision_ts < ?", (start_ms, end_ms)):
            activity["observations"] += 1
            cat["asset_mix"].append(r["asset"])
            if r["strategy"]:
                cat["strategy_mix"].append(r["strategy"])
                activity["strategy:" + r["strategy"]] += 1
            if r["execution_rejection_reason"]:
                cat["rejection_reason"].append(r["execution_rejection_reason"])
            try:
                decision = _unblob(r["decision"])
            except Exception:  # noqa: BLE001 -- unreadable rows are the quality gate's business, not drift's
                continue
            candidate = decision.get("candidate") or {}
            for key in ("quant_score", "score"):
                for holder in (decision, candidate):
                    if isinstance(holder.get(key), (int, float)):
                        add("score", holder[key])
                        break
                else:
                    continue
                break
            for path, value in _numeric_leaves(decision.get("features") or {}):
                name = "feature." + path
                add(name, value)
                if any(t in path.lower() for t in ("atr", "vol")):
                    add("volatility." + path, value)
        for r in conn.execute("SELECT record FROM forward_execution_quality"):
            q = _unblob(r["record"])
            closed = q.get("closed_at_ms")
            if not isinstance(closed, int) or not start_ms <= closed < end_ms:
                continue
            activity["closed_trades"] += 1
            add("cost.fees", q.get("fees"))
            add("cost.entry_slippage", q.get("entry_slippage_cost"))
            add("cost.latency_ms", q.get("latency_to_fill_ms"))
            over = [o["overshoot"] for o in q.get("stop_overshoot") or [] if isinstance(o.get("overshoot"), (int, float))]
            if over:
                add("cost.stop_overshoot", max(over))
            if q.get("exit_reason"):
                cat["exit_reason"].append(str(q["exit_reason"]))
    if paper_db_path:
        with closing(_ro(paper_db_path)) as p:
            for r in p.execute("SELECT payload FROM paper_trades"):
                try:
                    t = json.loads(r["payload"])
                except (TypeError, ValueError):
                    continue
                closed = t.get("closed_at_ms")
                if t.get("status") != "CLOSED" or not isinstance(closed, int) or not start_ms <= closed < end_ms:
                    continue
                pnl, risk = t.get("realized_pnl"), t.get("risk_amount")
                if isinstance(pnl, (int, float)) and isinstance(risk, (int, float)) and risk > 0:
                    add("realized_r", pnl / risk)
                    cat["outcome"].append("WIN" if pnl > 0 else "LOSS" if pnl < 0 else "FLAT")
    numeric = {k: v for k, v in numeric.items() if not k.startswith("feature.")
               or k in dict(Counter({n: len(v) for n, v in numeric.items() if n.startswith("feature.")}).most_common(MAX_FEATURES))}
    return {"numeric": numeric, "categorical": {k: v for k, v in cat.items() if v}, "activity": dict(activity),
            "days": max((end_ms - start_ms) / DAY_MS, 1e-9)}


# ---- baselines ---------------------------------------------------------------
def make_profile(window: dict) -> dict:
    """What is stored for a named baseline: bin edges and proportions, so a later comparison
    needs no raw rows."""
    numeric = {}
    for name, values in window["numeric"].items():
        if len(values) >= MIN_SAMPLES:
            edges = _edges(values)
            numeric[name] = {"n": len(values), "edges": edges, "props": _bin_props(values, edges)}
    categorical = {}
    for name, values in window["categorical"].items():
        if len(values) >= MIN_SAMPLES:
            cats = sorted(set(values))
            categorical[name] = {"n": len(values), "cats": cats, "props": _cat_props(values, cats)}
    return {"numeric": numeric, "categorical": categorical,
            "activity_per_day": {k: v / window["days"] for k, v in window["activity"].items()},
            "sample_counts": {**{k: len(v) for k, v in window["numeric"].items()}, **{k: len(v) for k, v in window["categorical"].items()}}}


def compare(profile: dict, window: dict) -> list[dict]:
    """One finding per dimension: {dimension, kind, statistic, level, n_baseline, n_current}."""
    out: list[dict] = []
    for name, base in sorted(profile["numeric"].items()):
        cur = window["numeric"].get(name, [])
        if len(cur) < MIN_SAMPLES:
            out.append({"dimension": name, "kind": "NUMERIC", "statistic": None, "level": "INSUFFICIENT_DATA", "n_baseline": base["n"], "n_current": len(cur)})
            continue
        value = psi(base["props"], _bin_props(cur, base["edges"]))
        floor = noise_floor(len(base["props"]), base["n"], len(cur))
        out.append({"dimension": name, "kind": "NUMERIC", "statistic": round(value, 6), "noise_floor": round(floor, 6), "level": level_of(value - floor),
                    "n_baseline": base["n"], "n_current": len(cur)})
    for name, base in sorted(profile["categorical"].items()):
        cur = window["categorical"].get(name, [])
        if len(cur) < MIN_SAMPLES:
            out.append({"dimension": name, "kind": "CATEGORICAL", "statistic": None, "level": "INSUFFICIENT_DATA", "n_baseline": base["n"], "n_current": len(cur)})
            continue
        value = psi(base["props"], _cat_props(cur, base["cats"]))
        floor = noise_floor(len(base["props"]), base["n"], len(cur))
        out.append({"dimension": name, "kind": "CATEGORICAL", "statistic": round(value, 6), "noise_floor": round(floor, 6), "level": level_of(value - floor),
                    "n_baseline": base["n"], "n_current": len(cur)})
    for name, rate in sorted(profile["activity_per_day"].items()):
        cur_rate = window["activity"].get(name, 0) / window["days"]
        if rate * window["days"] < MIN_SAMPLES / 3:   # too quiet a baseline for a rate ratio to mean anything
            continue
        ratio = max(cur_rate, 1e-9) / rate if cur_rate >= rate else rate / max(cur_rate, 1e-9)
        level = "ALERT" if ratio >= RATE_ALERT_RATIO else "FLAG" if ratio >= RATE_FLAG_RATIO else "STABLE"
        out.append({"dimension": "activity." + name, "kind": "RATE", "statistic": round(ratio, 4), "level": level,
                    "n_baseline": None, "n_current": window["activity"].get(name, 0)})
    return out


def recommendation(findings: list[dict]) -> dict:
    """ALERT / FLAG / RECOMMEND_REVIEW / NONE. RECOMMEND_REVIEW: an execution-cost dimension is in ALERT, or three or more dimensions are."""
    alerts = [f for f in findings if f["level"] == "ALERT"]
    flags = [f for f in findings if f["level"] == "FLAG"]
    cost_alert = [f["dimension"] for f in alerts if f["dimension"] in COST_DIMENSIONS]
    if cost_alert or len(alerts) >= 3:
        status = "RECOMMEND_REVIEW"
    elif alerts:
        status = "ALERT"
    elif flags:
        status = "FLAG"
    else:
        status = "NONE"
    return {"status": status, "alert_dimensions": [f["dimension"] for f in alerts], "flag_dimensions": [f["dimension"] for f in flags],
            "insufficient_dimensions": [f["dimension"] for f in findings if f["level"] == "INSUFFICIENT_DATA"]}


# ---- persistence (the only writes) -----------------------------------------------
def create_baseline(shadow: ShadowStore, paper_db_path: Optional[str], name: str, start_ms: int, end_ms: int, now_ms: Optional[int] = None) -> dict:
    if not name or end_ms <= start_ms:
        raise ValueError("BASELINE_NEEDS_NAME_AND_A_POSITIVE_WINDOW")
    profile = make_profile(collect(shadow, paper_db_path, start_ms, end_ms))
    if not profile["numeric"] and not profile["categorical"]:
        raise ValueError("BASELINE_WINDOW_HAS_TOO_FEW_RECORDS")
    return shadow.record_drift_baseline(name, start_ms, end_ms, profile, DRIFT_VERSION, now_ms)


def run(shadow: ShadowStore, paper_db_path: Optional[str], name: str, version: Optional[int], window_days: float, now_ms: int) -> dict:
    baseline = shadow.drift_baseline(name, version)
    if baseline is None:
        raise KeyError("BASELINE_NOT_FOUND")
    start = int(now_ms - window_days * DAY_MS)
    window = collect(shadow, paper_db_path, start, now_ms)
    findings = compare(baseline["profile"], window)
    rec = recommendation(findings)
    written = shadow.record_drift_alerts(baseline["name"], baseline["version"], findings, DRIFT_VERSION, now_ms)
    return {"label": LABEL, "drift_version": DRIFT_VERSION, "baseline": {k: baseline[k] for k in ("name", "version", "window_start_ms", "window_end_ms")},
            "current_window": {"start_ms": start, "end_ms": now_ms}, "thresholds": {"flag_psi": FLAG_PSI, "alert_psi": ALERT_PSI, "min_samples": MIN_SAMPLES},
            "recommendation": rec, "findings": findings, "alert_rows_written": written}
