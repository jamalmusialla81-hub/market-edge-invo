"""Narrow, private bridge API in front of the real Hummingbot API project
(NOT Gateway -- see bridge/hummingbot_api_client.py). Every endpoint
requires X-Bridge-Key (checked against BRIDGE_API_KEY). No exchange secret
ever passes through this API -- those live only as env vars on the
`hummingbot-api` container (docker-compose.yml), read by Hummingbot itself.
"""
from __future__ import annotations

import os

from fastapi import Depends, FastAPI, Header, HTTPException

from bridge.hummingbot_api_client import HummingbotApiClient


def create_app(gateway: HummingbotApiClient = None) -> FastAPI:
    app = FastAPI(title="Market Edge - Hummingbot bridge (paper only)")
    gateway = gateway or HummingbotApiClient(
        os.environ.get("HUMMINGBOT_API_URL", "http://hummingbot-api:8000"),
        username=os.environ.get("HUMMINGBOT_API_USERNAME", ""),
        password=os.environ.get("HUMMINGBOT_API_PASSWORD", ""),
    )
    app.state.gateway = gateway

    def require_bridge_key(x_bridge_key: str = Header(default=None)):
        expected = os.environ.get("BRIDGE_API_KEY")
        if not expected or x_bridge_key != expected:
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    @app.get("/health")
    def health():
        return {"status": "ok" if gateway.health() else "hummingbot_unreachable"}

    @app.post("/orders", dependencies=[Depends(require_bridge_key)])
    def submit_order(order: dict):
        try:
            result = gateway.place_order(order)
        except Exception as error:  # noqa: BLE001 -- any Gateway failure surfaces as 502, never a silent mock
            raise HTTPException(status_code=502, detail=f"HUMMINGBOT_GATEWAY_ERROR: {error}")
        return result

    @app.delete("/orders/{signal_id}", dependencies=[Depends(require_bridge_key)])
    def cancel_order(signal_id: str):
        try:
            return gateway.cancel_order(signal_id)
        except Exception as error:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"HUMMINGBOT_GATEWAY_ERROR: {error}")

    @app.patch("/orders/{signal_id}", dependencies=[Depends(require_bridge_key)])
    def amend_order(signal_id: str, changes: dict):
        raise HTTPException(status_code=501, detail="AMEND_NOT_SUPPORTED_BY_CONNECTOR")

    @app.get("/positions", dependencies=[Depends(require_bridge_key)])
    def positions():
        return {"positions": gateway.positions()}

    return app


app = create_app()
