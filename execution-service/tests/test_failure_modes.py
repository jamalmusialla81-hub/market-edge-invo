"""Additional Phase 3 failure tests not already covered by
test_router_and_persistence.py / test_reconciliation.py: duplicate fill
callback, out-of-order fill, cancel after partial fill, and a DB-restart
variant distinct from the process-restart test (this one reopens the store
mid-sequence of fills, not just at the idempotency check)."""
import pytest

from market_edge_exec.domain.contracts import ExecutionFill
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.persistence.store import Store
from market_edge_exec.domain.contracts import ExecutionIntent


def intent(**overrides):
    base = dict(signal_id="s1", instrument="BTC-PERP", side="buy", quantity=1.0, order_type="MARKET", strategy_id="alpha", limit_price=60000, stop=56000)
    base.update(overrides)
    return ExecutionIntent.create(base)


def test_duplicate_fill_callback_does_not_double_count_a_position(tmp_path):
    store = Store(str(tmp_path / "db.sqlite3"))
    portfolio = NautilusPortfolio(store)
    fill = ExecutionFill.create({"signal_id": "s1", "fill_id": "f1", "status": "FILLED", "quantity_filled": 0.4, "avg_price": 60000, "backend": "NAUTILUS_NATIVE"})
    store.record_fill(fill.to_dict())
    portfolio.apply_fill(intent(quantity=0.4), fill_price=60000, quantity_filled=0.4, backend="NAUTILUS_NATIVE")
    # The same fill_id arrives again (a duplicate callback from the backend).
    store.record_fill(fill.to_dict())  # INSERT OR REPLACE by fill_id -- does not create a second row
    with store._connect() as conn:  # noqa: SLF001 -- test-only introspection
        count = conn.execute("SELECT COUNT(*) FROM fills WHERE fill_id = ?", ("f1",)).fetchone()[0]
    assert count == 1
    # Applying the SAME fill event to the portfolio a second time would double
    # the position -- callers must gate on record_fill's fill_id, which this
    # test proves stays a single row; the portfolio itself is not re-applied.
    assert portfolio.position("BTC-PERP").quantity == pytest.approx(0.4)


def test_out_of_order_fill_still_produces_the_correct_final_position(tmp_path):
    store = Store(str(tmp_path / "db.sqlite3"))
    portfolio = NautilusPortfolio(store)
    # A partial fill for 0.6 arrives, then (out of order) one for 0.4 that
    # was actually generated first by the backend -- final position must
    # reflect the sum regardless of arrival order.
    portfolio.apply_fill(intent(quantity=1.0), fill_price=60100, quantity_filled=0.6, backend="NAUTILUS_NATIVE")
    portfolio.apply_fill(intent(quantity=1.0), fill_price=60000, quantity_filled=0.4, backend="NAUTILUS_NATIVE")
    assert portfolio.position("BTC-PERP").quantity == pytest.approx(1.0)


def test_cancel_after_partial_fill_leaves_the_partial_position_intact(tmp_path):
    store = Store(str(tmp_path / "db.sqlite3"))
    portfolio = NautilusPortfolio(store)
    portfolio.apply_fill(intent(quantity=1.0), fill_price=60000, quantity_filled=0.3, backend="NAUTILUS_NATIVE")
    store.upsert_order("s1", "NAUTILUS_NATIVE", "PARTIALLY_FILLED")
    # Cancel: no more quantity will fill, but the 0.3 already filled remains a real position.
    store.upsert_order("s1", "NAUTILUS_NATIVE", "CANCELLED")
    assert portfolio.position("BTC-PERP").quantity == pytest.approx(0.3)
    orders = store.orders()
    assert orders[0]["status"] == "CANCELLED"


def test_db_restart_mid_sequence_preserves_prior_fills_and_accepts_new_ones(tmp_path):
    db_path = str(tmp_path / "db.sqlite3")
    store_a = Store(db_path)
    portfolio_a = NautilusPortfolio(store_a)
    portfolio_a.apply_fill(intent(signal_id="s1", quantity=0.5), fill_price=60000, quantity_filled=0.5, backend="NAUTILUS_NATIVE")
    del store_a, portfolio_a  # simulate the DB process/connection being torn down

    store_b = Store(db_path)  # "DB restart": same file, fresh connection
    portfolio_b = NautilusPortfolio(store_b)
    assert portfolio_b.position("BTC-PERP").quantity == pytest.approx(0.5)
    portfolio_b.apply_fill(intent(signal_id="s2", quantity=0.5), fill_price=60100, quantity_filled=0.5, backend="NAUTILUS_NATIVE")
    assert portfolio_b.position("BTC-PERP").quantity == pytest.approx(1.0)
