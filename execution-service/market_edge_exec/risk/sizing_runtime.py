"""Glue between the persistent paper ledger and the pure Risk Sizing V2
sizer: current open risk (reconstructed from persisted trade state, so it
survives restarts), rollout mode, operator tightening, and the parsing of
the point-in-time inputs the forward loop sends (daily candles for
volatility, the order book for liquidity, venue order rules).

Nothing here reserves anything: the only reservation is the paper engine's
entry lock around read-size-open.
"""
from __future__ import annotations

import os
from typing import Optional

from market_edge_exec.risk import sizing_v2 as S
from market_edge_exec.risk.engine import RiskLimits

LEGACY_RULE_VERSION = "RISK-V1-LEGACY"


def mode_from_env() -> str:
    """SHADOW unless explicitly PAPER. LIVE is not a sizing mode."""
    return S.MODE_PAPER if os.environ.get("RISK_SIZING_V2_MODE", "").strip().upper() == S.MODE_PAPER else S.MODE_SHADOW


def effective_policy(limits: RiskLimits, base: S.SizingPolicy = S.DEFAULT_POLICY) -> S.SizingPolicy:
    """Operator settings can only tighten the V2 policy."""
    return base.tightened(max_risk_pct=limits.max_risk_per_trade_pct / 100.0,
                          max_gross_pct=limits.max_portfolio_exposure_pct / 100.0,
                          max_positions=limits.max_concurrent_positions)


def open_risks(ledger) -> list[S.OpenRisk]:
    """Every open (incl. partially closed) position's CURRENT risk, from the
    persisted ledger: after a restart the budgets are exactly what they were."""
    out = []
    for trade in ledger.trades("OPEN"):
        original = ledger.authoritative_sizing(trade["trade_id"])
        cur = S.current_risk(trade, original)
        out.append(S.OpenRisk(trade.get("asset") or trade["instrument"], cur["cluster_id"], cur["current_notional"],
                              cur["current_margin"], cur["current_planned_loss"]))
    return out


def parse_inputs(risk_inputs: Optional[dict]) -> tuple[Optional[S.VolInput], Optional[S.DepthInput], S.VenueRules]:
    ri = risk_inputs if isinstance(risk_inputs, dict) else {}
    vol = depth = None
    v = ri.get("vol")
    if isinstance(v, dict):
        try:
            vol = S.VolInput(str(v.get("venue")), str(v.get("interval")), [float(c) for c in v.get("closes") or []],
                             int(v.get("last_bar_open_ms")))
        except (TypeError, ValueError):
            vol = None
    d = ri.get("depth")
    if isinstance(d, dict):
        try:
            depth = S.DepthInput(str(d.get("venue")), list(d.get("bids") or []), list(d.get("asks") or []), int(d.get("at_ms")))
        except (TypeError, ValueError):
            depth = None
    rules = S.VenueRules()
    r = ri.get("venue_rules")
    if isinstance(r, dict):
        try:
            rules = S.VenueRules(min_notional=max(float(r.get("min_notional", rules.min_notional)), rules.min_notional),
                                 qty_decimals=min(8, max(0, int(r.get("qty_decimals", rules.qty_decimals)))))
        except (TypeError, ValueError):
            pass
    return vol, depth, rules


def legacy_record(assessment, account, entry: float, stop: float, asset: str, direction: str, quantity: float, now_ms: int) -> dict:
    """The authoritative sizing when V2 runs in SHADOW: the existing engine's
    decision, in the same record shape so the two can be compared."""
    notional = quantity * entry
    price_loss = quantity * abs(entry - stop)
    binding = "POSITION_OR_PORTFOLIO_EXPOSURE_CAP" if assessment.exposure_capped else "RISK_BUDGET"
    return {"sizing_rule_version": LEGACY_RULE_VERSION, "approved": True, "rejection_reason": None, "timestamp": now_ms,
            "asset": asset, "direction": direction, "wallet_equity": account.equity, "entry_price": entry, "stop_price": stop,
            "stop_distance_pct": abs(entry - stop) / entry, "risk_budget_dollars": assessment.risk_amount,
            "final_quantity": quantity, "final_notional": notional, "final_notional_pct_equity": notional / account.equity,
            "planned_loss_dollars": price_loss, "planned_loss_pct_equity": price_loss / account.equity,
            "leverage": float(assessment.decision.approved_leverage), "margin_required": assessment.margin_required,
            "sizing_binding_constraint": binding, "cluster_id": S.cluster_for(asset)[0],
            "note": "Legacy engine: 1%-of-equity price-loss budget, 5%/20%/4 caps; execution costs not in the budget."}


def rescale(record: dict, quantity: float, entry: float, binding: Optional[str] = None) -> dict:
    """Final fields for a smaller executed quantity (e.g. a legacy gate cut
    it further). Only ever called with quantity <= the V2 quantity."""
    E = record["wallet_equity"]
    notional = quantity * entry
    planned = notional * record["effective_loss_fraction"]
    out = {**record, "final_quantity": quantity, "final_notional": notional, "final_notional_pct_equity": notional / E,
           "planned_loss_dollars": planned, "planned_loss_pct_equity": planned / E,
           "margin_required": notional / record["leverage"], "planned_price_loss_dollars": notional * record["stop_distance_pct"]}
    if binding:
        out["sizing_binding_constraint"] = binding
        out["sizing_reduction_reason"] = f"{binding} reduced size below the V2 size"
    return out
