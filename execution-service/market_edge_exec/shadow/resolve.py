"""Counterfactual and hindsight labels for shadow observations. Pure
functions only: candles in, label dicts out. No I/O, no ledger, no router.

Anchoring (same for every observation):
  T           the scan timestamp (decision time)
  first bar   the first 5m bar opening at or after T -- nothing can be acted
              on before it (minimum reaction delay = the rest of the bar)
  p0          that bar's open: the executable reference price
  window h    bars opening in [first bar, T + h); a horizon is labelled only
              once its last bar has closed and every bar in it is present.
              A missing bar makes the horizon UNRESOLVED -- never filled,
              never taken from another venue, never from a cache.

CURRENT_POLICY_OUTCOME reuses paper.lifecycle.advance -- the exact exit
rules paper execution uses (stop-first when a bar spans stop and target,
50% at TP1 then breakeven, TP2) with the same fee and slippage per side.
"""
from __future__ import annotations

import math
from typing import Optional

from market_edge_exec.paper import lifecycle
from market_edge_exec.shadow import contracts as C

GOOD_R = 0.5    # CURRENT_POLICY R at or above this after costs: a good trade
BAD_R = -0.5    # at or below this: a bad trade; in between: AMBIGUOUS
OPPORTUNITY_WINDOW_MS = 24 * C.HOUR
OPPORTUNITY_STOP_ATR = 1.5      # no-trade opportunity test: stop at 1.5x 1h ATR...
OPPORTUNITY_TARGET_UNITS = 2.0  # ...and a +2 units move reached before that stop


def _reg(d: dict) -> dict:
    """Every key a label builder emits is registered as a future-label key,
    so the leakage guard knows it even without a matching name pattern."""
    C.FUTURE_LABEL_KEYS.update(d.keys())
    return d


def _r(x: Optional[float], nd: int = 8) -> Optional[float]:
    return None if x is None or not math.isfinite(x) else round(x, nd)


def first_bar_open(decision_ts: int) -> int:
    return -(-decision_ts // C.BAR_MS) * C.BAR_MS


def window_bars(candles_by_time: dict[int, dict], decision_ts: int, horizon_ms: int, now_ms: int):
    """Returns ("DUE_NOT_CLOSED", None) until the horizon's last bar has
    closed; then ("OK", bars) or ("UNRESOLVED_MISSING_CANDLE", n_missing)."""
    start, end = first_bar_open(decision_ts), decision_ts + horizon_ms
    opens = list(range(start, end, C.BAR_MS))
    if not opens or opens[-1] + C.BAR_MS > now_ms:
        return "DUE_NOT_CLOSED", None
    bars = [candles_by_time.get(t) for t in opens]
    missing = sum(1 for b in bars if b is None)
    if missing:
        return "UNRESOLVED_MISSING_CANDLE", missing
    return "OK", bars


def _path_vol(bars: list[dict]) -> Optional[float]:
    closes = [bars[0]["open"]] + [b["close"] for b in bars]
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]
    if len(rets) < 2:
        return None
    m = sum(rets) / len(rets)
    return math.sqrt(sum((r - m) ** 2 for r in rets) / len(rets))


def _extreme(bars: list[dict], key: str, pick) -> tuple[float, int]:
    value = pick(b[key] for b in bars)
    at = next(b["time"] for b in bars if b[key] == value)
    return value, at


def excursion_path(bars: list[dict], p0: float) -> list[list]:
    """Hourly [hour, high_ret, low_ret, close_ret] relative to p0."""
    out, per = [], C.HOUR // C.BAR_MS
    for i in range(0, len(bars), per):
        chunk = bars[i:i + per]
        out.append([i // per, _r(max(b["high"] for b in chunk) / p0 - 1, 6),
                    _r(min(b["low"] for b in chunk) / p0 - 1, 6), _r(chunk[-1]["close"] / p0 - 1, 6)])
    return out


def touches(bars: list[dict], long: bool, stop: Optional[float], tp1: Optional[float], tp2: Optional[float]) -> dict:
    first: dict[str, Optional[int]] = {"STOP": None, "TP1": None, "TP2": None}
    for b in bars:
        for name, level in (("STOP", stop), ("TP1", tp1), ("TP2", tp2)):
            if level is None or first[name] is not None:
                continue
            hit = (b["low"] <= level if long else b["high"] >= level) if name == "STOP" else (b["high"] >= level if long else b["low"] <= level)
            if hit:
                first[name] = b["time"]
    hits = sorted((t, n) for n, t in first.items() if t is not None)
    if not hits:
        order = "NONE"
    elif first["STOP"] is not None and first["TP1"] is not None and first["STOP"] == first["TP1"] == hits[0][0]:
        order = "STOP_TP1_SAME_BAR_AMBIGUOUS"   # stop-first is assumed, the ambiguity is kept
    else:
        order = ">".join(n for _, n in hits)
    return {"stop_hit": first["STOP"] is not None, "tp1_hit": first["TP1"] is not None, "tp2_hit": first["TP2"] is not None,
            "stop_hit_at": first["STOP"], "tp1_hit_at": first["TP1"], "tp2_hit_at": first["TP2"], "first_touch_order": order,
            "stop_tp_same_bar_ambiguous": order == "STOP_TP1_SAME_BAR_AMBIGUOUS"}


def current_policy(direction: str, stop: float, tp1: Optional[float], tp2: Optional[float], bars: list[dict], end_ms: int) -> dict:
    """What paper execution's own rules would have produced, entering at the
    first bar open with slippage, costs included, in R of that entry's risk."""
    long = direction == "long"
    entry_fill = lifecycle.slipped(bars[0]["open"], "buy" if long else "sell")
    risk_unit = (entry_fill - stop) if long else (stop - entry_fill)
    if not risk_unit > 0:
        return {"policy_status": "INVALID_AT_ENTRY_STOP_BREACHED", "policy_r": None, "policy_entry_fill": _r(entry_fill), "policy_risk_unit": None}
    events = lifecycle.advance(direction, entry_fill, stop, tp1, tp2, 1.0, 1.0, False, bars[0]["time"], bars, end_ms)
    pnl, fees, left = 0.0, lifecycle.fee(entry_fill, 1.0), 1.0
    for e in events:
        pnl += lifecycle.pnl(direction, entry_fill, e.fill_price, e.quantity)
        fees += lifecycle.fee(e.fill_price, e.quantity)
        left -= e.quantity
    status = f"CLOSED_{events[-1].kind}" if events and left <= 1e-9 else "OPEN_AT_HORIZON"
    if left > 1e-9:   # marked to the window's last close, as an exit would fill
        mtm = lifecycle.slipped(bars[-1]["close"], lifecycle.exit_side(direction))
        pnl += lifecycle.pnl(direction, entry_fill, mtm, left)
        fees += lifecycle.fee(mtm, left)
    return {"policy_status": status, "policy_r": _r((pnl - fees) / risk_unit, 6), "policy_entry_fill": _r(entry_fill),
            "policy_risk_unit": _r(risk_unit), "policy_exits": [e.kind for e in events]}


def candidate_horizon(decision: dict, bars: list[dict], decision_ts: int, horizon_ms: int) -> dict:
    cand = decision["candidate"]
    long = cand["direction"] == "long"
    p0 = bars[0]["open"]
    hi, hi_at = _extreme(bars, "high", max)
    lo, lo_at = _extreme(bars, "low", min)
    fav, fav_at, adv, adv_at = ((hi - p0), hi_at, (p0 - lo), lo_at) if long else ((p0 - lo), lo_at, (hi - p0), hi_at)
    policy = current_policy(cand["direction"], cand["stop"], cand.get("tp1"), cand.get("tp2"), bars, decision_ts + horizon_ms)
    unit = policy.get("policy_risk_unit")
    out = {"reference_open": _r(p0), "mfe_pct": _r(fav / p0, 6), "mae_pct": _r(adv / p0, 6),
           "mfe_r": _r(fav / unit, 4) if unit else None, "mae_r": _r(adv / unit, 4) if unit else None,
           "time_to_mfe_ms": fav_at - bars[0]["time"], "time_to_mae_ms": adv_at - bars[0]["time"],
           "forward_return_pct": _r(bars[-1]["close"] / p0 - 1, 6), "path_volatility": _r(_path_vol(bars), 8),
           **touches(bars, long, cand["stop"], cand.get("tp1"), cand.get("tp2")), **policy}
    return _reg(out)


def market_state_horizon(bars: list[dict], decision_ts: int, horizon_ms: int) -> dict:
    p0 = bars[0]["open"]
    hi, hi_at = _extreme(bars, "high", max)
    lo, lo_at = _extreme(bars, "low", min)
    return _reg({"reference_open": _r(p0), "up_excursion_pct": _r(hi / p0 - 1, 6), "down_excursion_pct": _r(1 - lo / p0, 6),
                 "time_to_high_ms": hi_at - bars[0]["time"], "time_to_low_ms": lo_at - bars[0]["time"],
                 "forward_return_pct": _r(bars[-1]["close"] / p0 - 1, 6), "path_volatility": _r(_path_vol(bars), 8)})


# ---- hindsight (POST-OUTCOME RESEARCH ONLY) --------------------------------
def _net_long(entry: float, exit_: float) -> float:
    return exit_ * (1 - lifecycle.SLIPPAGE_PCT) / (entry * (1 + lifecycle.SLIPPAGE_PCT)) - 1 - 2 * lifecycle.FEE_PCT


def _net_short(entry: float, exit_: float) -> float:
    e, x = entry * (1 - lifecycle.SLIPPAGE_PCT), exit_ * (1 + lifecycle.SLIPPAGE_PCT)
    return (e - x) / e - 2 * lifecycle.FEE_PCT


def theoretical(bars: list[dict]) -> dict:
    """OPTIMAL_THEORETICAL: absolute upper bound -- buy the lowest tick, sell
    the highest later tick (bar extremes), no costs. Not tradable."""
    best_l = best_s = -math.inf
    lo = hi = None
    for b in bars:
        lo = b if lo is None or b["low"] < lo["low"] else lo
        hi = b if hi is None or b["high"] > hi["high"] else hi
        if (m := b["high"] / lo["low"] - 1) > best_l:
            best_l, l_pair = m, (lo, b)
        if (m := 1 - b["low"] / hi["high"]) > best_s:
            best_s, s_pair = m, (hi, b)
    return {"theoretical_long_move_pct": _r(best_l, 6), "theoretical_long_entry": _r(l_pair[0]["low"]), "theoretical_long_exit": _r(l_pair[1]["high"]),
            "theoretical_short_move_pct": _r(best_s, 6), "theoretical_short_entry": _r(s_pair[0]["high"]), "theoretical_short_exit": _r(s_pair[1]["low"])}


def executable(bars: list[dict]) -> dict:
    """OPTIMAL_EXECUTABLE: entries and exits only at bar opens (or the last
    close) at or after the first bar, adverse slippage and fees both sides.
    Still hindsight about *timing* -- an upper bound on what was achievable
    with real fills, not something any rule could have known."""
    points = [(b["time"], b["open"]) for b in bars] + [(bars[-1]["time"] + C.BAR_MS, bars[-1]["close"])]
    best = {"long": (-math.inf, None, None), "short": (-math.inf, None, None)}
    min_i = max_i = 0
    for j in range(1, len(points)):
        if (v := _net_long(points[min_i][1], points[j][1])) > best["long"][0]:
            best["long"] = (v, min_i, j)
        if (v := _net_short(points[max_i][1], points[j][1])) > best["short"][0]:
            best["short"] = (v, max_i, j)
        min_i = j if points[j][1] < points[min_i][1] else min_i
        max_i = j if points[j][1] > points[max_i][1] else max_i
    out = {}
    for side, (v, i, j) in best.items():
        entry, exit_ = points[i][1], points[j][1]
        held = bars[i:j] or bars[i:i + 1]
        stop = min(b["low"] for b in held) if side == "long" else max(b["high"] for b in held)
        dist = (entry - stop) if side == "long" else (stop - entry)
        out.update({f"optimal_{side}_entry": _r(entry), f"optimal_{side}_exit": _r(exit_), f"optimal_{side}_net_pct": _r(v, 6),
                    f"optimal_{side}_entry_at": points[i][0], f"optimal_{side}_exit_at": points[j][0],
                    f"optimal_{side}_stop": _r(stop), f"optimal_{side}_r": _r(v * entry / dist, 4) if dist > 0 else None})
    side = "long" if out["optimal_long_net_pct"] >= out["optimal_short_net_pct"] else "short"
    out.update({"best_direction": side if out[f"optimal_{side}_net_pct"] > 0 else "NONE",
                "optimal_entry": out[f"optimal_{side}_entry"], "optimal_exit": out[f"optimal_{side}_exit"],
                "optimal_stop": out[f"optimal_{side}_stop"], "best_achievable_r": out[f"optimal_{side}_r"],
                "time_of_optimal_entry": out[f"optimal_{side}_entry_at"], "time_of_optimal_exit": out[f"optimal_{side}_exit_at"],
                "best_holding_time_ms": out[f"optimal_{side}_exit_at"] - out[f"optimal_{side}_entry_at"]})
    return out


def candidate_hindsight(decision: dict, bars: list[dict]) -> dict:
    """Candidate-specific, entry fixed at the first bar in the candidate's
    direction: the best exit reachable before the proposed stop (stop-first
    on ambiguous bars) and the best exit ignoring the stop."""
    cand = decision["candidate"]
    long = cand["direction"] == "long"
    entry_fill = lifecycle.slipped(bars[0]["open"], "buy" if long else "sell")
    unit = (entry_fill - cand["stop"]) if long else (cand["stop"] - entry_fill)
    net = _net_long if long else _net_short
    best_within = best_any = None
    stopped = False
    for i, b in enumerate(bars):
        fav = b["high"] if long else b["low"]
        stop_hit = b["low"] <= cand["stop"] if long else b["high"] >= cand["stop"]
        if not stopped and not stop_hit:
            best_within = fav if best_within is None or (fav > best_within if long else fav < best_within) else best_within
        stopped = stopped or stop_hit
        best_any = fav if best_any is None or (fav > best_any if long else fav < best_any) else best_any
    p0 = bars[0]["open"]
    exec_within = net(p0, best_within) if best_within is not None else None
    return {"optimal_tp1": _r(best_within), "optimal_tp2": _r(best_any),
            "executable_within_stop_r": _r(exec_within * p0 / unit, 4) if exec_within is not None and unit > 0 else None,
            "executable_any_exit_r": _r(net(p0, best_any) * p0 / unit, 4) if unit > 0 else None}


def atr_opportunity(bars: list[dict], atr_h1: Optional[float]) -> dict:
    """Normalised opportunity for any observation (incl. NO_TRADE states):
    from the first bar open, did price reach +2 units before -1 unit, where
    1 unit = 1.5 x the 1h ATR known at decision time? Same-bar => not counted."""
    if not atr_h1 or atr_h1 <= 0:
        return {"opportunity_unit": None, "long_opportunity": None, "short_opportunity": None}
    p0, u = bars[0]["open"], OPPORTUNITY_STOP_ATR * atr_h1
    horizon = [b for b in bars if b["time"] < bars[0]["time"] + OPPORTUNITY_WINDOW_MS]

    def reached(long: bool) -> bool:
        target, stop = (p0 + OPPORTUNITY_TARGET_UNITS * u, p0 - u) if long else (p0 - OPPORTUNITY_TARGET_UNITS * u, p0 + u)
        for b in horizon:
            s = b["low"] <= stop if long else b["high"] >= stop
            t = b["high"] >= target if long else b["low"] <= target
            if s:
                return False
            if t:
                return True
        return False
    return {"opportunity_unit": _r(u), "long_opportunity": reached(True), "short_opportunity": reached(False)}


def classify(kind: str, execution_status: str, production_state: Optional[str], final_label: Optional[dict], opp: dict) -> str:
    """Diagnostic only (CLASSIFICATION_VERSION); never a training target
    until validated."""
    if kind == C.KIND_CANDIDATE:
        r = (final_label or {}).get("policy_r")
        if r is None:
            return "AMBIGUOUS"
        decisive = (final_label or {}).get("stop_tp_same_bar_ambiguous")
        taken = execution_status == "EXECUTED"
        if decisive or BAD_R < r < GOOD_R:
            return "AMBIGUOUS"
        if r >= GOOD_R:
            return "GOOD_TRADE_TAKEN" if taken else "GOOD_TRADE_MISSED"
        return "BAD_TRADE_TAKEN" if taken else "BAD_TRADE_AVOIDED"
    present = bool(opp.get("long_opportunity") or opp.get("short_opportunity"))
    if production_state == "NO_TRADE":
        return "MISSED_OPPORTUNITY" if present else "NO_TRADE_CORRECT"
    return "OPPORTUNITY_PRESENT" if present else "NO_REAL_OPPORTUNITY"


def hindsight(kind: str, decision: dict, bars: list[dict], execution_status: str, final_label: Optional[dict]) -> dict:
    opp = atr_opportunity(bars, (decision.get("features") or {}).get("h1", {}).get("atr"))
    out = {"window_ms_used": bars[-1]["time"] + C.BAR_MS - bars[0]["time"], **theoretical(bars), **executable(bars), **opp}
    if kind == C.KIND_CANDIDATE:
        out.update(candidate_hindsight(decision, bars))
        pol = (final_label or {}).get("policy_r")
        within = out.get("executable_within_stop_r")
        out["current_policy_outcome_r"] = pol
        out["strategy_efficiency"] = _r(pol / within, 4) if pol is not None and within and within > 0 else None
    out["classification"] = classify(kind, execution_status, decision.get("production_state"), final_label, opp)
    out["classification_version"] = C.CLASSIFICATION_VERSION
    out["classification_status"] = "DIAGNOSTIC_UNVALIDATED"
    return _reg(out)


def _register_all_keys() -> None:
    """Run every builder once on a synthetic path at import so the full key
    set is registered before any guard check (not only after a resolution)."""
    bars = [{"time": i * C.BAR_MS, "open": 100 + i * .1, "high": 100.5 + i * .1, "low": 99.5 + i * .1, "close": 100.05 + i * .1} for i in range(24)]
    decision = {"candidate": {"direction": "long", "stop": 95.0, "tp1": 101.0, "tp2": 102.0}, "features": {"h1": {"atr": 0.5}}}
    final = candidate_horizon(decision, bars, 0, 24 * C.BAR_MS)
    market_state_horizon(bars, 0, 24 * C.BAR_MS)
    hindsight(C.KIND_CANDIDATE, decision, bars, "EXECUTED", final)
    hindsight(C.KIND_MARKET_STATE, {"features": {"h1": {"atr": .5}}, "production_state": "NO_TRADE"}, bars, "NOT_APPLICABLE", None)
    C.FUTURE_LABEL_KEYS.update({"excursion_path", "label_status", "missing_bars", "horizon_ms", "window_end_ts"})


_register_all_keys()
