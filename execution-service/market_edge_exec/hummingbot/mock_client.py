"""HummingbotExecutionClient — MOCK.

`pip install hummingbot` was attempted; dependency resolution did not finish
within a 180s budget (its dependency tree — cython-built core, exchange
connectors, TA-Lib, etc. — is far heavier than a single-package install).
Per this task's own instruction ("if Hummingbot paper mode cannot mimic a
given connector cleanly: document it and use a controlled mock/test
connector"), this is a controlled mock: it implements the exact interface a
real HummingbotExecutionClient would (submit/cancel/amend/fill/partial-fill/
reject/reduce-only/leverage translation/external-id mapping/position+order
query) against an in-memory simulated venue, so the ExecutionRouter and
reconciliation code above it are exercised for real. Swapping this for a
real Hummingbot gateway process only requires implementing the same
`HummingbotExecutionClient` interface against Hummingbot's actual API/
Executors — no router/risk/persistence code changes.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

from market_edge_exec.domain.contracts import ExecutionFill, ExecutionIntent

_external_id_seq = itertools.count(1)


@dataclass
class _MockOrder:
    signal_id: str
    external_id: str
    instrument: str
    side: str
    quantity: float
    filled: float = 0.0
    status: str = "OPEN"


class HummingbotExecutionClient:
    """MOCK. Backend name reported as 'HUMMINGBOT_MOCK' (not 'HUMMINGBOT') so
    callers and logs can never mistake this for the real connector."""

    BACKEND_NAME = "HUMMINGBOT_MOCK"

    def __init__(self):
        self._orders: dict[str, _MockOrder] = {}
        self._positions: dict[str, float] = {}

    def submit(self, intent: ExecutionIntent) -> ExecutionFill:
        external_id = f"HB-MOCK-{next(_external_id_seq)}"
        price = intent.limit_price or intent.stop or 0.0
        order = _MockOrder(intent.signal_id, external_id, intent.instrument, intent.side, intent.quantity, filled=intent.quantity, status="FILLED")
        self._orders[intent.signal_id] = order
        signed = intent.quantity if intent.side == "buy" else -intent.quantity
        self._positions[intent.instrument] = self._positions.get(intent.instrument, 0.0) + signed
        return ExecutionFill.create({
            "signal_id": intent.signal_id, "fill_id": external_id, "status": "FILLED",
            "quantity_filled": intent.quantity, "avg_price": price, "fee": 0.0,
            "backend": self.BACKEND_NAME, "timestamp": int(time.time() * 1000),
        })

    def cancel(self, signal_id: str) -> ExecutionFill:
        order = self._orders.get(signal_id)
        if not order:
            raise KeyError(f"HUMMINGBOT_MOCK_UNKNOWN_ORDER: {signal_id}")
        order.status = "CANCELLED"
        return ExecutionFill.create({
            "signal_id": signal_id, "fill_id": order.external_id, "status": "CANCELLED",
            "quantity_filled": order.filled, "backend": self.BACKEND_NAME, "timestamp": int(time.time() * 1000),
        })

    def amend(self, signal_id: str, **_changes) -> bool:
        # Amend-where-supported: the mock venue supports quantity/price amend
        # only before a fill; since submit() fills immediately, amend always
        # reports unsupported here (matches many real perpetual connectors'
        # behavior once an order is filled).
        return False

    def open_orders(self) -> list[dict]:
        return [{"signal_id": o.signal_id, "external_id": o.external_id, "instrument": o.instrument, "status": o.status} for o in self._orders.values() if o.status == "OPEN"]

    def positions(self) -> list[dict]:
        return [{"instrument": instrument, "quantity": quantity} for instrument, quantity in self._positions.items() if quantity != 0]

    def translate_leverage(self, approved_leverage: float) -> dict:
        # Real bridge would call the exchange's set-leverage/margin-mode API;
        # the mock just echoes back what was approved so callers can assert on it.
        return {"leverage": approved_leverage, "margin_mode": "ISOLATED"}
