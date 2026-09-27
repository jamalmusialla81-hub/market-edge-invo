"""Forward-paper engine: one place that runs the full cycle Jakob specified
(validate freshness, reject duplicate signal_id, risk-owned size, approve or
walk down leverage, route, persist fill, open/advance/close the trade,
update PnL) against the persistent PaperLedger.

Every entry and every exit goes through the same ExecutionRouter as any
other intent, so idempotency (signal_id PK), the kill switch and backend
failure handling all apply to exits too. Exit intents are keyed
"<signal_id>:<EXIT_KIND>", which makes a duplicate TP1/stop callback a
DUPLICATE_SIGNAL at the router instead of a double close.

PAPER ONLY: fills are simulated at live market prices plus the same fee and
slippage assumptions production's forward engine uses (lifecycle.py).
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from market_edge_exec.domain.contracts import AlphaSignal, ContractError, ExecutionIntent, RiskDecision
from market_edge_exec.paper import lifecycle
from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.persistence.store import Store
from market_edge_exec.risk.engine import LEVERAGE_BANDS, RiskLimits, approve
from market_edge_exec.routing.router import ExecutionRouter, RouterError
from market_edge_exec.signal_bridge.bridge import DIRECTION_TO_SIDE, MAX_SIGNAL_AGE_SECONDS, is_fresh
from market_edge_exec.telemetry.logging import log_event

EXECUTION_MODE = "PAPER"
MAX_MARK_AGE_SECONDS = 120  # a mark older than this is stale market data: no new entries


@dataclass
class EntryResult:
    signal_id: Optional[str]
    accepted: bool
    reason: Optional[str] = None
    trade: Optional[dict] = None


@dataclass
class MarkResult:
    instrument: str
    exits: list = field(default_factory=list)
    mark_price: Optional[float] = None
    skipped: Optional[str] = None


class PaperEngine:
    def __init__(self, ledger: PaperLedger, router: ExecutionRouter, store: Store, limits: RiskLimits = RiskLimits(), portfolio=None,
                 limits_provider: Optional[Callable[[], RiskLimits]] = None,
                 entries_gate: Optional[Callable[[], Optional[str]]] = None,
                 max_mark_age_provider: Optional[Callable[[], float]] = None):
        """limits_provider / max_mark_age_provider let persisted operator
        settings (control/settings.py) apply on every entry; without them the
        fixed `limits` and MAX_MARK_AGE_SECONDS apply exactly as before.
        entries_gate returns a rejection reason (e.g. ENTRIES_PAUSED) or None."""
        self.ledger, self.router, self.store, self._limits, self.portfolio = ledger, router, store, limits, portfolio
        self._limits_provider, self._entries_gate, self._max_mark_age_provider = limits_provider, entries_gate, max_mark_age_provider
        # FastAPI runs sync endpoints in a threadpool, so two /paper/signal
        # calls can interleave. Without this lock each could read the same
        # account_state() snapshot and both pass the exposure check,
        # together exceeding the 20% cap. Held across read-check-write so
        # exposure reservation is atomic within this process.
        self._entry_lock = threading.Lock()

    @property
    def limits(self) -> RiskLimits:
        return self._limits_provider() if self._limits_provider else self._limits

    @limits.setter
    def limits(self, value: RiskLimits) -> None:
        self._limits = value

    # ---- entries -------------------------------------------------------
    def _reject(self, signal_id: Optional[str], reason: str, payload: dict, now_ms: int, outcome: str = "REJECTED") -> EntryResult:
        self.ledger.record_signal(signal_id, outcome, reason, payload, at_ms=now_ms)
        if signal_id:
            self.store.record_failure(signal_id, reason)
        log_event("signal_rejected", signal_id=signal_id, reason=reason)
        return EntryResult(signal_id=signal_id, accepted=False, reason=reason)

    def record_no_trade(self, reason: str, payload: Optional[dict] = None, now_ms: Optional[int] = None) -> None:
        now_ms = now_ms or int(time.time() * 1000)
        self.ledger.record_signal(None, "NO_TRADE", reason, payload or {}, at_ms=now_ms)
        log_event("no_trade", reason=reason)

    def open_from_signal(self, signal_payload: dict, instrument: str, mark_price: Optional[float], mark_at_ms: Optional[int],
                         requested_leverage: float = 1.0, venue_preference: Optional[str] = None,
                         now_ms: Optional[int] = None, coin: Optional[str] = None, meta: Optional[dict] = None,
                         market_price_source: str = "UNKNOWN") -> EntryResult:
        now_ms = now_ms or int(time.time() * 1000)
        payload = {"signal": signal_payload, "instrument": instrument, "mark_price": mark_price,
                   "mark_at_ms": mark_at_ms, "requested_leverage": requested_leverage}
        if meta:
            payload["meta"] = meta  # display-only scan context (rank, scores, RR); never used for sizing
        try:
            signal = AlphaSignal.create(signal_payload)
        except ContractError as error:
            return self._reject(signal_payload.get("signal_id") if isinstance(signal_payload, dict) else None,
                                f"INVALID_SIGNAL: {error}", payload, now_ms)
        sid = signal.signal_id

        if self.router.killed:
            return self._reject(sid, "KILL_SWITCH_ACTIVE", payload, now_ms)
        gate_reason = self._entries_gate() if self._entries_gate else None
        if gate_reason:
            return self._reject(sid, gate_reason, payload, now_ms)
        if not is_fresh(signal, now_ms, MAX_SIGNAL_AGE_SECONDS):
            return self._reject(sid, "STALE_SIGNAL", payload, now_ms)
        if self.store.has_intent(sid) or self.ledger.trade(sid):
            return self._reject(sid, "DUPLICATE_SIGNAL", payload, now_ms, outcome="DUPLICATE")
        if signal.direction not in DIRECTION_TO_SIDE or signal.entry is None or signal.stop is None:
            return self._reject(sid, "SIGNAL_MISSING_DIRECTION_ENTRY_OR_STOP", payload, now_ms)
        if mark_price is None or mark_price <= 0 or mark_at_ms is None:
            return self._reject(sid, "NO_MARKET_PRICE", payload, now_ms)
        max_mark_age = self._max_mark_age_provider() if self._max_mark_age_provider else MAX_MARK_AGE_SECONDS
        if (now_ms - mark_at_ms) / 1000.0 > max_mark_age:
            return self._reject(sid, "STALE_MARKET_DATA", payload, now_ms)
        # Everything from here on reads account/instrument state and then
        # writes it, so it runs under the entry lock: two concurrent signals
        # must not both read "no position on this instrument" or both read
        # the same exposure room and each pass the cap independently.
        with self._entry_lock:
            # One live trade per instrument: a fresh scan of the same setup
            # every 5 minutes must not pyramid into it (endurance segment 1).
            # The canonical portfolio counts too: a position opened outside
            # the paper session would otherwise be merged in and break
            # reconciliation.
            if self.ledger.open_trade_for(instrument) or (self.portfolio and self.portfolio.position(instrument)):
                return self._reject(sid, "DUPLICATE_INSTRUMENT", payload, now_ms)

            long = signal.direction == "long"
            side = DIRECTION_TO_SIDE[signal.direction]
            if (long and mark_price <= signal.stop) or (not long and mark_price >= signal.stop):
                return self._reject(sid, "STOP_ALREADY_BREACHED", payload, now_ms)
            tp1 = signal.targets[0] if signal.targets else None
            tp2 = signal.targets[1] if len(signal.targets) > 1 else None
            if tp1 is not None and ((long and mark_price >= tp1) or (not long and mark_price <= tp1)):
                return self._reject(sid, "TARGET_ALREADY_REACHED", payload, now_ms)

            entry_fill = lifecycle.slipped(mark_price, side)
            provisional = ExecutionIntent.create({
                "signal_id": sid, "instrument": instrument, "side": side, "quantity": 0.0, "order_type": "MARKET",
                "strategy_id": signal.strategy_id or "market-edge-alpha", "limit_price": entry_fill, "stop": signal.stop,
                "targets": list(signal.targets), "leverage": requested_leverage, "venue_preference": venue_preference,
            })
            account = self.ledger.account_state(killed=self.router.killed, now_ms=now_ms)
            assessment = approve(provisional, account, self.limits)
            if not assessment.decision.approved:
                return self._reject(sid, assessment.decision.reason or "RISK_REJECTED", payload, now_ms, outcome="RISK_REJECTED")

            leverage = float(assessment.decision.approved_leverage)
            # 8dp matches the portfolio's Nautilus Quantity precision, so the
            # ledger and the canonical position never drift by rounding.
            quantity = round(assessment.position_size, 8)
            if quantity <= 0:
                return self._reject(sid, "SIZE_BELOW_PRECISION", payload, now_ms, outcome="RISK_REJECTED")
            sized = ExecutionIntent.create({**provisional.to_dict(), "quantity": quantity, "leverage": leverage})
            try:
                backend, fill = self.router.route(sized, risk_decision=assessment.decision)
            except RouterError as error:
                return self._reject(sid, f"ROUTER: {error}", payload, now_ms)

            qty = fill.quantity_filled
            entry_fee = lifecycle.fee(entry_fill, qty)
            trade = {
                "trade_id": sid, "signal_id": sid, "instrument": instrument, "asset": signal.asset, "coin": coin or signal.asset,
                "direction": signal.direction, "strategy": signal.strategy_id, "status": "OPEN", "backend": backend,
                "execution_mode": EXECUTION_MODE, "opened_at_ms": now_ms, "closed_at_ms": None, "exit_reason": None,
                "signal_timestamp": signal.timestamp, "signal_entry": signal.entry, "stop": signal.stop, "tp1": tp1, "tp2": tp2,
                "mark_at_entry": mark_price, "entry_fill": entry_fill, "quantity": qty, "remaining_qty": qty,
                # Data-integrity audit (2026-09-27): every accepted trade
                # records exactly what price it traded on and how old that
                # price was, so a HISTORICAL-RANK-V1 or stale-cache
                # dependency would be visible in the trade record itself.
                "market_price_timestamp": mark_at_ms, "market_price_source": market_price_source,
                "market_price_age_ms": now_ms - mark_at_ms,
                "tp1_hit": False, "requested_leverage": requested_leverage, "approved_leverage": leverage,
                "notional": assessment.notional, "margin_used": assessment.margin_required,
                "stop_distance": assessment.stop_distance, "risk_amount": assessment.risk_amount, "max_loss": assessment.max_loss,
                "liquidation_estimate": assessment.liquidation_estimate, "liquidation_buffer_pct": assessment.liquidation_buffer_pct,
                "equity_at_entry": account.equity, "risk_pct_of_equity": assessment.risk_amount / account.equity * 100,
                "exposure_capped": assessment.exposure_capped,
                "realized_pnl": 0.0, "unrealized_pnl": 0.0, "fees": entry_fee,
                "slippage_cost": abs(entry_fill - mark_price) * qty, "mark_price": mark_price, "last_checked_ms": now_ms,
                "quant_score": signal.quant_score, "exits": [],
            }
            self.ledger.open_trade(trade)
            self.ledger.record_signal(sid, "EXECUTED", None, payload, at_ms=now_ms)
        log_event("paper_trade_opened", signal_id=sid, instrument=instrument, backend=backend)
        self.ledger.record_equity(now_ms)
        return EntryResult(signal_id=sid, accepted=True, trade=trade)

    # ---- lifecycle -----------------------------------------------------
    def mark(self, instrument: str, candles: list[dict], now_ms: Optional[int] = None) -> MarkResult:
        """Advance every open trade on `instrument` through the completed
        candles observed since its last check. Exits route as reduce-only
        intents, so they still go through when the kill switch is engaged."""
        now_ms = now_ms or int(time.time() * 1000)
        result = MarkResult(instrument=instrument)
        trade = self.ledger.open_trade_for(instrument)
        if trade is None:
            result.skipped = "NO_OPEN_TRADE"
            return result
        fresh = [c for c in candles if c["time"] > trade["last_checked_ms"] and c["time"] > trade["opened_at_ms"]]
        if not fresh:
            result.skipped = "NO_NEW_CANDLES"
            return result
        fresh.sort(key=lambda c: c["time"])
        events = lifecycle.advance(
            trade["direction"], trade["entry_fill"], trade["stop"], trade["tp1"], trade["tp2"], trade["remaining_qty"],
            trade["quantity"], trade["tp1_hit"], trade["opened_at_ms"], fresh, now_ms,
        )
        side = lifecycle.exit_side(trade["direction"])
        for event in events:
            exit_intent = ExecutionIntent.create({
                "signal_id": f"{trade['trade_id']}:{event.kind}", "instrument": instrument, "side": side,
                "quantity": event.quantity, "order_type": "MARKET", "strategy_id": trade["strategy"] or "market-edge-alpha",
                "limit_price": event.fill_price, "stop": None, "targets": [], "leverage": trade["approved_leverage"],
                "reduce_only": True,
            })
            decision = RiskDecision(signal_id=exit_intent.signal_id, approved=True,
                                    approved_leverage=trade["approved_leverage"], reason="REDUCE_ONLY_EXIT")
            try:
                self.router.route(exit_intent, risk_decision=decision)
            except RouterError as error:
                log_event("paper_exit_failed", signal_id=exit_intent.signal_id, reason=str(error))
                if "DUPLICATE_SIGNAL" in str(error):
                    continue
                # Unknown exit state: stop processing this trade, halt new
                # risk, and leave it for reconciliation to flag.
                self.router.kill(f"EXIT_ROUTE_FAILED: {exit_intent.signal_id}")
                break
            realized = lifecycle.pnl(trade["direction"], trade["entry_fill"], event.fill_price, event.quantity)
            exit_fee = lifecycle.fee(event.fill_price, event.quantity)
            if self.ledger.apply_exit(trade, event.kind, event.quantity, event.fill_price, event.level, realized, exit_fee,
                                      abs(event.fill_price - event.level) * event.quantity, event.at_ms):
                result.exits.append({"kind": event.kind, "quantity": event.quantity, "fill_price": event.fill_price, "pnl": realized})
                log_event("paper_exit", signal_id=trade["trade_id"], reason=event.kind)
        last_close = fresh[-1]["close"]
        if trade["status"] != "CLOSED":
            unrealized = lifecycle.pnl(trade["direction"], trade["entry_fill"], last_close, trade["remaining_qty"])
            self.ledger.update_mark(trade, last_close, fresh[-1]["time"], unrealized)
        result.mark_price = last_close
        self.ledger.record_equity(now_ms)
        return result

    # ---- reconciliation ------------------------------------------------
    def reconcile_ledger(self, portfolio_positions: list[dict]) -> dict:
        """The paper ledger and the canonical portfolio are two records of
        the same NAUTILUS_NATIVE fills; they must agree per instrument."""
        expected: dict[str, float] = {}
        paper_instruments = set()
        for trade in self.ledger.trades():
            paper_instruments.add(trade["instrument"])
            if trade["status"] == "CLOSED":
                continue
            signed = trade["remaining_qty"] if trade["direction"] == "long" else -trade["remaining_qty"]
            expected[trade["instrument"]] = expected.get(trade["instrument"], 0.0) + signed
        # Only instruments the paper session has traded are the ledger's to
        # vouch for; fills from the raw /execution/* endpoints are not paper trades.
        actual = {p["instrument"]: p["quantity"] for p in portfolio_positions if p["instrument"] in paper_instruments}
        mismatched = []
        for instrument in paper_instruments:
            if abs(expected.get(instrument, 0.0) - actual.get(instrument, 0.0)) > 1e-6 * max(1.0, abs(expected.get(instrument, 0.0))):
                mismatched.append({"instrument": instrument, "ledger": expected.get(instrument, 0.0), "portfolio": actual.get(instrument, 0.0)})
        return {"reconciled": not mismatched, "mismatched": mismatched}


def leverage_for_cycle(cycle: int, rotation: Optional[list[float]] = None) -> float:
    """Paper leverage testing: rotate the *requested* leverage through the
    configured bands. Risk still approves or walks it down per trade, and
    leverage never changes the size or the allowed loss."""
    bands = rotation or [1.0]
    for band in bands:
        if band not in LEVERAGE_BANDS:
            raise ValueError(f"leverage {band} not in {LEVERAGE_BANDS}")
    return float(bands[cycle % len(bands)])
