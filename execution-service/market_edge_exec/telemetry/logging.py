"""Structured (JSON-lines) event logging. Every event carries signal_id,
strategy_id, instrument, backend, timestamp where applicable, per spec —
callers pass whatever subset is known and this fills the rest with None."""
from __future__ import annotations

import json
import sys
import time

REQUIRED_KEYS = ("signal_id", "strategy_id", "instrument", "backend")


def log_event(event: str, **fields) -> dict:
    record = {"event": event, "timestamp": fields.pop("timestamp", int(time.time() * 1000))}
    for key in REQUIRED_KEYS:
        record[key] = fields.pop(key, None)
    record.update(fields)
    print(json.dumps(record), file=sys.stderr)
    return record
