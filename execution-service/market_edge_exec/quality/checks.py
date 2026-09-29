"""Pure row checks. Each returns a list of (status, reason) findings; the
verdict is the worst finding (QUARANTINED > INVALID > UNRESOLVED > VALID).

  QUARANTINED  the row itself is damaged (cannot be parsed, hash mismatch,
               NaN/Inf, schema drift). Kept exactly as captured, flagged.
  INVALID      the row is well-formed but breaks a data rule (future
               timestamp, stale snapshot, duplicate, missing versions,
               cross-venue outcome, pre-listing, bad join, ...).
  UNRESOLVED   the row is fine so far but its outcome is not final
               (pending window, missing candle, data unavailable).
  VALID        nothing found.

Existing logic is reused, not reimplemented: the snapshot validity that
ShadowStore already computed (research_candidate_valid / invalid_reason) and
the resolution / label statuses that resolve.py already writes are mapped
into this vocabulary."""
from __future__ import annotations

import hashlib
import json
import math
import zlib
from typing import Any, Iterable, Optional

VALID, INVALID, UNRESOLVED, QUARANTINED = "VALID", "INVALID", "UNRESOLVED", "QUARANTINED"
SEVERITY = {VALID: 0, UNRESOLVED: 1, INVALID: 2, QUARANTINED: 3}
FUTURE_TOLERANCE_MS = 5 * 60_000     # clock skew allowed between the decision time and when it was written / now

Finding = tuple[str, str]

# Existing ShadowStore validity reasons -> shared vocabulary (all are INVALID: the snapshot cannot be researched).
SNAPSHOT_REASONS = {"NO_MARKET_PRICE", "STALE_SNAPSHOT", "NO_DIRECTION", "INCOMPLETE_GEOMETRY",
                    "STOP_ON_WRONG_SIDE_OF_ENTRY", "STOP_ALREADY_BREACHED_AT_DECISION"}
# resolve.py resolution_status / label_status -> shared vocabulary.
RESOLUTION_MAP = {
    "RESOLVED": (VALID, None),
    "RESOLVED_WITH_GAPS": (UNRESOLVED, "RESOLVED_WITH_GAPS"),
    "PARTIAL": (UNRESOLVED, "INCOMPLETE_HORIZONS"),
    "PENDING": (UNRESOLVED, "OUTCOME_PENDING"),
    "NOT_RESOLVABLE_INVALID_SNAPSHOT": (INVALID, "NOT_RESOLVABLE_INVALID_SNAPSHOT"),
}
LABEL_MAP = {
    "OK": (VALID, None),
    "PARTIAL_UNRESOLVED": (UNRESOLVED, "INCOMPLETE_HORIZONS"),
    "UNRESOLVED_MISSING_CANDLE": (UNRESOLVED, "MISSING_CANDLE"),
    "UNRESOLVED_DATA_UNAVAILABLE": (UNRESOLVED, "OUTCOME_DATA_UNAVAILABLE"),
}


def worst(findings: Iterable[Finding]) -> tuple[str, list[str]]:
    findings = list(findings)
    if not findings:
        return VALID, []
    status = max((f[0] for f in findings), key=lambda s: SEVERITY[s])
    return status, sorted({f"{s}:{r}" for s, r in findings})


def non_finite(value: Any) -> bool:
    """True if any number anywhere inside is NaN or +-Inf."""
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, dict):
        return any(non_finite(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return any(non_finite(v) for v in value)
    return False


def _blob(raw: bytes) -> Any:
    return json.loads(zlib.decompress(raw).decode())


def content_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def candle_findings(coin: str, candles: Iterable[dict], listing_ms: Optional[int] = None) -> list[Finding]:
    """OHLC sanity (impossible prices) and pre-listing history for a candle series."""
    out: list[Finding] = []
    for c in candles:
        try:
            o, h, l, cl, t = c["open"], c["high"], c["low"], c["close"], c["time"]
        except (KeyError, TypeError):
            out.append((QUARANTINED, "CANDLE_SCHEMA_DRIFT"))
            continue
        vals = (o, h, l, cl)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in vals):
            out.append((QUARANTINED, "CANDLE_NON_FINITE"))
        elif min(vals) <= 0 or h < max(o, cl, l) or l > min(o, cl, h):
            out.append((INVALID, "IMPOSSIBLE_PRICES"))
        if listing_ms is not None and isinstance(t, (int, float)) and t < listing_ms:
            out.append((INVALID, "PRE_LISTING_HISTORY"))
    return out


REQUIRED_OBSERVATION_COLUMNS = ("observation_id", "scan_id", "kind", "asset", "decision_ts", "first_bar_ts", "generator_version",
                                "feature_version", "dataset_version", "outcome_venue", "outcome_interval", "decision", "decision_hash",
                                "created_at_ms", "research_candidate_valid", "execution_status")


def observation_findings(row: dict, now_ms: int, listing_ms: Optional[dict] = None, expected_venue: str = "HYPERLIQUID") -> list[Finding]:
    """One shadow observation (a shadow_observations row as a dict, `decision` still compressed)."""
    missing = [c for c in REQUIRED_OBSERVATION_COLUMNS if c not in row]
    if missing:
        return [(QUARANTINED, "SCHEMA_DRIFT_MISSING_COLUMN")]
    try:
        decision = _blob(row["decision"])
    except Exception:  # noqa: BLE001
        return [(QUARANTINED, "CORRUPTED_DECISION_BLOB")]
    out: list[Finding] = []
    try:
        if non_finite(decision):
            return [(QUARANTINED, "NON_FINITE_VALUE")]
        if content_hash(decision) != row["decision_hash"]:
            return [(QUARANTINED, "DECISION_HASH_MISMATCH")]
    except (TypeError, ValueError):
        return [(QUARANTINED, "NON_FINITE_VALUE")]
    market = decision.get("market") if isinstance(decision, dict) else None
    if not isinstance(market, dict):
        out.append((QUARANTINED, "SCHEMA_DRIFT_MISSING_MARKET"))
    if row["kind"] == "CANDIDATE" and not isinstance(decision.get("candidate"), dict):
        out.append((QUARANTINED, "SCHEMA_DRIFT_MISSING_CANDIDATE"))
    # existing snapshot validity, mapped
    if not row["research_candidate_valid"]:
        reason = row.get("invalid_reason") or "INVALID_SNAPSHOT"
        out.append((INVALID, reason if reason in SNAPSHOT_REASONS else f"SNAPSHOT_{reason}"))
    # timestamps
    ts, first_bar, created = row["decision_ts"], row["first_bar_ts"], row["created_at_ms"]
    if not all(isinstance(v, int) and v > 0 for v in (ts, first_bar, created)):
        out.append((QUARANTINED, "BAD_TIMESTAMP_TYPE"))
    else:
        if ts > now_ms + FUTURE_TOLERANCE_MS or ts > created + FUTURE_TOLERANCE_MS:
            out.append((INVALID, "FUTURE_TIMESTAMP"))
        if first_bar < ts:
            out.append((INVALID, "TIMESTAMP_ORDER_FIRST_BAR_BEFORE_DECISION"))
        if created < ts - FUTURE_TOLERANCE_MS:
            out.append((INVALID, "TIMESTAMP_ORDER_WRITTEN_BEFORE_DECISION"))
    # version metadata
    for col in ("generator_version", "feature_version", "dataset_version"):
        if not row.get(col):
            out.append((INVALID, "MISSING_VERSION_METADATA"))
            break
    # venue: the outcome must be measured on the venue the decision was taken on (never substituted)
    decision_venue = (market or {}).get("venue") if isinstance(market, dict) else None
    if row["outcome_venue"] != expected_venue or (decision_venue and decision_venue != row["outcome_venue"]):
        out.append((INVALID, "CROSS_VENUE_LABEL_SUBSTITUTION"))
    coin = row.get("coin")
    if listing_ms and coin in listing_ms and isinstance(ts, int) and ts < listing_ms[coin]:
        out.append((INVALID, "PRE_LISTING_HISTORY"))
    return out


def duplicate_findings(rows: list[dict]) -> dict[str, Finding]:
    """The same market observed twice: identical (kind, asset, direction, strategy, decision_ts) under
    different scans. The earliest write stays as it is; later copies are flagged."""
    seen: dict[tuple, dict] = {}
    flagged: dict[str, Finding] = {}
    for r in sorted(rows, key=lambda r: (r["created_at_ms"], r["observation_id"])):
        key = (r["kind"], r["asset"], r.get("direction"), r.get("strategy"), r["decision_ts"])
        if key in seen and seen[key]["scan_id"] != r["scan_id"]:
            flagged[r["observation_id"]] = (INVALID, "DUPLICATE_OBSERVATION")
        else:
            seen.setdefault(key, r)
    return flagged


def resolution_findings(resolution_status: Optional[str], label_statuses: Iterable[str]) -> list[Finding]:
    out: list[Finding] = []
    if resolution_status is None:
        out.append((UNRESOLVED, "NO_RESOLUTION_RECORD"))
    else:
        status, reason = RESOLUTION_MAP.get(resolution_status, (QUARANTINED, "UNKNOWN_RESOLUTION_STATUS"))
        if reason:
            out.append((status, reason))
    for label_status in label_statuses:
        status, reason = LABEL_MAP.get(label_status, (QUARANTINED, "UNKNOWN_LABEL_STATUS"))
        if reason:
            out.append((status, reason))
    return out


def sizing_decision_findings(row: dict) -> list[Finding]:
    """One risk_sizing_decisions row."""
    out: list[Finding] = []
    try:
        record = json.loads(row["record"], parse_constant=lambda c: float("nan"))
    except (TypeError, ValueError, KeyError):
        return [(QUARANTINED, "CORRUPTED_RECORD")]
    if non_finite(record):
        return [(QUARANTINED, "NON_FINITE_VALUE")]
    if hashlib.sha256(row["record"].encode()).hexdigest() != row.get("record_hash"):
        return [(QUARANTINED, "RECORD_HASH_MISMATCH")]
    if not row.get("policy_version") or row.get("policy_version") == "UNKNOWN":
        out.append((INVALID, "MISSING_VERSION_METADATA"))
    if not row.get("signal_id"):
        out.append((INVALID, "MISSING_SIGNAL_ID"))
    if not isinstance(row.get("created_at_ms"), int) or row["created_at_ms"] <= 0:
        out.append((QUARANTINED, "BAD_TIMESTAMP_TYPE"))
    return out


def paper_trade_findings(trade: dict, now_ms: int) -> list[Finding]:
    """One paper trade (payload dict)."""
    out: list[Finding] = []
    if non_finite(trade):
        return [(QUARANTINED, "NON_FINITE_VALUE")]
    for k in ("entry_fill", "stop", "quantity"):
        v = trade.get(k)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
            out.append((QUARANTINED, f"SCHEMA_DRIFT_BAD_{k.upper()}"))
    if out:
        return out
    opened, closed = trade.get("opened_at_ms"), trade.get("closed_at_ms")
    if not isinstance(opened, int) or opened <= 0:
        return [(QUARANTINED, "BAD_TIMESTAMP_TYPE")]
    if opened > now_ms + FUTURE_TOLERANCE_MS or (isinstance(closed, int) and closed > now_ms + FUTURE_TOLERANCE_MS):
        out.append((INVALID, "FUTURE_TIMESTAMP"))
    if isinstance(closed, int) and closed < opened:
        out.append((INVALID, "TIMESTAMP_ORDER_CLOSE_BEFORE_OPEN"))
    long = trade.get("direction") == "long"
    if trade.get("direction") not in ("long", "short"):
        out.append((INVALID, "NO_DIRECTION"))
    elif (long and not trade["stop"] < trade["entry_fill"]) or (not long and not trade["stop"] > trade["entry_fill"]):
        out.append((INVALID, "STOP_ON_WRONG_SIDE_OF_ENTRY"))
    if trade.get("status") == "CLOSED":
        if not trade.get("exit_reason"):
            out.append((INVALID, "CLOSED_WITHOUT_EXIT_REASON"))
    elif trade.get("status") == "OPEN":
        out.append((UNRESOLVED, "TRADE_STILL_OPEN"))
    else:
        out.append((QUARANTINED, "SCHEMA_DRIFT_UNKNOWN_STATUS"))
    return out
