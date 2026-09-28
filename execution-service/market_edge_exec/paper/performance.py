"""Read-only views of the persistent paper ledger for the desktop app:
positions, trade history, signal history and performance series.

Everything here is derived from PaperLedger on each call -- the app never
keeps its own copy of trading state. build_report() stays the canonical
forward-paper summary; build_performance() adds the extra series and
per-trade metrics the Performance screen charts, computed the same way
(net = realized_pnl - fees, R = net / risk_amount).
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from contextlib import closing
from typing import Optional

from market_edge_exec.paper.engine import MONITOR_MAX_PRICE_AGE_SECONDS

from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.paper.report import build_report


def _net(trade: dict) -> float:
    return trade["realized_pnl"] - trade["fees"]


def _r_multiple(trade: dict) -> Optional[float]:
    risk = trade.get("risk_amount") or 0.0
    return _net(trade) / risk if risk > 0 else None


def _avg_exit_price(trade: dict) -> Optional[float]:
    exits = trade.get("exits") or []
    qty = sum(e["quantity"] for e in exits)
    return (sum(e["fill_price"] * e["quantity"] for e in exits) / qty) if qty > 0 else None


MARK_SOURCES = {
    "HYPERLIQUID_ALLMIDS_LIVE": "live mid (10s open-position monitor)",
    "HYPERLIQUID_WS_TRADES": "live trade print (exchange stream)",
    "HYPERLIQUID_CANDLE_5M_CLOSE": "last completed 5m candle close",
}


def position_view(trade: dict, now_ms: Optional[int] = None, max_price_age_s: float = MONITOR_MAX_PRICE_AGE_SECONDS) -> dict:
    from market_edge_exec.paper.trade_detail import live_metrics  # avoids an import cycle at module load

    now_ms = now_ms or int(time.time() * 1000)
    live = live_metrics(trade, now_ms, max_price_age_s)
    mon = live["monitor"]
    # No live price yet: show the entry mark it was opened on, labelled as such.
    mark = mon["price"] or trade.get("mark_price") or trade["entry_fill"]
    source = MARK_SOURCES.get(mon["price_source"], mon["price_source"]) if mon["price"] else "entry mark (awaiting first monitor price)"
    return {
        "signal_id": trade["signal_id"], "trade_id": trade["trade_id"], "instrument": trade["instrument"], "asset": trade["asset"],
        "direction": trade["direction"], "status": trade["status"], "strategy": trade.get("strategy"),
        "entry": trade["entry_fill"], "current_price": mark, "mark_source": source,
        "mark_checked_ms": mon["price_at_ms"] or trade.get("last_checked_ms"), "quantity": trade["remaining_qty"],
        "monitor_status": mon["status"], "monitor_detail": mon["detail"], "price_age_s": mon["price_age_s"],
        "price_source": mon["price_source"], "unrealized_r": live["unrealized_r"],
        "distance_to_stop": live["distance_to_stop"], "distance_to_tp1": live["distance_to_tp1"],
        "distance_to_tp2": live["distance_to_tp2"], "mfe": live["mfe"], "mae": live["mae"],
        "position_age_s": live["position_age_s"], "active_stop": live["active_stop"], "milestones": live["milestones"],
        "original_quantity": trade["quantity"], "leverage": trade["approved_leverage"],
        "requested_leverage": trade["requested_leverage"], "margin": trade["margin_used"],
        "notional": trade["remaining_qty"] * mark, "unrealized_pnl": trade.get("unrealized_pnl", 0.0),
        "realized_pnl": trade["realized_pnl"], "stop": trade["stop"], "tp1": trade["tp1"], "tp2": trade["tp2"],
        "tp1_hit": trade["tp1_hit"], "risk_amount": trade["risk_amount"], "liquidation_estimate": trade["liquidation_estimate"],
        "liquidation_buffer_pct": trade["liquidation_buffer_pct"], "backend": trade["backend"],
        "opened_at_ms": trade["opened_at_ms"], "execution_mode": trade.get("execution_mode", "PAPER"),
    }


def trade_view(trade: dict) -> dict:
    return {
        "signal_id": trade["signal_id"], "trade_id": trade["trade_id"], "instrument": trade["instrument"], "asset": trade["asset"],
        "direction": trade["direction"], "status": trade["status"], "strategy": trade.get("strategy"),
        "entry_at_ms": trade["opened_at_ms"], "exit_at_ms": trade.get("closed_at_ms"),
        "size": trade["quantity"], "leverage": trade["approved_leverage"], "entry": trade["entry_fill"],
        "exit": _avg_exit_price(trade), "fees": trade["fees"], "slippage": trade["slippage_cost"],
        "realized_pnl": trade["realized_pnl"], "net_pnl": _net(trade), "r_multiple": _r_multiple(trade) if trade["status"] == "CLOSED" else None,
        "exit_reason": trade.get("exit_reason"), "risk_amount": trade["risk_amount"], "exits": trade.get("exits") or [],
        "backend": trade["backend"],
    }


def signal_rows(ledger: PaperLedger, limit: int = 500) -> list[dict]:
    """Every forward-loop decision, newest first, with the signal geometry
    and any scan context the loop attached (meta)."""
    with closing(ledger._connect()) as conn:  # noqa: SLF001 -- same-package read of the ledger's own file
        rows = conn.execute("SELECT id, signal_id, at_ms, outcome, reason, payload FROM paper_signals ORDER BY at_ms DESC, id DESC LIMIT ?",
                            (limit,)).fetchall()
    out = []
    for r in rows:
        payload = json.loads(r["payload"] or "{}")
        signal = payload.get("signal") or {}
        meta = payload.get("meta") or {}
        targets = signal.get("targets") or []
        entry, stop = signal.get("entry"), signal.get("stop")
        tp1 = targets[0] if targets else None
        rr = meta.get("rr1")
        if rr is None and entry is not None and stop is not None and tp1 is not None and entry != stop:
            rr = abs(tp1 - entry) / abs(entry - stop)
        freshness_s = (r["at_ms"] - signal["timestamp"]) / 1000.0 if signal.get("timestamp") else None
        out.append({
            "row_id": r["id"], "signal_id": r["signal_id"], "at_ms": r["at_ms"], "outcome": r["outcome"],
            "accepted": r["outcome"] == "EXECUTED", "reason": r["reason"],
            "asset": signal.get("asset"), "direction": signal.get("direction"), "strategy": signal.get("strategy_id") or meta.get("strategy"),
            "rank": meta.get("rank"), "quant_score": meta.get("quant_score", signal.get("quant_score")),
            "ml_score": meta.get("ml_score"), "combined_score": meta.get("combined_score"),
            "entry": entry, "stop": stop, "tp1": tp1, "tp2": targets[1] if len(targets) > 1 else None,
            "rr": rr, "freshness_s": freshness_s, "signal_timestamp": signal.get("timestamp"),
            "mark_price": payload.get("mark_price"), "requested_leverage": payload.get("requested_leverage"),
            "detail": payload if r["outcome"] == "NO_TRADE" else None,
        })
    return out


def build_performance(ledger: PaperLedger, halted_reason: Optional[str] = None) -> dict:
    report = build_report(ledger, halted_reason=halted_reason)
    report.pop("trades", None)
    trades = ledger.trades()
    closed = sorted((t for t in trades if t["status"] == "CLOSED"), key=lambda t: t["closed_at_ms"])
    nets = [_net(t) for t in closed]
    wins, losses = [n for n in nets if n > 0], [n for n in nets if n <= 0]
    rs = [r for r in (_r_multiple(t) for t in closed) if r is not None]

    start = ledger.starting_equity()
    equity_curve, drawdown_curve, peak = [], [], start
    for point in ledger.equity_history():
        peak = max(peak, point["equity"])
        equity_curve.append({"at_ms": point["at_ms"], "equity": point["equity"]})
        drawdown_curve.append({"at_ms": point["at_ms"], "drawdown_pct": (peak - point["equity"]) / peak * 100 if peak else 0.0})

    cumulative, running = [], 0.0
    for t, n in zip(closed, nets):
        running += n
        cumulative.append({"at_ms": t["closed_at_ms"], "pnl": running, "signal_id": t["signal_id"]})

    leverage_distribution: dict = defaultdict(int)
    for t in trades:
        leverage_distribution[str(t["approved_leverage"])] += 1

    report.update({
        "number_of_trades": len(trades),
        "average_win": (sum(wins) / len(wins)) if wins else None,
        "average_loss": (sum(losses) / len(losses)) if losses else None,
        "average_r": (sum(rs) / len(rs)) if rs else None,
        "average_risk_per_trade": (sum(t["risk_amount"] for t in trades) / len(trades)) if trades else None,
        "equity_curve": equity_curve,
        "drawdown_curve": drawdown_curve,
        "cumulative_pnl": cumulative,
        "r_distribution": rs,
        "pnl_distribution": nets,
        "leverage_distribution": dict(leverage_distribution),
    })
    return report
