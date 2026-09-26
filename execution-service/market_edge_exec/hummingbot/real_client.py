"""HummingbotExecutionClientReal — talks HTTP to the bridge in
hummingbot-service/ (see that directory's README). This is REAL code: it
makes real HTTP calls with the real request/response shapes the bridge
defines. What is NOT verified in this environment is the bridge's other
side actually running Hummingbot (no Docker daemon is available in this
sandbox -- `docker version` finds the CLI but cannot reach a daemon socket,
so the container was never built or run here). Tests exercise this client
against a local fake HTTP server standing in for the bridge
(tests/test_hummingbot_real_client.py), which proves this client's request/
response handling, NOT that Hummingbot itself behaves as expected.

Per the explicit instruction "never silently fall back from REAL -> MOCK":
this class raises HummingbotBridgeUnavailable on any connection failure. It
never falls back to HummingbotExecutionClient (the mock). Callers that want
a fallback must catch this exception and decide explicitly -- the router
never does this automatically.
"""
from __future__ import annotations

import httpx

from market_edge_exec.domain.contracts import ExecutionFill, ExecutionIntent


class HummingbotBridgeUnavailable(Exception):
    pass


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
        return ExecutionFill.create({
            "signal_id": intent.signal_id, "fill_id": body["backend_order_id"], "status": body["status"],
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
        return response.json().get("positions", [])
