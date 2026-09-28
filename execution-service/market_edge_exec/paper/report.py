"""Forward-paper performance report, computed only from the persistent paper
ledger (live forward trades). Backtest results never enter it -- those live
in diagnostics/real_backtest_scenarios.py's own output.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Optional

from market_edge_exec.paper.ledger import PaperLedger


def _group_stats(trades: list[dict]) -> dict:
    closed = [t for t in trades if t["status"] == "CLOSED"]
    net = [t["realized_pnl"] - t["fees"] for t in closed]
    wins = [p for p in net if p > 0]
    losses = [p for p in net if p <= 0]
    return {
        "trades_opened": len(trades), "trades_closed": len(closed), "wins": len(wins), "losses": len(losses),
        "win_rate_pct": (len(wins) / len(closed) * 100) if closed else None,
        "net_realized_pnl": sum(net),
    }


def build_report(ledger: PaperLedger, halted_reason: Optional[str] = None, now_ms: Optional[int] = None) -> dict:
    trades = ledger.trades()
    closed = [t for t in trades if t["status"] == "CLOSED"]
    totals = ledger.totals()
    equity_curve = ledger.equity_history()
    signals = ledger.signal_history()
    segments = ledger.runtime_segments()

    net = [t["realized_pnl"] - t["fees"] for t in closed]
    wins = [p for p in net if p > 0]
    losses = [p for p in net if p <= 0]
    gross_win, gross_loss = sum(wins), -sum(losses)

    peak, max_dd, max_dd_pct = totals["starting_equity"], 0.0, 0.0
    for point in equity_curve:
        peak = max(peak, point["equity"])
        dd = peak - point["equity"]
        if dd > max_dd:
            max_dd, max_dd_pct = dd, dd / peak * 100

    streak = worst_streak = 0
    for t in sorted(closed, key=lambda t: t["closed_at_ms"]):
        streak = streak + 1 if t["realized_pnl"] - t["fees"] <= 0 else 0
        worst_streak = max(worst_streak, streak)

    runtime_ms = sum((s["ended_at_ms"] or now_ms or s["started_at_ms"]) - s["started_at_ms"] for s in segments)
    by = lambda key: {k: _group_stats(v) for k, v in _groupby(trades, key).items()}
    outcomes = defaultdict(int)
    for s in signals:
        outcomes[s["outcome"]] += 1
    rejection_reasons = defaultdict(int)
    for s in signals:
        if s["outcome"] in ("REJECTED", "RISK_REJECTED", "DUPLICATE", "NO_TRADE"):
            rejection_reasons[f"{s['outcome']}:{s['reason']}"] += 1

    leverages = [t["approved_leverage"] for t in trades]
    return {
        "execution_mode": "PAPER",
        "data": "live Market Edge scans + live exchange market data; simulated fills",
        "includes_backtest": False,
        "runtime_hours": runtime_ms / 3_600_000,
        "segments": len(segments),
        "starting_equity": totals["starting_equity"],
        "ending_equity": totals["equity"],
        "return_pct": (totals["equity"] / totals["starting_equity"] - 1) * 100,
        "balance": totals["balance"],
        "signals_observed": len(signals),
        "signal_outcomes": dict(outcomes),
        "rejection_reasons": dict(rejection_reasons),
        "trades_opened": len(trades),
        "trades_closed": len(closed),
        "open_trades": totals["open_positions"],
        "wins": len(wins), "losses": len(losses),
        "win_rate_pct": (len(wins) / len(closed) * 100) if closed else None,
        "expectancy_per_trade": (sum(net) / len(closed)) if closed else None,
        "expectancy_r": (sum((t["realized_pnl"] - t["fees"]) / t["risk_amount"] for t in closed) / len(closed)) if closed else None,
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else None,
        "realized_pnl": totals["realized_pnl"],
        "unrealized_pnl": totals["unrealized_pnl"],
        "fees": totals["fees"],
        "slippage_cost": totals["slippage_cost"],
        "max_drawdown": max_dd, "max_drawdown_pct": max_dd_pct,
        "max_exposure_notional": max((p.get("open_notional", 0.0) for p in equity_curve), default=0.0),
        "max_exposure_pct": max((p.get("open_notional", 0.0) / p["equity"] * 100 for p in equity_curve if p["equity"]), default=0.0),
        "average_leverage": (sum(leverages) / len(leverages)) if leverages else None,
        "max_leverage": max(leverages) if leverages else None,
        "average_risk_pct_per_trade": (sum(t["risk_pct_of_equity"] for t in trades) / len(trades)) if trades else None,
        "worst_losing_streak": worst_streak,
        "exit_reasons": dict(_count(closed, "exit_reason")),
        "by_direction": by("direction"),
        "by_asset": by("asset"),
        "by_strategy": by("strategy"),
        "by_leverage": by("approved_leverage"),
        "halted": halted_reason,
        "trades": [{k: t[k] for k in ("trade_id", "instrument", "direction", "strategy", "status", "exit_reason",
                                       "entry_fill", "stop", "tp1", "tp2", "quantity", "remaining_qty", "requested_leverage",
                                       "approved_leverage", "notional", "margin_used", "stop_distance", "risk_amount",
                                       "max_loss", "liquidation_estimate", "liquidation_buffer_pct", "realized_pnl",
                                       "unrealized_pnl", "fees", "opened_at_ms", "closed_at_ms")} for t in trades],
    }


def _groupby(trades: list[dict], key: str) -> dict:
    groups: dict = defaultdict(list)
    for t in trades:
        groups[str(t.get(key))].append(t)
    return groups


def _count(trades: list[dict], key: str) -> dict:
    counts: dict = defaultdict(int)
    for t in trades:
        counts[str(t.get(key))] += 1
    return counts
