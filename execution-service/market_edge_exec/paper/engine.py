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

import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from market_edge_exec.exits.shadow import ExitShadow
from market_edge_exec.domain.contracts import AlphaSignal, ContractError, ExecutionIntent, RiskDecision
from market_edge_exec.paper import lifecycle
from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.persistence.store import Store
from dataclasses import replace as _replace

from market_edge_exec.risk import sizing_runtime
from market_edge_exec.risk import sizing_v2
from market_edge_exec.risk.engine import LEVERAGE_BANDS, RiskLimits, approve
from market_edge_exec.routing.router import ExecutionRouter, RouterError
from market_edge_exec.signal_bridge.bridge import DIRECTION_TO_SIDE, MAX_SIGNAL_AGE_SECONDS, is_fresh
from market_edge_exec.telemetry.logging import log_event

EXECUTION_MODE = "PAPER"
MAX_MARK_AGE_SECONDS = 120  # a mark older than this is stale market data: no new entries
# Open-position monitor (signal-bridge/position_monitor.mjs) posts a live
# price every ~10s. A price older than this is STALE for position management:
# it is not evaluated and the position is flagged, never marked with it.
# Stricter than the entry guard, and never looser than the operator's
# stale-data timeout (min of the two applies).
MONITOR_MAX_PRICE_AGE_SECONDS = 30
# Which path observed the price that fired an exit. Recorded on the exit.
TRIGGER_SOURCES = ("WS_TRADE", "POLL_HEARTBEAT")
MONITOR_LIVE, MONITOR_STALE, MONITOR_OFFLINE = "LIVE", "STALE", "MARKET_DATA_OFFLINE"


@dataclass
class EntryResult:
    signal_id: Optional[str]
    accepted: bool
    reason: Optional[str] = None
    trade: Optional[dict] = None


@dataclass
class TickResult:
    instrument: str
    exits: list = field(default_factory=list)
    price: Optional[float] = None
    skipped: Optional[str] = None
    monitor_status: Optional[str] = None


def _finite_positive(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and 0 < value < float("inf")


def update_excursions(trade: dict, prices, at_ms: Optional[int] = None, precision: Optional[str] = None) -> None:
    """Highest favourable / lowest adverse price since entry, from real
    observed prices only (trade prints, polled mids, completed candle
    highs/lows). Only ever widens, so a restart or an older price can never
    shrink a recorded MFE/MAE.

    When ``at_ms`` is given, a price that widens the best (worst) price also
    records ``best_price_at_ms`` (``worst_price_at_ms``) and its precision
    (TICK, STREAM_EXTREME_BY_HEARTBEAT, CANDLE_CLOSE_BOUND). The time is the
    observation time of the widening price, never a finer time than the data
    supports; an equal or worse price never moves an existing timestamp.
    Bookkeeping only: no exit logic reads it."""
    seen = [p for p in prices if _finite_positive(p)]
    if not seen:
        return
    stamp = isinstance(at_ms, int) and not isinstance(at_ms, bool)
    long = trade["direction"] == "long"
    best = trade.get("best_price") or trade["entry_fill"]
    worst = trade.get("worst_price") or trade["entry_fill"]
    for p in seen:
        if (p > best) if long else (p < best):
            best = p
            if stamp:
                trade["best_price_at_ms"], trade["best_price_precision"] = at_ms, precision
        if (p < worst) if long else (p > worst):
            worst = p
            if stamp:
                trade["worst_price_at_ms"], trade["worst_price_precision"] = at_ms, precision
    trade["best_price"], trade["worst_price"] = best, worst


def freshest_price(trade: dict) -> tuple[Optional[float], Optional[int], Optional[str]]:
    """The most recent real price we hold for a trade: the monitor's live
    price, or the last completed 5m candle close (its close time is the
    candle open + 5m). Never a synthetic value."""
    live = (trade.get("last_price"), trade.get("last_price_at_ms"), trade.get("last_price_source"))
    candle_at = (trade["last_checked_ms"] + 300_000) if trade.get("mark_price") and trade.get("last_checked_ms") != trade["opened_at_ms"] else None
    candle = (trade.get("mark_price"), candle_at, "HYPERLIQUID_CANDLE_5M_CLOSE")
    if live[0] and (candle_at is None or (live[1] or 0) >= candle_at):
        return live
    if candle_at is not None:
        return candle
    return (None, None, None)


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
                 max_mark_age_provider: Optional[Callable[[], float]] = None,
                 sizing_mode: Optional[str] = None):
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
        # Risk Sizing V2 rollout: SHADOW (default) computes and records V2 as a
        # counterfactual while the existing sizing stays authoritative; PAPER
        # makes V2 authoritative (all existing gates still apply on top).
        self.sizing_mode = sizing_mode if sizing_mode in (sizing_v2.MODE_SHADOW, sizing_v2.MODE_PAPER) else sizing_runtime.mode_from_env()
        # The 5m candle sweep (discovery loop) and the fast position monitor
        # can both reach the same trade at once; each read-evaluate-write of a
        # trade's lifecycle happens under this lock so neither overwrites the
        # other's exit or excursion update.
        self._lifecycle_lock = threading.RLock()
        # Adaptive Exit Manager V1 (MAJOR 3): RESEARCH ONLY. Records what this
        # engine observes and replays counterfactual exit policies beside it.
        # It only reads the trade dict, never writes a trade, and every call is
        # isolated so it cannot affect a real exit. MARKET_EDGE_EXIT_SHADOW=0 turns it off.
        self.exit_shadow = ExitShadow(ledger) if os.environ.get("MARKET_EDGE_EXIT_SHADOW", "1") != "0" else None

    def _closed(self, trade: dict) -> None:
        """Optional research hook run once a paper trade has closed (set by the
        app; used to copy execution quality into the research store). A failure
        here is logged and can never touch the trade."""
        hook = getattr(self, "on_trade_closed", None)
        if hook is not None and trade.get("status") == "CLOSED":
            try:
                hook(dict(trade))
            except Exception as error:  # noqa: BLE001
                log_event("trade_closed_hook_error", reason=str(error)[:300])

    def _shadow(self, label: str, method: str, *args) -> None:
        if self.exit_shadow is not None:
            self.exit_shadow.safe(label, getattr(self.exit_shadow, method), *args)

    def monitor_max_price_age_s(self) -> float:
        entry_guard = self._max_mark_age_provider() if self._max_mark_age_provider else MAX_MARK_AGE_SECONDS
        return float(min(MONITOR_MAX_PRICE_AGE_SECONDS, entry_guard))

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
                         market_price_source: str = "UNKNOWN", risk_inputs: Optional[dict] = None) -> EntryResult:
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
            account = self.ledger.account_state(killed=self.router.killed, now_ms=now_ms)
            limits = self.limits

            # ---- Risk Sizing V2 (read-only here; the entry lock is the reservation)
            mode = self.sizing_mode
            policy = sizing_runtime.effective_policy(limits)
            if mode == sizing_v2.MODE_PAPER:
                requested_leverage = min(float(requested_leverage or 1.0), policy.max_leverage)
            vol_in, depth_in, venue_rules = sizing_runtime.parse_inputs(risk_inputs)
            v2 = sizing_v2.size(sizing_v2.SizingRequest(
                asset=signal.asset, direction=signal.direction, entry_price=entry_fill, stop_price=signal.stop,
                equity=account.equity, peak_equity=account.peak_equity, open_positions=sizing_runtime.open_risks(self.ledger),
                now_ms=now_ms, vol=vol_in, depth=depth_in, venue=venue_rules, requested_leverage=requested_leverage,
                require_depth=True, provenance={"mark_price": mark_price, "mark_at_ms": mark_at_ms, "price_source": market_price_source,
                                                "vol_source": f"{vol_in.venue} {vol_in.interval}" if vol_in else None,
                                                "depth_source": depth_in.venue if depth_in else None,
                                                "depth_at_ms": depth_in.at_ms if depth_in else None}), policy)
            authoritative_v2 = mode == sizing_v2.MODE_PAPER
            v2_record = {**v2.record, "mode": mode, "role": "AUTHORITATIVE" if authoritative_v2 else "COUNTERFACTUAL",
                         "used_for_execution": authoritative_v2, "research_only": not authoritative_v2, "signal_id": sid}

            def record_v2(record: dict) -> str:
                return self.ledger.record_sizing(sid, signal.asset, mode, record["role"], record, at_ms=now_ms)

            # The drawdown pause applies in both modes: new entries stop at 15%.
            if v2.reason == sizing_v2.DRAWDOWN_RISK_PAUSE or (authoritative_v2 and not v2.approved):
                record_v2(v2_record)
                return self._reject(sid, v2.reason, payload, now_ms, outcome="RISK_REJECTED")

            provisional = ExecutionIntent.create({
                "signal_id": sid, "instrument": instrument, "side": side, "quantity": 0.0, "order_type": "MARKET",
                "strategy_id": signal.strategy_id or "market-edge-alpha", "limit_price": entry_fill, "stop": signal.stop,
                "targets": list(signal.targets), "leverage": requested_leverage, "venue_preference": venue_preference,
            })
            # The existing engine's gates always apply (kill switch, positions,
            # daily loss, 5%/20% caps, leverage vs liquidation). With V2
            # authoritative its "dust" floor is off: V2 deliberately
            # under-risks and has its own venue-minimum rule.
            gate_limits = _replace(limits, min_capped_risk_fraction=0.0) if authoritative_v2 else limits
            assessment = approve(provisional, account, gate_limits)
            if not assessment.decision.approved:
                record_v2(v2_record)
                return self._reject(sid, assessment.decision.reason or "RISK_REJECTED", payload, now_ms, outcome="RISK_REJECTED")

            leverage = float(assessment.decision.approved_leverage)
            # 8dp matches the portfolio's Nautilus Quantity precision, so the
            # ledger and the canonical position never drift by rounding.
            legacy_qty = round(assessment.position_size, 8)
            if authoritative_v2:
                quantity = min(v2.quantity, legacy_qty)
                if quantity < v2.quantity:
                    v2_record = sizing_runtime.rescale(v2_record, quantity, entry_fill, "LEGACY_V1_GATE")
            else:
                quantity = legacy_qty
            if quantity <= 0:
                record_v2(v2_record)
                return self._reject(sid, "SIZE_BELOW_PRECISION", payload, now_ms, outcome="RISK_REJECTED")
            sized = ExecutionIntent.create({**provisional.to_dict(), "quantity": quantity, "leverage": leverage})
            try:
                backend, fill = self.router.route(sized, risk_decision=assessment.decision)
            except RouterError as error:
                return self._reject(sid, f"ROUTER: {error}", payload, now_ms)

            qty = fill.quantity_filled
            entry_fee = lifecycle.fee(entry_fill, qty)
            if authoritative_v2:
                if qty != v2_record.get("final_quantity"):
                    v2_record = sizing_runtime.rescale(v2_record, qty, entry_fill)
                decision_id = record_v2(v2_record)
                auth = v2_record
                sizing_fields = {"notional": qty * entry_fill, "margin_used": qty * entry_fill / leverage,
                                 "risk_amount": qty * abs(entry_fill - signal.stop), "max_loss": qty * abs(entry_fill - signal.stop)}
            else:
                auth = sizing_runtime.legacy_record(assessment, account, entry_fill, signal.stop, signal.asset, signal.direction, qty, now_ms)
                auth.update({"mode": mode, "role": "AUTHORITATIVE", "used_for_execution": True, "signal_id": sid})
                decision_id = self.ledger.record_sizing(sid, signal.asset, mode, "AUTHORITATIVE", auth, at_ms=now_ms)
                record_v2(v2_record)
                sizing_fields = {}
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
                # Open-position monitor state, persisted so a restart resumes
                # it instead of resetting it.
                "best_price": entry_fill, "worst_price": entry_fill,
                "last_price": None, "last_price_at_ms": None, "last_price_source": None,
                "stop_status": "ACTIVE", "tp2_status": "PENDING" if tp2 is not None else "NONE",
                "tp1_fill_at_ms": None, "tp1_fill_price": None,
                "monitor_status": None, "monitor_detail": None,
                # Risk sizing: the authoritative ORIGINAL decision lives,
                # immutable, in risk_sizing_decisions; these are copies for views.
                "sizing_mode": mode, "sizing_decision_id": decision_id, "risk_policy_version": auth["sizing_rule_version"],
                "planned_loss_dollars": auth["planned_loss_dollars"], "planned_loss_pct_equity": auth["planned_loss_pct_equity"],
                "cluster_id": auth.get("cluster_id"), "sizing_binding_constraint": auth.get("sizing_binding_constraint"),
                **sizing_fields,
            }
            self.ledger.open_trade(trade)
            self.ledger.record_signal(sid, "EXECUTED", None, payload, at_ms=now_ms)
        log_event("paper_trade_opened", signal_id=sid, instrument=instrument, backend=backend)
        self.ledger.record_equity(now_ms)
        return EntryResult(signal_id=sid, accepted=True, trade=trade)

    # ---- lifecycle -----------------------------------------------------
    def _route_exits(self, trade: dict, instrument: str, events: list, trigger: str, observed_price: Optional[float] = None) -> list:
        """Route each exit as a reduce-only intent (so exits still go through
        when the kill switch is engaged) and apply it to the ledger. Intent ids
        are "<trade_id>:<KIND>", so the router and the ledger's UNIQUE event
        row each independently refuse a second TP1/TP2/stop."""
        side = lifecycle.exit_side(trade["direction"])
        exits = []
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
            extra = {"trigger": trigger}
            if observed_price is not None:
                extra["observed_price"] = observed_price
            if self.ledger.apply_exit(trade, event.kind, event.quantity, event.fill_price, event.level, realized, exit_fee,
                                      abs(event.fill_price - event.level) * event.quantity, event.at_ms, extra=extra):
                exits.append({"kind": event.kind, "quantity": event.quantity, "fill_price": event.fill_price, "pnl": realized,
                              "at_ms": event.at_ms, "trigger": trigger})
                log_event("paper_exit", signal_id=trade["trade_id"], reason=event.kind, trigger=trigger)
        return exits

    def _refresh_unrealized(self, trade: dict) -> None:
        price, _, _ = freshest_price(trade)
        if trade["status"] != "CLOSED" and price:
            trade["unrealized_pnl"] = lifecycle.pnl(trade["direction"], trade["entry_fill"], price, trade["remaining_qty"])

    def mark(self, instrument: str, candles: list[dict], now_ms: Optional[int] = None) -> MarkResult:
        """Advance every open trade on `instrument` through the completed
        candles observed since its last check. Exits route as reduce-only
        intents, so they still go through when the kill switch is engaged.

        This 5m sweep (run by the discovery loop) is also the backstop for
        the fast monitor: a crossing that happened between two monitor
        observations is still inside a completed candle's real high/low."""
        now_ms = now_ms or int(time.time() * 1000)
        result = MarkResult(instrument=instrument)
        with self._lifecycle_lock:
            trade = self.ledger.open_trade_for(instrument)
            if trade is None:
                result.skipped = "NO_OPEN_TRADE"
                return result
            fresh = [c for c in candles if c["time"] > trade["last_checked_ms"] and c["time"] > trade["opened_at_ms"]]
            if not fresh:
                result.skipped = "NO_NEW_CANDLES"
                return result
            fresh.sort(key=lambda c: c["time"])
            for c in fresh:
                # A candle's high/low happened somewhere inside it; its close
                # time is the latest it can have happened.
                update_excursions(trade, [c["high"], c["low"]], c["time"] + 300_000, "CANDLE_CLOSE_BOUND")
            events = lifecycle.advance(
                trade["direction"], trade["entry_fill"], trade["stop"], trade["tp1"], trade["tp2"], trade["remaining_qty"],
                trade["quantity"], trade["tp1_hit"], trade["opened_at_ms"], fresh, now_ms,
            )
            self._shadow("record_candles", "record_candles", trade, fresh, now_ms)
            result.exits = self._route_exits(trade, instrument, events, "CANDLE_5M")
            last_close = fresh[-1]["close"]
            if trade["status"] != "CLOSED":
                trade["mark_price"] = last_close
                trade["last_checked_ms"] = fresh[-1]["time"]
                self._refresh_unrealized(trade)
                self.ledger.save(trade)
            self._shadow("update", "update", trade, trade["status"] == "CLOSED")
            self._closed(trade)
            result.mark_price = last_close
        self.ledger.record_equity(now_ms)
        return result

    def tick(self, instrument: str, price, at_ms, source: str, trigger: str = "POLL_HEARTBEAT",
             observed_high=None, observed_low=None, now_ms: Optional[int] = None) -> TickResult:
        """Open-position monitor: evaluate ONLY position-management triggers
        (stop / TP1 / TP2 / timeout) for one real observed price. Never opens
        a trade. Fails closed: a missing, invalid, pre-entry or stale price
        is not evaluated and does not move the position's price."""
        now_ms = now_ms or int(time.time() * 1000)
        result = TickResult(instrument=instrument)
        if trigger not in TRIGGER_SOURCES:
            result.skipped = "UNKNOWN_TRIGGER"
            return result
        with self._lifecycle_lock:
            trade = self.ledger.open_trade_for(instrument)
            if trade is None:
                result.skipped = "NO_OPEN_TRADE"
                return result
            if not _finite_positive(price) or not isinstance(at_ms, int) or isinstance(at_ms, bool):
                result.skipped = "INVALID_PRICE"
                return result
            age_s = (now_ms - at_ms) / 1000.0
            if age_s > self.monitor_max_price_age_s():
                if trade.get("monitor_status") != MONITOR_OFFLINE:
                    trade["monitor_status"], trade["monitor_detail"] = MONITOR_STALE, f"price from {source} is {age_s:.0f}s old"
                    self.ledger.save(trade)
                result.skipped, result.monitor_status = "STALE_MARKET_DATA", trade.get("monitor_status")
                return result
            if at_ms < trade["opened_at_ms"]:
                result.skipped = "PRE_ENTRY_PRICE"
                return result
            # Observed extremes come from real exchange trade prints between
            # two monitor posts; they only widen MFE/MAE, they never trigger.
            extremes = [p for p in (observed_high, observed_low) if _finite_positive(p)]
            update_excursions(trade, [price], at_ms, "TICK")
            update_excursions(trade, extremes, at_ms, "STREAM_EXTREME_BY_HEARTBEAT")
            if at_ms >= (trade.get("last_price_at_ms") or 0):
                trade["last_price"], trade["last_price_at_ms"], trade["last_price_source"] = float(price), at_ms, source
            trade["monitor_status"], trade["monitor_detail"] = MONITOR_LIVE, None
            # A price observed before the latest recorded exit cannot fire
            # another one (e.g. a late stream print after TP1 already filled).
            last_exit_at = max((e["at_ms"] for e in trade.get("exits") or []), default=trade["opened_at_ms"])
            events = []
            if at_ms >= last_exit_at:
                events = lifecycle.evaluate_tick(
                    trade["direction"], trade["entry_fill"], trade["stop"], trade["tp1"], trade["tp2"], trade["remaining_qty"],
                    trade["quantity"], trade["tp1_hit"], trade["opened_at_ms"], float(price), at_ms,
                )
                self._shadow("record_tick", "record_tick", trade, float(price), at_ms, observed_high if _finite_positive(observed_high) else None,
                             observed_low if _finite_positive(observed_low) else None, now_ms)
            result.exits = self._route_exits(trade, instrument, events, trigger, observed_price=float(price))
            if trade["status"] != "CLOSED":
                self._refresh_unrealized(trade)
                self.ledger.save(trade)
            self._shadow("update", "update", trade, trade["status"] == "CLOSED")
            self._closed(trade)
            result.price, result.monitor_status = float(price), trade.get("monitor_status")
        if result.exits:
            self.ledger.record_equity(now_ms)
        return result

    def set_monitor_offline(self, instruments: list[str], detail: str) -> int:
        """The monitor could not read a live price: flag the positions (they
        stay open, keep their last real price and its age) -- never mark them."""
        flagged = 0
        with self._lifecycle_lock:
            for instrument in instruments:
                trade = self.ledger.open_trade_for(instrument)
                if trade is None:
                    continue
                trade["monitor_status"], trade["monitor_detail"] = MONITOR_OFFLINE, detail
                self.ledger.save(trade)
                flagged += 1
        return flagged

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
