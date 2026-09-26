"""Translates the bridge's narrow API into calls against the real
Hummingbot API project (https://hummingbot.org/hummingbot-api/) -- NOT
Gateway. Gateway (port 15888) is DEX/AMM-only middleware; this project's own
docs (hummingbot.org/hummingbot-api/routers/) are the documented surface for
CEX control, Binance included. See hummingbot-service/README.md
"Architecture correction" for the research trail that found this.

Endpoint paths below (POST /trading/orders, POST
/trading/{account}/{connector}/orders/{id}/cancel, POST /trading/positions,
GET /) are copied verbatim from the official routers doc page. The request/
response FIELD NAMES are this bridge's best-effort mapping from Hummingbot's
own bot-orchestration conventions (account_name/connector_name/trading_pair/
trade_type/order_type/amount) -- the docs page does not publish exact body
schemas, only endpoint paths, so these are NOT independently confirmed yet.
The correct way to confirm them is to bring the real hummingbot-api
container up (CI does this) and diff this mapping against its live
GET /openapi.json -- flagged in the CI job as the still-open verification
step. Do not report this client's request bodies as proven correct until
that diff has actually been done against a live container.
"""
from __future__ import annotations

import time

import httpx


class HummingbotApiClient:
    def __init__(
        self, base_url: str, username: str = "", password: str = "",
        account_name: str = "market_edge", connector_name: str = "binance_perpetual",
        timeout_s: float = 10.0, transport: httpx.BaseTransport = None,
    ):
        auth = (username, password) if username else None
        self._client = httpx.Client(base_url=base_url, auth=auth, timeout=timeout_s, transport=transport)
        self._account_name = account_name
        self._connector_name = connector_name

    def health(self) -> bool:
        # GET / is documented as needing no auth, unlike every other endpoint.
        try:
            response = self._client.get("/")
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    def place_order(self, order: dict) -> dict:
        payload = {
            "account_name": order.get("account_name", self._account_name),
            "connector_name": order.get("connector", self._connector_name),
            "trading_pair": order["instrument"].replace("-PERP", "-USDT"),
            "trade_type": order["side"].upper(),
            "amount": order["quantity"],
            "order_type": order["order_type"],
            "price": order.get("price"),
            "position_action": "CLOSE" if order.get("reduce_only") else "OPEN",
            "leverage": order.get("leverage", 1),
            "client_order_id": order["client_order_id"],
        }
        response = self._client.post("/trading/orders", json=payload)
        response.raise_for_status()
        body = response.json()
        return {
            "backend_order_id": body.get("order_id", body.get("client_order_id")),
            "status": body.get("status", "SUBMITTED"), "quantity_filled": body.get("filled_amount", 0),
            "avg_price": body.get("average_price"), "fee": body.get("fee", 0.0), "timestamp": int(time.time() * 1000),
        }

    def cancel_order(self, client_order_id: str, connector: str = None) -> dict:
        connector_name = connector or self._connector_name
        response = self._client.post(f"/trading/{self._account_name}/{connector_name}/orders/{client_order_id}/cancel")
        response.raise_for_status()
        body = response.json()
        return {"backend_order_id": body.get("order_id", client_order_id), "quantity_filled": body.get("filled_amount", 0), "timestamp": int(time.time() * 1000)}

    def positions(self) -> list[dict]:
        response = self._client.post("/trading/positions", json={"account_names": [self._account_name]})
        response.raise_for_status()
        body = response.json()
        entries = body if isinstance(body, list) else body.get("positions", [])
        return [{"instrument": p.get("trading_pair", p.get("tradingPair")), "quantity": p.get("amount", p.get("quantity"))} for p in entries]
