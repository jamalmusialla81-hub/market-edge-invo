"""Client for the real Hummingbot API (hummingbot/hummingbot-api 1.0.1), not
Gateway (Gateway is DEX-only).

Every request below matches the live /openapi.json captured in CI, and every
response field is taken from the source running in that container
(routers/trading.py, services/perpetual_trading_service.py), because the
schema does not declare those response models. verify_openapi.py re-checks
the requests against the live schema on every CI run.

Facts from the live API that shape this client:
- POST /trading/orders (TradeRequest) has no client id and no leverage. It
  returns 201 {order_id, ..., status: "submitted"}: an acknowledgement, not a
  fill. Fill state has to be read back from /trading/orders/active (in-flight)
  or /trading/orders/search (history).
- Leverage is its own call: POST /trading/{account}/{connector}/leverage
  {trading_pair, leverage: int 1-125}.
- /trading/positions and /trading/orders/active return {data, pagination}
  and log-and-skip per-connector errors, so an empty list can mean "the
  connector failed". positions() therefore refuses to answer unless the
  connector is actually configured for the account.
"""
from __future__ import annotations

import time

import httpx

TERMINAL = {"FILLED", "CANCELLED", "FAILED"}


class HummingbotApiError(Exception):
    pass


def to_trading_pair(instrument: str) -> str:
    return instrument.replace("-PERP", "-USDT")


def to_instrument(trading_pair: str) -> str:
    return trading_pair.replace("-USDT", "-PERP")


class HummingbotApiClient:
    def __init__(
        self, base_url: str, username: str = "", password: str = "",
        account_name: str = "market_edge", connector_name: str = "binance_perpetual_testnet",
        timeout_s: float = 10.0, transport: httpx.BaseTransport = None,
        fill_wait_s: float = 10.0, poll_interval_s: float = 0.5, sleep=time.sleep,
    ):
        auth = (username, password) if username else None
        self._client = httpx.Client(base_url=base_url, auth=auth, timeout=timeout_s, transport=transport)
        self.account_name = account_name
        self.connector_name = connector_name
        self._fill_wait_s = fill_wait_s
        self._poll_interval_s = poll_interval_s
        self._sleep = sleep

    def _call(self, method: str, path: str, **kw) -> httpx.Response:
        response = self._client.request(method, path, **kw)
        if response.status_code >= 400:
            raise HummingbotApiError(f"{method} {path} -> {response.status_code}: {response.text[:300]}")
        return response

    def _paginated(self, path: str, body: dict) -> list[dict]:
        rows, cursor = [], None
        while True:
            page = self._call("POST", path, json={**body, "cursor": cursor} if cursor else body).json()
            rows += page["data"]
            pagination = page.get("pagination") or {}
            cursor = pagination.get("next_cursor")
            if not pagination.get("has_more") or not cursor:
                return rows

    def _scope(self) -> dict:
        return {"account_names": [self.account_name], "connector_names": [self.connector_name]}

    # -- health / account lifecycle -------------------------------------
    def health(self) -> bool:
        try:
            return self._client.get("/").status_code == 200
        except httpx.HTTPError:
            return False

    def accounts(self) -> list[str]:
        return self._call("GET", "/accounts/").json()

    def ensure_account(self) -> bool:
        if self.account_name in self.accounts():
            return False
        self._call("POST", "/accounts/add-account", params={"account_name": self.account_name})
        return True

    def credentials(self) -> list[str]:
        return self._call("GET", f"/accounts/{self.account_name}/credentials").json()

    def connector_configured(self) -> bool:
        return self.connector_name in self.credentials()

    # -- orders ----------------------------------------------------------
    def set_leverage(self, trading_pair: str, leverage) -> dict:
        if float(leverage) != int(leverage) or not 1 <= int(leverage) <= 125:
            raise HummingbotApiError(f"leverage must be an integer 1-125 for the Hummingbot API, got {leverage}")
        path = f"/trading/{self.account_name}/{self.connector_name}/leverage"
        return self._call("POST", path, json={"trading_pair": trading_pair, "leverage": int(leverage)}).json()

    def place_order(self, order: dict) -> dict:
        trading_pair = to_trading_pair(order["instrument"])
        order_type = order["order_type"].upper()
        if order.get("leverage") and not order.get("reduce_only"):
            self.set_leverage(trading_pair, order["leverage"])
        payload = {
            "account_name": self.account_name, "connector_name": self.connector_name,
            "trading_pair": trading_pair, "trade_type": order["side"].upper(), "amount": order["quantity"],
            "order_type": order_type, "position_action": "CLOSE" if order.get("reduce_only") else "OPEN",
        }
        if order_type in ("LIMIT", "LIMIT_MAKER"):
            payload["price"] = order["price"]
        ack = self._call("POST", "/trading/orders", json=payload).json()
        return self.await_order(ack["order_id"], trading_pair)

    def find_order(self, order_id: str, trading_pair: str) -> dict | None:
        scope = {**self._scope(), "trading_pairs": [trading_pair]}
        for row in self._paginated("/trading/orders/active", scope):
            if row.get("order_id") == order_id:
                return row
        for row in self._paginated("/trading/orders/search", scope):
            if row.get("order_id") == order_id:
                return row
        return None

    def await_order(self, order_id: str, trading_pair: str) -> dict:
        """Polls until the order reaches a terminal state or the wait runs
        out; returns what was actually observed, never an assumed fill."""
        deadline = time.monotonic() + self._fill_wait_s
        row = None
        while True:
            row = self.find_order(order_id, trading_pair) or row
            status = (row or {}).get("status", "SUBMITTED").upper()
            if status in TERMINAL or time.monotonic() >= deadline:
                break
            self._sleep(self._poll_interval_s)
        row = row or {}
        return {
            "backend_order_id": order_id, "status": status,
            "quantity_filled": float(row.get("filled_amount") or 0), "avg_price": row.get("average_fill_price"),
            "fee": float(row.get("fee_paid") or 0), "exchange_order_id": row.get("exchange_order_id"),
            "timestamp": int(time.time() * 1000),
        }

    def cancel_order(self, order_id: str) -> dict:
        path = f"/trading/{self.account_name}/{self.connector_name}/orders/{order_id}/cancel"
        body = self._call("POST", path).json()
        return {"backend_order_id": order_id, "status": "PENDING_CANCEL", "message": body.get("message"), "timestamp": int(time.time() * 1000)}

    def active_orders(self) -> list[dict]:
        return self._paginated("/trading/orders/active", self._scope())

    # -- positions / balances -------------------------------------------
    def positions(self) -> list[dict]:
        if not self.connector_configured():
            raise HummingbotApiError(f"connector {self.connector_name} is not configured for {self.account_name}; "
                                     "an empty position list would be meaningless")
        out = []
        for p in self._paginated("/trading/positions", self._scope()):
            amount = float(p.get("amount") or 0)
            side = str(p.get("side", "")).upper()
            quantity = abs(amount) * (-1 if side == "SHORT" else 1) if side in ("LONG", "SHORT") else amount
            out.append({"instrument": to_instrument(p["trading_pair"]), "quantity": quantity, "side": side,
                        "entry_price": p.get("entry_price"), "leverage": p.get("leverage"),
                        "unrealized_pnl": p.get("unrealized_pnl")})
        return out

    def balances(self) -> list[dict]:
        body = self._call("POST", "/portfolio/state", json={**self._scope(), "skip_gateway": True, "refresh": True}).json()
        return body.get(self.account_name, {}).get(self.connector_name, [])
