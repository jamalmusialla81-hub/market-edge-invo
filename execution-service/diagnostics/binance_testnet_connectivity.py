"""Phase 4 Part 4: Binance USDT-M Futures Testnet connectivity check.

Reads BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET from the
environment (never hardcoded, never logged). If either is absent, this
reports SKIPPED_NOT_CONFIGURED and exits 0 -- a missing testnet key is not a
failure, per instruction ("do not fail unrelated tests, do not fake
success"). If both are present, it makes a real signed request against
Binance's Futures Testnet REST API (https://testnet.binancefuture.com) to
query account balances, open orders, and positions -- a pure read-only
connectivity check, no order is placed here.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time

import httpx

BASE_URL = "https://testnet.binancefuture.com"


def sign(secret: str, query: str) -> str:
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


def signed_get(client: httpx.Client, api_key: str, api_secret: str, path: str) -> dict:
    timestamp = int(time.time() * 1000)
    query = f"timestamp={timestamp}&recvWindow=5000"
    signature = sign(api_secret, query)
    response = client.get(f"{path}?{query}&signature={signature}", headers={"X-MBX-APIKEY": api_key})
    response.raise_for_status()
    return response.json()


def run() -> dict:
    api_key = os.environ.get("BINANCE_TESTNET_API_KEY")
    api_secret = os.environ.get("BINANCE_TESTNET_API_SECRET")
    if not api_key or not api_secret:
        return {"status": "SKIPPED_NOT_CONFIGURED", "reason": "BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET not set"}

    try:
        with httpx.Client(base_url=BASE_URL, timeout=10.0) as client:
            balances = signed_get(client, api_key, api_secret, "/fapi/v2/balance")
            positions = signed_get(client, api_key, api_secret, "/fapi/v2/positionRisk")
            open_orders = signed_get(client, api_key, api_secret, "/fapi/v1/openOrders")
        return {
            "status": "PASS", "balances_count": len(balances) if isinstance(balances, list) else None,
            "positions_count": len(positions) if isinstance(positions, list) else None,
            "open_orders_count": len(open_orders) if isinstance(open_orders, list) else None,
        }
    except httpx.HTTPStatusError as error:
        return {"status": "FAIL", "reason": f"{error.response.status_code}: {error.response.text[:500]}"}
    except httpx.HTTPError as error:
        return {"status": "FAIL", "reason": str(error)}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
