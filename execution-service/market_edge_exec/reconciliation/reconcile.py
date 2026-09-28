"""State reconciliation — mirrors research/execution-architecture/reconciliation.js,
extended with missing-fill detection and a persisted event trail. Never
auto-closes or auto-fixes divergent state; a caller that gets
reconciled=False is expected to halt new execution until a human resolves it.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from market_edge_exec.persistence.store import Store


@dataclass
class ReconciliationResult:
    reconciled: bool
    orphan_orders: list
    unknown_positions: list
    mismatched: list
    missing_fills: list


def reconcile(canonical_positions: list[dict], backend_positions: list[dict], expected_signal_ids: list[str] = None, recorded_fill_signal_ids: list[str] = None, store: Store = None) -> ReconciliationResult:
    canonical_by_instrument = {p["instrument"]: p for p in canonical_positions}
    backend_by_instrument = {p["instrument"]: p for p in backend_positions}

    orphan_orders = [instrument for instrument in backend_by_instrument if instrument not in canonical_by_instrument]
    unknown_positions = [instrument for instrument in canonical_by_instrument if instrument not in backend_by_instrument]
    mismatched = [
        {"instrument": instrument, "canonical_quantity": canonical["quantity"], "backend_quantity": backend_by_instrument[instrument]["quantity"]}
        for instrument, canonical in canonical_by_instrument.items()
        if instrument in backend_by_instrument and abs(canonical["quantity"] - backend_by_instrument[instrument]["quantity"]) > 1e-9
    ]
    expected_signal_ids = expected_signal_ids or []
    recorded_fill_signal_ids = set(recorded_fill_signal_ids or [])
    missing_fills = [signal_id for signal_id in expected_signal_ids if signal_id not in recorded_fill_signal_ids]

    result = ReconciliationResult(
        reconciled=not (orphan_orders or unknown_positions or mismatched or missing_fills),
        orphan_orders=orphan_orders, unknown_positions=unknown_positions, mismatched=mismatched, missing_fills=missing_fills,
    )
    if store is not None:
        store.record_reconciliation_event({
            "reconciled": result.reconciled, "orphan_orders": orphan_orders, "unknown_positions": unknown_positions,
            "mismatched": mismatched, "missing_fills": missing_fills,
        })
    return result
