"""Explicit backend selection. Per spec: "Backend must be explicit. Never
silently fall back from REAL -> MOCK." There is no try-real-then-mock path
here -- callers pick one, and asking for 'real' without the bridge reachable
is a startup-time error, not a runtime surprise mid-trading."""
from __future__ import annotations

import os

from market_edge_exec.hummingbot.mock_client import HummingbotExecutionClient
from market_edge_exec.hummingbot.real_client import HummingbotBridgeUnavailable, HummingbotExecutionClientReal


class HummingbotModeError(Exception):
    pass


def build_hummingbot_client(mode: str):
    if mode == "mock":
        return HummingbotExecutionClient()
    if mode == "real":
        base_url = os.environ.get("HUMMINGBOT_BRIDGE_URL")
        api_key = os.environ.get("HUMMINGBOT_BRIDGE_API_KEY")
        if not base_url or not api_key:
            raise HummingbotModeError("HUMMINGBOT_BRIDGE_URL and HUMMINGBOT_BRIDGE_API_KEY are required for mode='real'")
        client = HummingbotExecutionClientReal(base_url=base_url, api_key=api_key)
        if not client.health():
            raise HummingbotBridgeUnavailable(f"HUMMINGBOT_BRIDGE_UNREACHABLE: {base_url}/health did not return ok")
        return client
    raise HummingbotModeError(f"HUMMINGBOT_MODE_INVALID: {mode!r} (expected 'mock' or 'real')")
