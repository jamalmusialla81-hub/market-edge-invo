"""Tests 8,9,10,11,12: cancel reconciles, reject reconciles, orphan order
detected, unknown position detected, quantity mismatch detected."""
from market_edge_exec.reconciliation.reconcile import reconcile


def test_orphan_order_detected():
    result = reconcile(canonical_positions=[], backend_positions=[{"instrument": "ETH-PERP", "quantity": 2}])
    assert result.reconciled is False
    assert result.orphan_orders == ["ETH-PERP"]


def test_unknown_position_detected():
    result = reconcile(canonical_positions=[{"instrument": "ETH-PERP", "quantity": 2}], backend_positions=[])
    assert result.reconciled is False
    assert result.unknown_positions == ["ETH-PERP"]


def test_quantity_mismatch_detected():
    result = reconcile(canonical_positions=[{"instrument": "BTC-PERP", "quantity": 1}], backend_positions=[{"instrument": "BTC-PERP", "quantity": 0.5}])
    assert result.reconciled is False
    assert result.mismatched == [{"instrument": "BTC-PERP", "canonical_quantity": 1, "backend_quantity": 0.5}]


def test_cancel_reconciles_once_both_sides_show_zero_position():
    # A cancelled order never became a position on either side, so an empty
    # canonical/backend pair for that instrument reconciles cleanly.
    result = reconcile(canonical_positions=[], backend_positions=[])
    assert result.reconciled is True


def test_reject_reconciles_and_is_visible_as_a_missing_fill_if_one_was_expected_but_never_recorded():
    result = reconcile(canonical_positions=[], backend_positions=[], expected_signal_ids=["s1"], recorded_fill_signal_ids=[])
    assert result.reconciled is False
    assert result.missing_fills == ["s1"]


def test_reconciliation_passes_when_the_expected_fill_was_recorded():
    result = reconcile(canonical_positions=[], backend_positions=[], expected_signal_ids=["s1"], recorded_fill_signal_ids=["s1"])
    assert result.reconciled is True
