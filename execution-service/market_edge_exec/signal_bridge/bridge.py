"""Part E: real Market Edge signal -> paper execution bridge.

Converts a production AlphaSignal (asset/direction/entry/stop/targets, as
produced by backend/scan-core.mjs's runLiveScan().bestTradeNow -- see
../../../signal-bridge/fetch_signal.mjs for the read-only Node-side fetch)
into a correctly-sized ExecutionIntent and runs it through the existing
risk gate + router, unchanged.

Two things this module owns that did not exist before Part E:

1. Freshness validation. Market Edge's production scan runs on a 5-minute
   cron (backend/wrangler.jsonc). A signal bridge polling on roughly that
   cadence should never act on a scan result older than a couple of missed
   cycles -- that would mean the bridge fell behind, not that the trade is
   still valid. MAX_SIGNAL_AGE_SECONDS is set to 2x the observed cadence.
2. Correct position sizing. The execution-service's existing
   ExecutionIntent contract requires a `quantity` field (see domain/
   contracts.py), and existing tests supply one directly and expect it to
   flow straight through the router unchanged -- that behavior is left
   alone. But alpha (Market Edge) does not, and per the architecture must
   not, decide position size -- risk does, via
   position_size = risk_budget / stop_distance (risk/engine.py). This
   module is what actually enforces that split for signal-sourced trades:
   it builds a provisional intent, asks risk.approve() for the real sizing,
   overwrites the intent's quantity with that computed size, and only then
   routes -- so a signal's own numbers can never set the traded size.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from market_edge_exec.domain.contracts import AlphaSignal, ContractError, ExecutionIntent
from market_edge_exec.persistence.store import Store
from market_edge_exec.risk.engine import AccountState, RiskAssessment, RiskLimits, approve
from market_edge_exec.routing.router import ExecutionRouter, RouterError
from market_edge_exec.telemetry.logging import log_event

MAX_SIGNAL_AGE_SECONDS = 600  # 2x Market Edge's 5-minute scan cadence (backend/wrangler.jsonc)

DIRECTION_TO_SIDE = {"long": "buy", "short": "sell"}


class SignalBridgeError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class SignalBridgeResult:
    signal_id: str
    accepted: bool
    reason: Optional[str] = None
    backend: Optional[str] = None
    fill: Optional[dict] = None
    assessment: Optional[RiskAssessment] = None


def is_fresh(signal: AlphaSignal, now_ms: int, max_age_seconds: int = MAX_SIGNAL_AGE_SECONDS) -> bool:
    age_seconds = (now_ms - signal.timestamp) / 1000.0
    return 0 <= age_seconds <= max_age_seconds


def signal_to_provisional_intent(signal: AlphaSignal, instrument: str, venue_preference: Optional[str] = None) -> ExecutionIntent:
    """Builds an ExecutionIntent with a placeholder quantity -- caller MUST
    replace it with risk.approve()'s position_size before routing. The
    placeholder exists only because ExecutionIntent.create requires a
    quantity field; it is never the size that gets executed."""
    if signal.direction not in DIRECTION_TO_SIDE:
        raise SignalBridgeError(f"UNKNOWN_DIRECTION: {signal.direction}")
    if signal.entry is None or signal.stop is None:
        raise SignalBridgeError("SIGNAL_MISSING_ENTRY_OR_STOP")
    return ExecutionIntent.create({
        "signal_id": signal.signal_id, "instrument": instrument, "side": DIRECTION_TO_SIDE[signal.direction],
        "quantity": 0.0, "order_type": "MARKET", "strategy_id": signal.strategy_id or "market-edge-alpha",
        "limit_price": signal.entry, "stop": signal.stop, "targets": list(signal.targets),
        "leverage": 1, "venue_preference": venue_preference,
    })


def process_signal(signal_payload: dict, instrument: str, router: ExecutionRouter, account: AccountState,
                    store: Store, limits: RiskLimits = RiskLimits(), venue_preference: Optional[str] = None,
                    now_ms: Optional[int] = None) -> SignalBridgeResult:
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)

    try:
        signal = AlphaSignal.create(signal_payload)
    except ContractError as error:
        raise SignalBridgeError(f"INVALID_SIGNAL: {error}") from error

    if not is_fresh(signal, now_ms):
        store.record_failure(signal.signal_id, "STALE_SIGNAL")
        log_event("signal_rejected", signal_id=signal.signal_id, reason="STALE_SIGNAL")
        return SignalBridgeResult(signal_id=signal.signal_id, accepted=False, reason="STALE_SIGNAL")

    try:
        provisional = signal_to_provisional_intent(signal, instrument, venue_preference)
    except SignalBridgeError as error:
        store.record_failure(signal.signal_id, error.reason)
        log_event("signal_rejected", signal_id=signal.signal_id, reason=error.reason)
        return SignalBridgeResult(signal_id=signal.signal_id, accepted=False, reason=error.reason)

    assessment = approve(provisional, account, limits)
    if not assessment.decision.approved:
        store.record_failure(signal.signal_id, assessment.decision.reason or "RISK_REJECTED")
        log_event("signal_rejected", signal_id=signal.signal_id, reason=assessment.decision.reason)
        return SignalBridgeResult(signal_id=signal.signal_id, accepted=False, reason=assessment.decision.reason, assessment=assessment)

    # Risk owns sizing: the signal's own numbers never set the traded quantity.
    sized_intent = ExecutionIntent.create({**provisional.to_dict(), "quantity": assessment.position_size})

    try:
        backend_name, fill = router.route(sized_intent, risk_decision=assessment.decision)
    except RouterError as error:
        return SignalBridgeResult(signal_id=signal.signal_id, accepted=False, reason=str(error), assessment=assessment)

    return SignalBridgeResult(signal_id=signal.signal_id, accepted=True, backend=backend_name, fill=fill.to_dict(), assessment=assessment)
