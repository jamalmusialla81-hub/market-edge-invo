"""Translates the bridge's narrow API into calls against Hummingbot's own
Gateway/REST interface (https://hummingbot.org/gateway/). This module talks
to whatever HUMMINGBOT_GATEWAY_URL points at -- in production that's the
`hummingbot` container from docker-compose.yml; in tests it's a fake server
(tests/test_bridge_contract.py) since no real Hummingbot instance has been
run in this environment.
"""
from __future__ import annotations

import time

import httpx


class HummingbotGatewayClient:
    def __init__(self, base_url: str, timeout_s: float = 10.0, transport: httpx.BaseTransport = None):
        self._client = httpx.Client(base_url=base_url, timeout=timeout_s, transport=transport)

    def health(self) -> bool:
        try:
            response = self._client.get("/health")
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    def place_order(self, order: dict) -> dict:
        # Hummingbot's Gateway order endpoint shape; translated 1:1 from the
        # bridge's ExecutionIntent-shaped payload to Gateway's connector/
        # trading_pair/side/amount/type fields.
        gateway_payload = {
            "clientOrderId": order["client_order_id"], "connector": order.get("connector", "binance_perpetual"),
            "tradingPair": order["instrument"].replace("-PERP", "-USDT"), "side": order["side"].upper(),
            "amount": order["quantity"], "orderType": order["order_type"], "price": order.get("price"),
            "reduceOnly": order.get("reduce_only", False), "leverage": order.get("leverage", 1),
        }
        response = self._client.post("/orders", json=gateway_payload)
        response.raise_for_status()
        body = response.json()
        return {
            "backend_order_id": body.get("exchangeOrderId", body.get("clientOrderId")),
            "status": body.get("status", "SUBMITTED"), "quantity_filled": body.get("filledAmount", 0),
            "avg_price": body.get("averagePrice"), "fee": body.get("fee", 0.0), "timestamp": int(time.time() * 1000),
        }

    def cancel_order(self, client_order_id: str) -> dict:
        response = self._client.delete(f"/orders/{client_order_id}")
        response.raise_for_status()
        body = response.json()
        return {"backend_order_id": body.get("exchangeOrderId", client_order_id), "quantity_filled": body.get("filledAmount", 0), "timestamp": int(time.time() * 1000)}

    def positions(self) -> list[dict]:
        response = self._client.get("/positions")
        response.raise_for_status()
        return [{"instrument": p["tradingPair"], "quantity": p["amount"]} for p in response.json().get("positions", [])]
