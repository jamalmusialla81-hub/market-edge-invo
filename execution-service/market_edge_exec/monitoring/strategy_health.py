"""DATA 19: per-strategy health / degrade monitor. ALERT / FLAG ONLY.

Compares each strategy's recent window against the window before it, using
data the system already records: closed paper trades (outcome, exits, fees,
slippage, giveback via the trade-detail figure) and shadow observations
(frequency, rejection, production-pick share, quality score, regime).

The named future states NORMAL / REDUCED-RISK / SHADOW-ONLY / PAUSED are not
implemented: nothing here changes a strategy's state, risk or eligibility.
Any such transition belongs to the evidence-gated promotion/demotion path
(DATA 11) and needs explicit authorisation. The only write is the append-only
alert record shared with the drift monitor.

Tests used (one-sided, conventional cut-offs, not tuned):
  expectancy / slippage / giveback / score: Welch z on the difference of means
  stop rate, TP1 rate, rejection rate: two-proportion z
  drawdown: the recent window's max drawdown (in R) against the drawdowns that trades resampled from the
    baseline would produce over the same number of trades (fixed-seed bootstrap): FLAG above its 95th
    percentile, ALERT above the 99th, and only above an absolute floor of DD_FLOOR_R. A raw ratio of two
    windows fired on about a quarter of unchanged data, because max drawdown is very noisy.
  frequency: candidates per day ratio (FLAG only, never ALERT: a busier or quieter market is not a fault)
Several metrics are tested per strategy. Measured on 300 simulated unchanged strategies (42 trades per window),
about 17% of checks reached a strategy-level FLAG and about 1% reached ALERT: read a single FLAG as a prompt to look, and a repeated or multi-metric ALERT as the signal.
Outcome metrics need MIN_TRADES per window, observation metrics MIN_OBS; below that: INSUFFICIENT_DATA.
"""
from __future__ import annotations

import json
import math
import random
import sqlite3
from collections import defaultdict
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.paper.trade_detail import profit_giveback
from market_edge_exec.shadow.store import ShadowStore, _unblob

HEALTH_VERSION = "STRATEGY-HEALTH-V1"
ALERT_NAME, ALERT_VERSION = "strategy-health", 1
MIN_TRADES, MIN_OBS = 20, 30
Z_FLAG, Z_ALERT = 1.64, 2.33
DD_FLOOR_R, DD_BOOTSTRAPS, DD_FLAG_Q, DD_ALERT_Q = 3.0, 1000, 0.95, 0.99
SCORE_FLAG_SD, SCORE_ALERT_SD = 0.5, 1.0
FREQ_FLAG_RATIO = 2.0
REGIME_LOSS_R, REGIME_MIN_TRADES = -0.5, 10
DAY_MS = 86_400_000
LABEL = "RESEARCH ONLY · ALERT/FLAG ONLY · NO STRATEGY STATE IS CHANGED"
FUTURE_STATES = ("NORMAL", "REDUCED-RISK", "SHADOW-ONLY", "PAUSED")   # named only; DATA 11 owns any transition


def _mean(xs): return sum(xs) / len(xs) if xs else None


def _sd(xs):
    if len(xs) < 2:
        return None
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _welch_z(base: list[float], cur: list[float]) -> Optional[float]:
    """z of (cur - base); None when undefined."""
    sb, sc = _sd(base), _sd(cur)
    if sb is None or sc is None:
        return None
    se = math.sqrt(sb ** 2 / len(base) + sc ** 2 / len(cur))
    return (_mean(cur) - _mean(base)) / se if se > 0 else None


def _prop_z(base_hits: int, base_n: int, cur_hits: int, cur_n: int) -> Optional[float]:
    """z of (cur rate - base rate), pooled."""
    pooled = (base_hits + cur_hits) / (base_n + cur_n)
    se = math.sqrt(pooled * (1 - pooled) * (1 / base_n + 1 / cur_n))
    return ((cur_hits / cur_n) - (base_hits / base_n)) / se if se > 0 else None


def max_drawdown(rs: list[float]) -> float:
    peak = equity = worst = 0.0
    for r in rs:
        equity += r
        peak = max(peak, equity)
        worst = max(worst, peak - equity)
    return worst


def drawdown_null(baseline_r: list[float], n: int, seed: int = 20260929) -> list[float]:
    """Sorted max drawdowns of `n` trades resampled (with replacement) from the baseline; fixed seed, so a re-run is identical."""
    rng = random.Random(seed)
    return sorted(max_drawdown([rng.choice(baseline_r) for _ in range(n)]) for _ in range(DD_BOOTSTRAPS))


def _level(z: Optional[float], bad_when_negative: bool) -> str:
    if z is None:
        return "STABLE"
    bad = -z if bad_when_negative else z
    return "ALERT" if bad >= Z_ALERT else "FLAG" if bad >= Z_FLAG else "STABLE"


# ---- collection --------------------------------------------------------------------
def _ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:" + path.replace("\\", "/") + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def trade_record(trade: dict) -> Optional[dict]:
    """One closed paper trade reduced to the figures this monitor needs, taken from the trade's own fields."""
    risk, pnl = trade.get("risk_amount"), trade.get("realized_pnl")
    if trade.get("status") != "CLOSED" or not isinstance(risk, (int, float)) or risk <= 0 or not isinstance(pnl, (int, float)):
        return None
    entry, stop, best = trade.get("entry_fill"), trade.get("stop"), trade.get("best_price") or trade.get("entry_fill")
    mfe_r = None
    if isinstance(entry, (int, float)) and isinstance(stop, (int, float)) and abs(entry - stop) > 0 and isinstance(best, (int, float)):
        fav = (best - entry) if trade.get("direction") == "long" else (entry - best)
        mfe_r = fav / abs(entry - stop)
    give = None
    try:
        give = profit_giveback(trade, None, trade.get("closed_at_ms") or 0, mfe_r, None, risk).get("profit_giveback_r")
    except Exception:  # noqa: BLE001 -- a malformed trade is the quality gate's business
        give = None
    kinds = {str(e.get("kind")) for e in trade.get("exits") or []}
    return {"strategy": trade.get("strategy"), "closed_at_ms": trade.get("closed_at_ms"), "r": pnl / risk,
            "stop": bool(kinds & {"STOP", "BREAKEVEN_STOP"}) and "TP1" not in kinds,   # a stop out with no partial taken
            "tp1": "TP1" in kinds or bool(trade.get("tp1_hit")), "tp2": "TP2" in kinds,
            "slippage": trade.get("slippage_cost"), "giveback_r": give, "signal_id": trade.get("signal_id") or trade.get("trade_id")}


def collect(shadow: ShadowStore, paper_db_path: Optional[str], start_ms: int, end_ms: int) -> dict:
    """{'trades': {strategy: [records]}, 'obs': {strategy: [records]}, 'days': float} for [start_ms, end_ms)."""
    trades: dict[str, list[dict]] = defaultdict(list)
    obs: dict[str, list[dict]] = defaultdict(list)
    regime_of: dict[str, str] = {}
    with closing(shadow._connect()) as conn:
        for r in conn.execute("SELECT strategy, decision_ts, is_production_pick, execution_rejection_reason, decision FROM shadow_observations "
                              "WHERE kind='CANDIDATE' AND strategy IS NOT NULL AND decision_ts >= ? AND decision_ts < ?", (start_ms, end_ms)):
            try:
                cand = (_unblob(r["decision"]).get("candidate") or {})
            except Exception:  # noqa: BLE001
                cand = {}
            score = cand.get("quant_score") if isinstance(cand.get("quant_score"), (int, float)) else None
            obs[r["strategy"]].append({"pick": bool(r["is_production_pick"]), "rejected": bool(r["execution_rejection_reason"]), "score": score})
        for r in conn.execute("SELECT f.signal_id, o.decision FROM forward_paper_executed f JOIN shadow_observations o ON o.observation_id = f.observation_id"):
            try:
                regime = (_unblob(r["decision"]).get("candidate") or {}).get("regime")
            except Exception:  # noqa: BLE001
                regime = None
            if regime:
                regime_of[r["signal_id"]] = str(regime)
    if paper_db_path:
        with closing(_ro(paper_db_path)) as p:
            for row in p.execute("SELECT payload FROM paper_trades"):
                try:
                    trade = json.loads(row["payload"])
                except (TypeError, ValueError):
                    continue
                rec = trade_record(trade)
                if rec and rec["strategy"] and isinstance(rec["closed_at_ms"], int) and start_ms <= rec["closed_at_ms"] < end_ms:
                    rec["regime"] = regime_of.get(rec["signal_id"])
                    trades[rec["strategy"]].append(rec)
    for lst in trades.values():
        lst.sort(key=lambda t: t["closed_at_ms"])
    return {"trades": dict(trades), "obs": dict(obs), "days": max((end_ms - start_ms) / DAY_MS, 1e-9)}


# ---- comparison --------------------------------------------------------------------
def _finding(strategy: str, metric: str, level: str, **detail: Any) -> dict:
    return {"dimension": f"{strategy}|{metric}", "strategy": strategy, "metric": metric, "level": level, "statistic": detail.pop("statistic", None), **detail}


def compare_strategy(strategy: str, base: dict, cur: dict) -> list[dict]:
    out: list[dict] = []
    bt, ct = base["trades"].get(strategy, []), cur["trades"].get(strategy, [])
    if len(bt) >= MIN_TRADES and len(ct) >= MIN_TRADES:
        n = {"n_baseline": len(bt), "n_current": len(ct)}
        br, cr = [t["r"] for t in bt], [t["r"] for t in ct]
        out.append(_finding(strategy, "expectancy_R", _level(_welch_z(br, cr), True), statistic=_welch_z(br, cr), baseline=_mean(br), current=_mean(cr), **n))
        bd, cd = max_drawdown(br), max_drawdown(cr)
        null = drawdown_null(br, len(cr))
        p95, p99 = null[int(DD_FLAG_Q * len(null))], null[int(DD_ALERT_Q * len(null))]
        dd_level = "STABLE" if cd < DD_FLOOR_R else "ALERT" if cd > p99 else "FLAG" if cd > p95 else "STABLE"
        out.append(_finding(strategy, "drawdown_R", dd_level, statistic=(sum(1 for x in null if x < cd) / len(null)), baseline=bd, current=cd, null_p95=p95, null_p99=p99, **n))
        for metric, key, bad_neg in (("stop_rate", "stop", False), ("tp1_rate", "tp1", True), ("tp2_rate", "tp2", True)):
            bh, ch = sum(t[key] for t in bt), sum(t[key] for t in ct)
            z = _prop_z(bh, len(bt), ch, len(ct))
            out.append(_finding(strategy, metric, _level(z, bad_neg), statistic=z, baseline=bh / len(bt), current=ch / len(ct), **n))
        for metric, key, bad_neg in (("slippage", "slippage", False), ("giveback_R", "giveback_r", False)):
            b = [t[key] for t in bt if isinstance(t[key], (int, float))]
            c = [t[key] for t in ct if isinstance(t[key], (int, float))]
            if len(b) >= MIN_TRADES and len(c) >= MIN_TRADES:
                z = _welch_z(b, c)
                out.append(_finding(strategy, metric, _level(z, bad_neg), statistic=z, baseline=_mean(b), current=_mean(c), n_baseline=len(b), n_current=len(c)))
        # regime sensitivity: a regime where the recent expectancy is a clear loss (reported, not a state change)
        by_regime: dict[str, list[float]] = defaultdict(list)
        for t in ct:
            if t.get("regime"):
                by_regime[t["regime"]].append(t["r"])
        bad = {k: _mean(v) for k, v in by_regime.items() if len(v) >= REGIME_MIN_TRADES and _mean(v) <= REGIME_LOSS_R}
        if by_regime:
            out.append(_finding(strategy, "regime_sensitivity", "FLAG" if bad else "STABLE", statistic=None,
                                regimes={k: {"n": len(v), "mean_R": _mean(v)} for k, v in sorted(by_regime.items())}, losing_regimes=sorted(bad)))
    else:
        out.append(_finding(strategy, "outcomes", "INSUFFICIENT_DATA", n_baseline=len(bt), n_current=len(ct), needed=MIN_TRADES))

    bo, co = base["obs"].get(strategy, []), cur["obs"].get(strategy, [])
    if len(bo) >= MIN_OBS and len(co) >= MIN_OBS:
        n = {"n_baseline": len(bo), "n_current": len(co)}
        z = _prop_z(sum(o["rejected"] for o in bo), len(bo), sum(o["rejected"] for o in co), len(co))
        out.append(_finding(strategy, "rejection_rate", _level(z, False), statistic=z, baseline=sum(o["rejected"] for o in bo) / len(bo),
                            current=sum(o["rejected"] for o in co) / len(co), **n))
        bf, cf = len(bo) / base["days"], len(co) / cur["days"]
        ratio = max(bf, cf) / max(min(bf, cf), 1e-9)
        out.append(_finding(strategy, "frequency", "FLAG" if ratio >= FREQ_FLAG_RATIO else "STABLE", statistic=ratio, baseline=bf, current=cf, **n))
        bp, cp = sum(o["pick"] for o in bo) / len(bo), sum(o["pick"] for o in co) / len(co)
        out.append(_finding(strategy, "production_pick_share", "STABLE", statistic=None, baseline=bp, current=cp, **n))   # reported, not judged
        bs, cs = [o["score"] for o in bo if o["score"] is not None], [o["score"] for o in co if o["score"] is not None]
        if len(bs) >= MIN_OBS and len(cs) >= MIN_OBS and _sd(bs):
            drop = (_mean(bs) - _mean(cs)) / _sd(bs)   # decline in baseline-SD units
            out.append(_finding(strategy, "candidate_quality", "ALERT" if drop >= SCORE_ALERT_SD else "FLAG" if drop >= SCORE_FLAG_SD else "STABLE",
                                statistic=drop, baseline=_mean(bs), current=_mean(cs), n_baseline=len(bs), n_current=len(cs)))
    else:
        out.append(_finding(strategy, "candidates", "INSUFFICIENT_DATA", n_baseline=len(bo), n_current=len(co), needed=MIN_OBS))
    return out


GROUP = {"expectancy_R": "outcome", "drawdown_R": "outcome", "stop_rate": "exit_mix", "tp1_rate": "exit_mix", "tp2_rate": "exit_mix"}


def rollup(findings: list[dict]) -> dict:
    """{strategy: {action: NONE|FLAG|ALERT, alert_metrics, flag_metrics}}. `action` is advice for a human. No state is applied."""
    by: dict[str, list[dict]] = defaultdict(list)
    for f in findings:
        by[f["strategy"]].append(f)
    out = {}
    for s, fs in sorted(by.items()):
        alerts = [f["metric"] for f in fs if f["level"] == "ALERT"]
        flags = [f["metric"] for f in fs if f["level"] == "FLAG"]
        # Several metrics are tested per strategy, so one stray ALERT is expected now and then on unchanged data.
        # The strategy-level action is ALERT only when expectancy itself alerts or two or more unrelated metric groups alert together.
        # Related metrics count once (stop rate and TP1 rate are two views of the same exits).
        groups = {GROUP.get(m, m) for m in alerts}
        strong = "expectancy_R" in alerts or len(groups) >= 2
        out[s] = {"action": "ALERT" if strong else "FLAG" if (alerts or flags) else "NONE", "alert_metrics": alerts, "flag_metrics": flags,
                  "insufficient": [f["metric"] for f in fs if f["level"] == "INSUFFICIENT_DATA"]}
    return out


def run(shadow: ShadowStore, paper_db_path: Optional[str], now_ms: int, window_days: float = 14.0, baseline_days: float = 42.0) -> dict:
    cur_start = int(now_ms - window_days * DAY_MS)
    base_start = int(cur_start - baseline_days * DAY_MS)
    base, cur = collect(shadow, paper_db_path, base_start, cur_start), collect(shadow, paper_db_path, cur_start, now_ms)
    strategies = sorted(set(base["trades"]) | set(cur["trades"]) | set(base["obs"]) | set(cur["obs"]))
    findings = [f for s in strategies for f in compare_strategy(s, base, cur)]
    written = shadow.record_drift_alerts(ALERT_NAME, ALERT_VERSION, [{**f, "dimension": f["dimension"]} for f in findings], HEALTH_VERSION, now_ms)
    return {"label": LABEL, "health_version": HEALTH_VERSION, "future_states_named_only": list(FUTURE_STATES),
            "windows": {"baseline": [base_start, cur_start], "current": [cur_start, now_ms]},
            "thresholds": {"z_flag": Z_FLAG, "z_alert": Z_ALERT, "min_trades": MIN_TRADES, "min_observations": MIN_OBS},
            "strategies": rollup(findings), "findings": findings, "alert_rows_written": written}
