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


def _retry_after_s(error: Exception) -> Optional[float]:
    """Retry-After (seconds or HTTP date) from an httpx HTTPStatusError, if any."""
    response = getattr(error, "response", None)
    value = response.headers.get("retry-after") if response is not None and hasattr(response, "headers") else None
    if value in (None, ""):
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        pass
    try:
        from email.utils import parsedate_to_datetime
        import time as _time
        return max(0.0, parsedate_to_datetime(str(value)).timestamp() - _time.time())
    except Exception:
        return None


class CachedCandleFetcher:
    """Chart candles are the LOWEST-priority public-API use (P5, after open-
    position monitoring, reconciliation, discovery and shadow research), so:

      - only COMPLETED candles are cached: a candle whose interval has fully
        elapsed can never change, so each (coin, interval) keeps those and a
        repeat request only asks the exchange for the bars after the last
        cached completed one (an open Trade Detail polling every ~10s reads
        just the tail). The still-forming candle is never cached -- it is
        always re-read, so it is never shown stale or as complete;
      - after an HTTP 429 chart reads pause with exponential backoff + jitter
        (or the server's Retry-After) and report RATE_LIMITED_DEFERRED
        instead of adding to the pressure; a success resets the backoff.

    Display only -- nothing here feeds sizing, triggers or the ledger, and a
    cached candle is never replayed into the paper lifecycle."""

    def __init__(self, fetcher: CandleFetcher, clock=None, wall_ms=None, base_backoff_s: float = 10.0,
                 max_backoff_s: float = 300.0, rand=None, max_series: int = 64, cooldown_s: Optional[float] = None,
                 ttl_s: Optional[float] = None):
        import random as _random
        import time as _time
        self._fetcher = fetcher
        self._clock = clock or _time.monotonic
        self._wall_ms = wall_ms or (lambda: int(_time.time() * 1000))
        self._base = float(cooldown_s if cooldown_s is not None else base_backoff_s)
        self._max = float(max_backoff_s)
        self._rand = rand or _random.random
        self._max_series = max_series
        self._series: dict = {}            # (coin, interval) -> {t: raw completed row}
        self._blocked_until = 0.0
        self._consecutive_429 = 0
        self.calls = 0
        self.stats = {"requests": 0, "http_429": 0, "deferred": 0, "bars_from_cache": 0, "last_429_wall_ms": None,
                      "retry_after_seen": 0}

    def _backoff_s(self) -> float:
        cap = min(self._max, self._base * 2 ** (self._consecutive_429 - 1))
        return cap / 2 + self._rand() * cap / 2

    def health(self) -> dict:
        now = self._clock()
        blocked = now < self._blocked_until
        return {"schema": "rate-limit-health/v1", "source": "execution-service chart candles", "priority": "P5_CHART_HISTORY",
                "state": "BACKOFF" if blocked else "OK", "backoff_remaining_s": round(self._blocked_until - now, 3) if blocked else 0.0,
                "consecutive_429": self._consecutive_429, "cached_series": len(self._series), **self.stats}

    def __call__(self, coin: str, interval: str, start_ms: int, end_ms: int) -> list:
        now = self._clock()
        if now < self._blocked_until:
            self.stats["deferred"] += 1
            raise RuntimeError(f"RATE_LIMITED_DEFERRED (chart requests paused after HTTP 429, {self._blocked_until - now:.0f}s left)")
        step = INTERVAL_MS.get(interval)
        if step is None:  # unknown interval: nothing cacheable, plain read
            self.calls += 1
            return self._fetcher(coin, interval, start_ms, end_ms)
        key = (coin, interval)
        series = self._series.get(key, {})
        first = (start_ms // step) * step
        t = first
        while t in series and t <= end_ms:
            t += step
        cached = [series[b] for b in range(first, t, step)]
        rows: list = []
        if t <= end_ms:
            self.calls += 1
            self.stats["requests"] += 1
            try:
                rows = self._fetcher(coin, interval, t, end_ms)
            except Exception as error:
                if "429" in str(error):
                    self._consecutive_429 += 1
                    self.stats["http_429"] += 1
                    self.stats["last_429_wall_ms"] = self._wall_ms()
                    retry_after = _retry_after_s(error)
                    if retry_after is not None:
                        self.stats["retry_after_seen"] += 1
                    self._blocked_until = now + (retry_after if retry_after is not None else self._backoff_s())
                raise
            self._consecutive_429 = 0
            wall = self._wall_ms()
            if key not in self._series and len(self._series) >= self._max_series:
                self._series.clear()
            series = self._series.setdefault(key, series)
            for row in rows if isinstance(rows, list) else []:
                try:
                    bar = int(row["t"])
                except (KeyError, TypeError, ValueError):
                    continue
                if bar + step <= wall:          # completed: immutable, safe to keep
                    series[bar] = row
            if len(series) > MAX_CANDLES + 1000:
                for bar in sorted(series)[: len(series) - MAX_CANDLES]:
                    del series[bar]
        self.stats["bars_from_cache"] += len(cached)
        fresh = rows if isinstance(rows, list) else []
        fresh_times = set()
        for row in fresh:
            try:
                fresh_times.add(int(row["t"]))
            except (KeyError, TypeError, ValueError):
                pass
        return [row for row in cached if int(row["t"]) not in fresh_times] + fresh


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
