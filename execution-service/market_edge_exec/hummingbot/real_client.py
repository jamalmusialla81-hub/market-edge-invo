"""HummingbotExecutionClientReal: talks HTTP to the bridge in
hummingbot-service/, which talks to the real Hummingbot API (v1.0.1). The
bridge's request side is checked against the live API schema in CI
(hummingbot-service/verify_openapi.py). What is not yet proven is a real
order on an exchange: that needs Binance testnet keys.

The Hummingbot API only acknowledges an order ("submitted"); the bridge
polls it to a real state. Anything not final (OPEN/SUBMITTED/PENDING_CANCEL)
raises HummingbotOrderNotFinal instead of being reported as a fill or a
cancel.

Never falls back to the mock: any bridge failure raises
HummingbotBridgeUnavailable, and the router records it fail-closed.
"""
from __future__ import annotations

import httpx

from market_edge_exec.domain.contracts import ExecutionFill, ExecutionIntent


class HummingbotBridgeUnavailable(Exception):
    pass


class HummingbotOrderNotFinal(HummingbotBridgeUnavailable):
    """The order was sent but its outcome is not final yet (OPEN/SUBMITTED/
    PENDING_CANCEL). Raised instead of inventing a fill or a cancel; the
    router records it as SUBMIT_FAILED_UNKNOWN and reconciliation owns it."""


# Bridge status (from the live Hummingbot API) -> ExecutionFill status.
FINAL_STATUS = {"FILLED": "FILLED", "PARTIALLY_FILLED": "PARTIALLY_FILLED", "CANCELLED": "CANCELLED", "FAILED": "REJECTED"}


class HummingbotExecutionClientReal:
    BACKEND_NAME = "HUMMINGBOT"  # only this class may report the real name

    def __init__(self, base_url: str, api_key: str, timeout_s: float = 5.0):
        self._client = httpx.Client(base_url=base_url, headers={"X-Bridge-Key": api_key}, timeout=timeout_s)

    def submit(self, intent: ExecutionIntent) -> ExecutionFill:
        payload = {
            "client_order_id": intent.signal_id, "instrument": intent.instrument, "side": intent.side,
            "quantity": intent.quantity, "order_type": intent.order_type, "price": intent.limit_price,
            "reduce_only": intent.reduce_only, "leverage": intent.leverage, "time_in_force": intent.time_in_force,
        }
        try:
            response = self._client.post("/orders", json=payload)
        except httpx.HTTPError as error:
            raise HummingbotBridgeUnavailable(f"HUMMINGBOT_BRIDGE_UNREACHABLE: {error}") from error
        if response.status_code >= 400:
            raise HummingbotBridgeUnavailable(f"HUMMINGBOT_BRIDGE_ERROR: {response.status_code} {response.text}")
        body = response.json()
        status = FINAL_STATUS.get(str(body.get("status", "")).upper())
        if status is None:
            raise HummingbotOrderNotFinal(f"HUMMINGBOT_ORDER_NOT_FINAL: {body.get('backend_order_id')} is {body.get('status')}")
        return ExecutionFill.create({
            "signal_id": intent.signal_id, "fill_id": body["backend_order_id"], "status": status,
            "quantity_filled": body.get("quantity_filled", 0), "avg_price": body.get("avg_price"),
            "fee": body.get("fee", 0.0), "backend": self.BACKEND_NAME, "timestamp": body.get("timestamp", 0),
        })

    def cancel(self, signal_id: str) -> ExecutionFill:
        try:
            response = self._client.delete(f"/orders/{signal_id}")
        except httpx.HTTPError as error:
            raise HummingbotBridgeUnavailable(f"HUMMINGBOT_BRIDGE_UNREACHABLE: {error}") from error
        if response.status_code >= 400:
            raise HummingbotBridgeUnavailable(f"HUMMINGBOT_BRIDGE_ERROR: {response.status_code} {response.text}")
        body = response.json()
        if str(body.get("status", "")).upper() != "CANCELLED":
            raise HummingbotOrderNotFinal(f"HUMMINGBOT_CANCEL_NOT_CONFIRMED: {signal_id} is {body.get('status')}")
        return ExecutionFill.create({
            "signal_id": signal_id, "fill_id": body.get("backend_order_id", signal_id), "status": "CANCELLED",
            "quantity_filled": body.get("quantity_filled", 0), "backend": self.BACKEND_NAME, "timestamp": body.get("timestamp", 0),
        })

    def health(self) -> bool:
        try:
            response = self._client.get("/health")
            return response.status_code == 200 and response.json().get("status") == "ok"
        except httpx.HTTPError:
            return False

    def positions(self) -> list[dict]:
        try:
            response = self._client.get("/positions")
        except httpx.HTTPError as error:
            raise HummingbotBridgeUnavailable(f"HUMMINGBOT_BRIDGE_UNREACHABLE: {error}") from error
        # An error body must never read as "no positions" (e.g. while
        # Hummingbot restarts), or reconciliation would pass on stale truth.
        if response.status_code >= 400:
            raise HummingbotBridgeUnavailable(f"HUMMINGBOT_BRIDGE_ERROR: {response.status_code} {response.text}")
        return response.json()["positions"]
