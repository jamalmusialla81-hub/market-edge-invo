"""Candles for the Trade Detail chart, read from the same public Hyperliquid
info API the forward loop and production scan use (candleSnapshot).

Display only: nothing here feeds sizing, triggers or the ledger. Candles are
returned exactly as the exchange reports them; a gap stays a gap and a failed
read is reported as unavailable -- nothing is interpolated or synthesized.
The one still-forming candle (if any) is flagged `complete: false`.
"""
from __future__ import annotations

from typing import Callable, Optional

HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info"
CANDLE_SOURCE = "HYPERLIQUID_CANDLESNAPSHOT"
MINUTE = 60_000
HOUR = 60 * MINUTE
INTERVAL_MS = {"1m": MINUTE, "5m": 5 * MINUTE, "15m": 15 * MINUTE, "1h": HOUR}
# Pre-entry context and post-exit context per timeframe.
PRE_ENTRY_MS = {"1m": 2 * HOUR, "5m": 4 * HOUR, "15m": 6 * HOUR, "1h": 12 * HOUR}
POST_EXIT_MIN_MS = {"1m": 30 * MINUTE, "5m": 2 * HOUR, "15m": 4 * HOUR, "1h": 12 * HOUR}
MAX_CANDLES = 5000  # Hyperliquid candleSnapshot returns at most this many

CandleFetcher = Callable[[str, str, int, int], list]


def chart_window(interval: str, opened_at_ms: int, closed_at_ms: Optional[int], now_ms: int) -> dict:
    """Pre-entry context + full trade lifetime (+ post-exit context for a
    closed trade). Trims pre-entry context first if the window exceeds what
    the source can return; if even entry -> end does not fit, the timeframe
    is too fine for this trade and the caller should pick a coarser one."""
    step = INTERVAL_MS[interval]
    start = opened_at_ms - PRE_ENTRY_MS[interval]
    if closed_at_ms:
        lifetime = max(0, closed_at_ms - opened_at_ms)
        end = min(now_ms, closed_at_ms + max(POST_EXIT_MIN_MS[interval], lifetime // 4))
    else:
        end = now_ms
    if (end - opened_at_ms) / step > MAX_CANDLES:
        return {"ok": False, "reason": "RANGE_TOO_LARGE_FOR_INTERVAL", "start_ms": start, "end_ms": end}
    start = max(start, end - MAX_CANDLES * step)
    return {"ok": True, "start_ms": start, "end_ms": end}


def parse_candles(rows, interval: str, now_ms: int) -> list[dict]:
    step = INTERVAL_MS[interval]
    out = []
    for row in rows if isinstance(rows, list) else []:
        try:
            c = {"time": int(row["t"]), "open": float(row["o"]), "high": float(row["h"]), "low": float(row["l"]),
                 "close": float(row["c"]), "volume": float(row.get("v") or 0.0)}
        except (KeyError, TypeError, ValueError):
            continue
        if c["low"] <= 0 or c["high"] < max(c["open"], c["close"]) or c["low"] > min(c["open"], c["close"]):
            continue  # malformed row: dropped, never repaired
        c["complete"] = c["time"] + step <= now_ms
        out.append(c)
    out.sort(key=lambda c: c["time"])
    return out


def hyperliquid_fetcher(timeout_s: float = 8.0) -> CandleFetcher:
    def fetch(coin: str, interval: str, start_ms: int, end_ms: int) -> list:
        import httpx  # local import: only the live app needs the network client

        response = httpx.post(HYPERLIQUID_INFO, timeout=timeout_s, json={
            "type": "candleSnapshot", "req": {"coin": coin, "interval": interval, "startTime": start_ms, "endTime": end_ms}})
        response.raise_for_status()
        return response.json()
    return fetch


def trade_candles(trade: dict, interval: str, now_ms: int, fetcher: CandleFetcher) -> dict:
    if interval not in INTERVAL_MS:
        return {"available": False, "reason": f"UNSUPPORTED_INTERVAL: {interval}", "candles": [], "intervals": list(INTERVAL_MS)}
    coin = trade.get("coin") or trade["asset"]
    window = chart_window(interval, trade["opened_at_ms"], trade.get("closed_at_ms"), now_ms)
    base = {"interval": interval, "coin": coin, "source": CANDLE_SOURCE, "start_ms": window["start_ms"],
            "end_ms": window["end_ms"], "intervals": list(INTERVAL_MS)}
    if not window["ok"]:
        return {**base, "available": False, "reason": window["reason"], "candles": []}
    try:
        rows = fetcher(coin, interval, window["start_ms"], window["end_ms"])
    except Exception as error:  # network / HTTP / JSON: report, never substitute
        return {**base, "available": False, "reason": f"CANDLES_UNAVAILABLE: {error}", "candles": []}
    candles = [c for c in parse_candles(rows, interval, now_ms) if window["start_ms"] - INTERVAL_MS[interval] < c["time"] <= window["end_ms"]]
    if not candles:
        return {**base, "available": False, "reason": "NO_CANDLES_FROM_SOURCE", "candles": []}
    return {**base, "available": True, "reason": None, "candles": candles}
