"""Narrow, private bridge in front of the real Hummingbot API (not Gateway).
Execution transport only: it never decides a trade. Every endpoint needs
X-Bridge-Key. Exchange secrets never pass through here.

The Hummingbot API assigns its own order ids and takes no client id, so the
bridge keeps a persistent signal_id -> order_id map. That is what lets a
cancel by signal_id survive a bridge restart, and it refuses a signal_id it
has already sent (the execution-service blocks duplicates too; this is the
second line).
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import closing

from fastapi import Depends, FastAPI, Header, HTTPException

from bridge.hummingbot_api_client import HummingbotApiClient, HummingbotApiError


class OrderMap:
    def __init__(self, path: str):
        self._path = path
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.execute("CREATE TABLE IF NOT EXISTS orders (signal_id TEXT PRIMARY KEY, order_id TEXT, status TEXT)")

    def claim(self, signal_id: str) -> bool:
        try:
            with closing(sqlite3.connect(self._path)) as conn, conn:
                conn.execute("INSERT INTO orders (signal_id, status) VALUES (?, 'SENDING')", (signal_id,))
            return True
        except sqlite3.IntegrityError:
            return False

    def record(self, signal_id: str, order_id: str | None, status: str) -> None:
        with closing(sqlite3.connect(self._path)) as conn, conn:
            conn.execute("UPDATE orders SET order_id = ?, status = ? WHERE signal_id = ?", (order_id, status, signal_id))

    def order_id(self, signal_id: str) -> str | None:
        with closing(sqlite3.connect(self._path)) as conn:
            row = conn.execute("SELECT order_id FROM orders WHERE signal_id = ?", (signal_id,)).fetchone()
        return row[0] if row else None


def create_app(gateway: HummingbotApiClient = None, db_path: str = None) -> FastAPI:
    app = FastAPI(title="Market Edge - Hummingbot bridge (paper/testnet only)")
    gateway = gateway or HummingbotApiClient(
        os.environ.get("HUMMINGBOT_API_URL", "http://hummingbot-api:8000"),
        username=os.environ.get("HUMMINGBOT_API_USERNAME", ""),
        password=os.environ.get("HUMMINGBOT_API_PASSWORD", ""),
        account_name=os.environ.get("HUMMINGBOT_ACCOUNT", "market_edge"),
        connector_name=os.environ.get("HUMMINGBOT_CONNECTOR", "binance_perpetual_testnet"),
    )
    orders = OrderMap(db_path or os.environ.get("BRIDGE_DB_PATH", "bridge.sqlite3"))
    app.state.gateway, app.state.orders = gateway, orders

    def require_bridge_key(x_bridge_key: str = Header(default=None)):
        expected = os.environ.get("BRIDGE_API_KEY")
        if not expected or x_bridge_key != expected:
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    def upstream(call, *args):
        try:
            return call(*args)
        except (HummingbotApiError, Exception) as error:  # noqa: BLE001 -- surfaces as 502, never a mock
            raise HTTPException(status_code=502, detail=f"HUMMINGBOT_API_ERROR: {error}")

    @app.get("/health")
    def health():
        return {"status": "ok" if gateway.health() else "hummingbot_unreachable",
                "account": gateway.account_name, "connector": gateway.connector_name}

    @app.post("/orders", dependencies=[Depends(require_bridge_key)])
    def submit_order(order: dict):
        signal_id = order["client_order_id"]
        if not orders.claim(signal_id):
            raise HTTPException(status_code=409, detail=f"DUPLICATE_SIGNAL: {signal_id}")
        try:
            result = gateway.place_order(order)
        except Exception as error:  # noqa: BLE001
            orders.record(signal_id, None, "SUBMIT_FAILED_UNKNOWN")
            raise HTTPException(status_code=502, detail=f"HUMMINGBOT_API_ERROR: {error}")
        orders.record(signal_id, result["backend_order_id"], result["status"])
        return result

    @app.delete("/orders/{signal_id}", dependencies=[Depends(require_bridge_key)])
    def cancel_order(signal_id: str):
        order_id = orders.order_id(signal_id)
        if not order_id:
            raise HTTPException(status_code=404, detail=f"UNKNOWN_SIGNAL: {signal_id}")
        return upstream(gateway.cancel_order, order_id)

    @app.patch("/orders/{signal_id}", dependencies=[Depends(require_bridge_key)])
    def amend_order(signal_id: str, changes: dict):
        raise HTTPException(status_code=501, detail="AMEND_NOT_SUPPORTED_BY_CONNECTOR")

    @app.get("/orders/active", dependencies=[Depends(require_bridge_key)])
    def active_orders():
        return {"orders": upstream(gateway.active_orders)}

    @app.get("/positions", dependencies=[Depends(require_bridge_key)])
    def positions():
        return {"positions": upstream(gateway.positions)}

    @app.get("/balances", dependencies=[Depends(require_bridge_key)])
    def balances():
        return {"balances": upstream(gateway.balances)}

    return app

