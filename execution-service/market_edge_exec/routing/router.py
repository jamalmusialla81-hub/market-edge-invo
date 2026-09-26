"""ExecutionRouter (Python side) — mirrors research/execution-architecture/execution-router.js.

Idempotency here is persistence-backed (Store.record_intent raises
DuplicateSignalError on a UNIQUE violation), so a duplicate signal_id is
caught even across a process restart, not just within one process's memory.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from market_edge_exec.domain.contracts import ExecutionFill, ExecutionIntent, RiskDecision
from market_edge_exec.persistence.store import DuplicateSignalError, Store
from market_edge_exec.telemetry.logging import log_event

BACKEND_NAUTILUS_NATIVE = "NAUTILUS_NATIVE"
BACKEND_HUMMINGBOT = "HUMMINGBOT"
BACKEND_FUTURE_BROKER = "FUTURE_BROKER"


class RouterError(Exception):
    pass


@dataclass
class ExecutionRouter:
    store: Store
    risk_gate: Callable[[ExecutionIntent], RiskDecision]
    backends: dict  # backend name -> object with .submit(intent) -> ExecutionFill
    routing_table: dict = None
    killed: bool = False

    def __post_init__(self):
        self.routing_table = self.routing_table or {}

    def _resolve_backend(self, intent: ExecutionIntent) -> str:
        if intent.venue_preference and intent.venue_preference in self.backends:
            return intent.venue_preference
        configured = self.routing_table.get(intent.instrument)
        if configured and configured in self.backends:
            return configured
        if BACKEND_NAUTILUS_NATIVE in self.backends:
            return BACKEND_NAUTILUS_NATIVE
        if not self.backends:
            raise RouterError("EXECUTION_ROUTER_NO_BACKENDS_CONFIGURED")
        return next(iter(self.backends))

    def route(self, intent: ExecutionIntent, risk_decision: Optional[RiskDecision] = None) -> tuple[str, ExecutionFill]:
        log_event("signal_received", signal_id=intent.signal_id, strategy_id=intent.strategy_id, instrument=intent.instrument)

        if self.killed:
            self.store.record_failure(intent.signal_id, "KILL_SWITCH_ACTIVE")
            log_event("risk_rejected", signal_id=intent.signal_id, reason="KILL_SWITCH_ACTIVE")
            raise RouterError("EXECUTION_ROUTER_KILLED")

        try:
            self.store.record_intent(intent.to_dict())
        except DuplicateSignalError:
            log_event("duplicate_blocked", signal_id=intent.signal_id)
            raise RouterError(f"EXECUTION_ROUTER_DUPLICATE_SIGNAL: {intent.signal_id}")

        approval = risk_decision or self.risk_gate(intent)
        if not approval.approved:
            self.store.record_failure(intent.signal_id, approval.reason or "RISK_REJECTED")
            log_event("risk_rejected", signal_id=intent.signal_id, reason=approval.reason)
            raise RouterError(f"EXECUTION_ROUTER_RISK_REJECTED: {approval.reason}")
        if approval.approved_leverage is not None and intent.leverage > approval.approved_leverage:
            self.store.record_failure(intent.signal_id, "LEVERAGE_EXCEEDS_APPROVAL")
            log_event("risk_rejected", signal_id=intent.signal_id, reason="LEVERAGE_EXCEEDS_APPROVAL")
            raise RouterError(f"EXECUTION_ROUTER_LEVERAGE_EXCEEDS_APPROVAL: requested {intent.leverage} > approved {approval.approved_leverage}")
        log_event("risk_accepted", signal_id=intent.signal_id)

        backend_name = self._resolve_backend(intent)
        backend = self.backends.get(backend_name)
        if not backend:
            raise RouterError(f"EXECUTION_ROUTER_BACKEND_UNAVAILABLE: {backend_name}")
        log_event("route_selected", signal_id=intent.signal_id, backend=backend_name)

        try:
            fill = backend.submit(intent)
        except Exception as error:
            # Fail closed: a backend timeout/disconnect must not leave this
            # signal_id in limbo (intent recorded, no order/failure row) --
            # that would make it un-retryable (idempotency already consumed
            # signal_id) while reconciliation has nothing to flag. Recording
            # SUBMIT_FAILED_UNKNOWN means the order status is honestly
            # "we don't know if the backend accepted this", not "no order
            # exists" -- reconcile()'s missing_fills check treats this
            # signal_id as needing a fill that never arrived, per Part H
            # ("expected: fail closed").
            self.store.upsert_order(intent.signal_id, backend_name, "SUBMIT_FAILED_UNKNOWN")
            self.store.record_failure(intent.signal_id, f"BACKEND_SUBMIT_FAILED: {error}")
            log_event("backend_disconnect", signal_id=intent.signal_id, backend=backend_name, reason=str(error))
            raise RouterError(f"EXECUTION_ROUTER_BACKEND_SUBMIT_FAILED: {backend_name}: {error}") from error
        self.store.upsert_order(intent.signal_id, backend_name, fill.status, external_id=fill.fill_id)
        self.store.record_fill(fill.to_dict())
        log_event("order_submitted", signal_id=intent.signal_id, backend=backend_name)
        log_event("fill" if fill.status == "FILLED" else fill.status.lower(), signal_id=intent.signal_id, backend=backend_name)
        return backend_name, fill

    def cancel(self, signal_id: str, backend_name: str) -> ExecutionFill:
        backend = self.backends.get(backend_name)
        if not backend:
            raise RouterError(f"EXECUTION_ROUTER_BACKEND_UNAVAILABLE: {backend_name}")
        fill = backend.cancel(signal_id)
        self.store.upsert_order(signal_id, backend_name, fill.status, external_id=fill.fill_id)
        log_event("cancel", signal_id=signal_id, backend=backend_name)
        return fill

    def kill(self) -> None:
        self.killed = True
        log_event("kill_switch_engaged")
