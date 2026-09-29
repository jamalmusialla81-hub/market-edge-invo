"""Read-only Trade Detail view for the desktop app: live position metrics,
the ORIGINAL decision-time record, chart levels/markers, and an optional
post-outcome (hindsight) research overlay kept strictly separate.

Everything is derived from the ledger on each call; nothing here writes.
The decision-time block is built only from what was persisted when the trade
opened (the trade row and the EXECUTED signal payload) -- later research can
never change it, because hindsight lives in its own table and its own key.
"""
from __future__ import annotations

from typing import Optional

from market_edge_exec.paper import lifecycle
from market_edge_exec.paper.engine import MONITOR_LIVE, MONITOR_OFFLINE, MONITOR_STALE, freshest_price
from market_edge_exec.paper.ledger import PaperLedger

HINDSIGHT_LABEL = "POST-OUTCOME / HINDSIGHT - computed after the trade resolved; the live model did not know this"
HINDSIGHT_FIELDS = ("optimal_entry", "optimal_tp1", "optimal_tp2", "optimal_exit")


def _pct(delta: float, base: float) -> Optional[float]:
    return delta / base * 100 if base else None


def monitor_status(trade: dict, now_ms: int, max_age_s: float) -> dict:
    """LIVE only while the latest real price is younger than the monitor's
    freshness limit. An explicit offline flag wins; otherwise age decides."""
    price, at_ms, source = freshest_price(trade)
    age_s = (now_ms - at_ms) / 1000.0 if at_ms else None
    status = trade.get("monitor_status")
    if trade["status"] == "CLOSED":
        status = "CLOSED"
    elif status == MONITOR_OFFLINE:
        pass
    elif age_s is None:
        status = "AWAITING_PRICE"
    elif age_s > max_age_s:
        status = MONITOR_STALE
    else:
        status = MONITOR_LIVE
    return {"status": status, "detail": trade.get("monitor_detail"), "price": price, "price_at_ms": at_ms,
            "price_source": source, "price_age_s": age_s, "max_price_age_s": max_age_s}


def live_metrics(trade: dict, now_ms: int, max_age_s: float) -> dict:
    """Current price, unrealized PnL/R, distances to stop/TP1/TP2, MFE/MAE and
    position age. Distances are signed room left: positive = level not yet
    reached, in the trade's own direction."""
    mon = monitor_status(trade, now_ms, max_age_s)
    long = trade["direction"] == "long"
    entry, risk = trade["entry_fill"], trade.get("risk_amount") or 0.0
    price = mon["price"]
    per_unit_risk = abs(entry - trade["stop"]) or None
    active_stop = entry if trade["tp1_hit"] else trade["stop"]

    def room_to_target(level):
        if level is None or price is None:
            return None
        d = (level - price) if long else (price - level)
        return {"price": d, "pct": _pct(d, price)}

    def room_to_stop():
        if price is None:
            return None
        d = (price - active_stop) if long else (active_stop - price)
        return {"price": d, "pct": _pct(d, price)}

    unrealized = None
    if price is not None and trade["status"] != "CLOSED":
        unrealized = lifecycle.pnl(trade["direction"], entry, price, trade["remaining_qty"])
    best = trade.get("best_price") or entry
    worst = trade.get("worst_price") or entry
    fav = (best - entry) if long else (entry - best)
    adv = (worst - entry) if long else (entry - worst)
    qty = trade["quantity"]
    mfe_r = (fav / per_unit_risk) if per_unit_risk else None
    return {
        "monitor": mon,
        "current_price": price,
        "unrealized_pnl": unrealized,
        "unrealized_r": (unrealized / risk) if (unrealized is not None and risk > 0) else None,
        "active_stop": active_stop,
        "distance_to_stop": room_to_stop() if trade["status"] != "CLOSED" else None,
        "distance_to_tp1": None if trade["tp1_hit"] or trade["status"] == "CLOSED" else room_to_target(trade["tp1"]),
        "distance_to_tp2": None if trade["status"] == "CLOSED" else room_to_target(trade["tp2"]),
        "best_price": best, "worst_price": worst,
        "mfe": {"price": fav, "pct": _pct(fav, entry), "usd": fav * qty, "r": mfe_r},
        "mae": {"price": adv, "pct": _pct(adv, entry), "usd": adv * qty, "r": (adv / per_unit_risk) if per_unit_risk else None},
        "position_age_s": ((trade.get("closed_at_ms") or now_ms) - trade["opened_at_ms"]) / 1000.0,
        "remaining_qty": trade["remaining_qty"],
        "milestones": milestones(trade),
        "giveback": profit_giveback(trade, price, now_ms, mfe_r, unrealized, risk),
    }


def profit_giveback(trade: dict, price: Optional[float], now_ms: int, mfe_r: Optional[float],
                    unrealized: Optional[float], risk: float) -> dict:
    """Display-only profit-giveback view of the trade's OWN live figures
    (MAJOR 3's core metric, shown ahead of any adaptive-exit policy):

        profit_giveback_R = MFE_R - current R   (open trade)
                          = MFE_R - realised R  (closed trade)

    current R / realised R = (realised PnL + unrealised PnL) / planned risk,
    gross of fees like MFE, so the two are comparable. "Peak" is the most
    favourable price since entry -- the HIGHEST for a long, the LOWEST for a
    short -- and distance from peak is how far price has come back from it
    against the trade (>= 0). No hindsight or research value is used here."""
    long = trade["direction"] == "long"
    closed = trade["status"] == "CLOSED"
    peak = trade.get("best_price") or trade["entry_fill"]
    realized = trade.get("realized_pnl") or 0.0
    if risk <= 0:
        current_r = None
    elif closed:
        current_r = realized / risk
    elif unrealized is not None:
        current_r = (realized + unrealized) / risk
    else:
        current_r = None
    giveback_r = max(0.0, mfe_r - current_r) if (mfe_r is not None and current_r is not None) else None
    giveback_pct = (giveback_r / mfe_r * 100) if (giveback_r is not None and mfe_r and mfe_r > 0) else None
    ref = None if closed else price
    from_peak = None
    if ref is not None:
        d = max(0.0, (peak - ref) if long else (ref - peak))
        from_peak = {"price": d, "pct": _pct(d, peak)}
    mfe_at = trade.get("best_price_at_ms")
    end = trade.get("closed_at_ms") or now_ms
    return {
        "peak_price": peak,
        "peak_side": "HIGHEST" if long else "LOWEST",
        "mfe_r": mfe_r,
        "current_r": current_r,
        "current_r_basis": "REALISED" if closed else "REALISED_PLUS_UNREALISED",
        "profit_giveback_r": giveback_r,
        "profit_giveback_pct": giveback_pct,
        "distance_from_peak": from_peak,
        # The ledger records the peak PRICE but not WHEN it was reached, so
        # time since MFE is unknown (never estimated) until that is tracked.
        "time_since_mfe_s": ((end - mfe_at) / 1000.0) if mfe_at else None,
        "time_since_mfe_reason": None if mfe_at else "MFE_TIMESTAMP_NOT_TRACKED",
    }


def milestones(trade: dict) -> dict:
    exits = {e["kind"]: e for e in trade.get("exits") or []}
    tp1 = exits.get("TP1")
    stop_hit = exits.get("STOP") or exits.get("BREAKEVEN_STOP")
    return {
        "tp1_hit": bool(trade["tp1_hit"]),
        "tp1_fill_timestamp": trade.get("tp1_fill_at_ms") or (tp1 or {}).get("at_ms"),
        "tp1_fill_price": trade.get("tp1_fill_price") or (tp1 or {}).get("fill_price"),
        "remaining_quantity": trade["remaining_qty"],
        "stop_status": trade.get("stop_status") or ("HIT" if stop_hit else "BREAKEVEN" if trade["tp1_hit"] else
                                                    "CANCELLED" if trade["status"] == "CLOSED" else "ACTIVE"),
        "tp2_status": trade.get("tp2_status") or ("HIT" if "TP2" in exits else "NONE" if trade["tp2"] is None else
                                                  "CANCELLED" if trade["status"] == "CLOSED" else "PENDING"),
    }


def _entry_side(direction: str) -> str:
    return "BUY" if direction == "long" else "SELL"


EXIT_LABELS = {"TP1": "TP1 FILL", "TP2": "TP2 FILL", "STOP": "STOP HIT", "BREAKEVEN_STOP": "BREAKEVEN STOP HIT",
               "TIMEOUT": "TIMEOUT EXIT", "MANUAL": "MANUAL EXIT"}


def chart_markers(trade: dict) -> list[dict]:
    side = _entry_side(trade["direction"])
    exit_side = lifecycle.exit_side(trade["direction"]).upper()
    direction = trade["direction"].upper()
    markers = [{"kind": "ENTRY", "at_ms": trade["opened_at_ms"], "price": trade["entry_fill"], "side": side,
                "label": f"{direction} ENTRY ({side})", "quantity": trade["quantity"]}]
    for e in trade.get("exits") or []:
        markers.append({"kind": e["kind"], "at_ms": e["at_ms"], "price": e["fill_price"], "level": e.get("level"),
                        "side": exit_side, "quantity": e["quantity"], "trigger": e.get("trigger"),
                        "label": f"{EXIT_LABELS.get(e['kind'], e['kind'])} ({exit_side} {e['quantity']:g})"})
    return markers


def chart_levels(trade: dict) -> list[dict]:
    direction = trade["direction"].upper()
    out = [{"kind": "ENTRY", "price": trade["entry_fill"], "label": f"ENTRY ({direction})"},
           {"kind": "STOP", "price": trade["stop"], "label": f"STOP ({'below' if trade['direction'] == 'long' else 'above'} entry, {direction})"}]
    if trade["tp1"] is not None:
        out.append({"kind": "TP1", "price": trade["tp1"], "label": f"TP1 ({direction})"})
    if trade["tp2"] is not None:
        out.append({"kind": "TP2", "price": trade["tp2"], "label": f"TP2 ({direction})"})
    if trade["tp1_hit"] and trade["status"] != "CLOSED":
        out.append({"kind": "BREAKEVEN_STOP", "price": trade["entry_fill"], "label": "ACTIVE STOP (breakeven after TP1)"})
    return out


def decision_context(ledger: PaperLedger, trade: dict) -> dict:
    """ORIGINAL decision-time values, exactly as persisted when the trade
    opened. Nothing computed later is merged in here."""
    payload = ledger.signal_payload(trade["signal_id"]) or {}
    signal = payload.get("signal") or {}
    meta = payload.get("meta") or {}
    entry_ref = signal.get("entry", trade.get("signal_entry"))
    stop, tp1, tp2 = trade["stop"], trade["tp1"], trade["tp2"]

    def rr(target):
        if target is None or entry_ref is None or entry_ref == stop:
            return None
        return abs(target - entry_ref) / abs(entry_ref - stop)

    return {
        "asset": trade["asset"], "instrument": trade["instrument"], "coin": trade.get("coin"), "direction": trade["direction"],
        "entry_time_ms": trade["opened_at_ms"], "signal_timestamp": trade.get("signal_timestamp"),
        "signal_entry": entry_ref, "entry_price": trade["entry_fill"], "mark_at_entry": trade.get("mark_at_entry"),
        "quantity": trade["quantity"], "notional": trade.get("notional"), "risk_amount": trade.get("risk_amount"),
        "requested_leverage": trade.get("requested_leverage"), "approved_leverage": trade.get("approved_leverage"),
        "original_stop": stop, "original_tp1": tp1, "original_tp2": tp2,
        "original_rr1": meta.get("rr1") if meta.get("rr1") is not None else rr(tp1),
        "original_rr2": meta.get("rr2") if meta.get("rr2") is not None else rr(tp2),
        "strategy": trade.get("strategy") or meta.get("strategy"), "regime": meta.get("regime"),
        "quant_score": meta.get("quant_score", trade.get("quant_score")), "ml_score": meta.get("ml_score"),
        "combined_score": meta.get("combined_score"), "rank": meta.get("rank"),
        "scan_id": meta.get("scan_id"), "observation_id": meta.get("observation_id"),
        "model_version": meta.get("model_version"), "model_status": meta.get("model_status"),
        "feature_version": meta.get("feature_version"),
        "market_price_source": trade.get("market_price_source"), "market_price_timestamp": trade.get("market_price_timestamp"),
        "market_price_age_ms": trade.get("market_price_age_ms"),
        "execution_mode": trade.get("execution_mode", "PAPER"), "backend": trade.get("backend"), "execution_status": trade["status"],
    }


SHADOW_HINDSIGHT_EXTRA = ("current_policy_outcome_r", "strategy_efficiency", "classification", "classification_status",
                          "best_achievable_r", "executable_within_stop_r")


def shadow_view(shadow_link: Optional[dict]) -> dict:
    """Link to the shadow-learning observation of this trade (joined by the
    stable signal_id). Ids and resolution progress only; the post-outcome
    labels are exposed solely through `hindsight`, never here."""
    if not shadow_link:
        return {"linked": False, "reason": "NO_SHADOW_OBSERVATION_FOR_THIS_SIGNAL"}
    return {"linked": True, **{k: v for k, v in shadow_link.items() if k != "post_outcome"},
            "post_outcome_available": shadow_link.get("post_outcome") is not None}


def hindsight_view(ledger: PaperLedger, trade: dict, shadow_link: Optional[dict] = None) -> dict:
    """Separate from `decision`. Unavailable until the trade is CLOSED and a
    resolved post-outcome label exists for it: either one recorded for the
    trade itself, or the final (72h) post-outcome record of its linked shadow
    observation -- which the shadow store only writes after that window has
    closed."""
    base = {"label": HINDSIGHT_LABEL, "post_outcome": True, "known_at_decision_time": False}
    if trade["status"] != "CLOSED":
        return {**base, "available": False, "reason": "OUTCOME_NOT_RESOLVED"}
    record = ledger.hindsight(trade["trade_id"])
    if record:
        labels = record["labels"]
        return {**base, "available": True, "reason": None, "resolved_at_ms": record["resolved_at_ms"], "source": record["source"],
                "levels": {k: labels.get(k) for k in HINDSIGHT_FIELDS}}
    post = (shadow_link or {}).get("post_outcome")
    if post:
        labels = post["labels"]
        return {**base, "available": True, "reason": None, "resolved_at_ms": post["resolved_at_ms"],
                "source": f"SHADOW_OBSERVATION:{shadow_link['observation_id']}",
                "levels": {k: labels.get(k) for k in HINDSIGHT_FIELDS},
                "diagnostics": {k: labels.get(k) for k in SHADOW_HINDSIGHT_EXTRA}}
    return {**base, "available": False, "reason": "NO_RESOLVED_RESEARCH_LABEL"}


COUNTERFACTUAL_LABEL = "COUNTERFACTUAL RISK SIZING - RESEARCH ONLY - NOT USED FOR EXECUTION"


def risk_sizing_view(ledger: PaperLedger, trade: dict) -> dict:
    """The ORIGINAL immutable sizing decision(s) of this trade, the evolving
    current risk (separate, recomputed), and the after-trade measurement.
    A counterfactual (shadow-mode V2) record is labelled as such and never
    presented as the executed size."""
    from market_edge_exec.risk import sizing_v2   # local: keeps this view module's import surface small
    records = ledger.sizing_records(trade["trade_id"])
    executed = next((r for r in records if r["role"] == "AUTHORITATIVE"), None)
    counterfactual = [dict(r, label=COUNTERFACTUAL_LABEL) for r in records if r["role"] == "COUNTERFACTUAL"]
    current = None
    if trade["status"] != "CLOSED":
        current = sizing_v2.current_risk(trade, executed["record"] if executed else None)
    return {"mode": trade.get("sizing_mode"), "executed": executed, "counterfactual": counterfactual,
            "executed_quantity": trade.get("quantity"), "current_risk": current,
            "outcome": ledger.sizing_outcome(trade["trade_id"]),
            "note": None if records else "This trade was opened before Risk Sizing V2 recorded sizing decisions."}


def build_trade_detail(ledger: PaperLedger, trade: dict, now_ms: int, max_age_s: float,
                       shadow_link: Optional[dict] = None) -> dict:
    return {
        "trade_id": trade["trade_id"], "status": trade["status"], "is_open": trade["status"] != "CLOSED",
        "opened_at_ms": trade["opened_at_ms"], "closed_at_ms": trade.get("closed_at_ms"), "exit_reason": trade.get("exit_reason"),
        "decision": decision_context(ledger, trade),
        "live": live_metrics(trade, now_ms, max_age_s),
        "levels": chart_levels(trade),
        "markers": chart_markers(trade),
        "exits": trade.get("exits") or [],
        "realized_pnl": trade["realized_pnl"], "fees": trade["fees"], "net_pnl": trade["realized_pnl"] - trade["fees"],
        "risk_sizing": risk_sizing_view(ledger, trade),
        "shadow": shadow_view(shadow_link),
        "hindsight": hindsight_view(ledger, trade, shadow_link),
        "generated_at_ms": now_ms,
    }
