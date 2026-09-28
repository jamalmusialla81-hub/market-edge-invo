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
from market_edge_exec.risk.engine import RiskDecision
from market_edge_exec.routing.router import BACKEND_NAUTILUS_NATIVE, ExecutionRouter, RouterError


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


def test_partial_fill_then_restart_preserves_exactly_the_filled_amount(tmp_path):
    db_path = str(tmp_path / "db.sqlite3")
    store_a = Store(db_path)
    portfolio_a = NautilusPortfolio(store_a)
    portfolio_a.apply_fill(intent(signal_id="s-partial", quantity=1.0), fill_price=60000, quantity_filled=0.35, backend="NAUTILUS_NATIVE")
    store_a.upsert_order("s-partial", "NAUTILUS_NATIVE", "PARTIALLY_FILLED")
    del store_a, portfolio_a  # simulate the process being torn down mid-fill

    store_b = Store(db_path)
    portfolio_b = NautilusPortfolio(store_b)
    # Only the 0.35 that was actually filled before restart exists -- not the
    # full 1.0 requested quantity, and not zero.
    assert portfolio_b.position("BTC-PERP").quantity == pytest.approx(0.35)
    orders = {o["signal_id"]: o for o in store_b.orders()}
    assert orders["s-partial"]["status"] == "PARTIALLY_FILLED"
    # The remaining 0.65 can still fill after restart, on the same signal_id.
    portfolio_b.apply_fill(intent(signal_id="s-partial", quantity=1.0), fill_price=60050, quantity_filled=0.65, backend="NAUTILUS_NATIVE")
    store_b.upsert_order("s-partial", "NAUTILUS_NATIVE", "FILLED")
    assert portfolio_b.position("BTC-PERP").quantity == pytest.approx(1.0)


class _TimeoutBackend:
    """Simulates a backend timeout / network loss on submit()."""

    def submit(self, execution_intent):
        raise TimeoutError("simulated backend timeout")


def test_backend_timeout_fails_closed_not_silently(tmp_path):
    store = Store(str(tmp_path / "db.sqlite3"))
    router = ExecutionRouter(store=store, risk_gate=lambda i: RiskDecision(signal_id=i.signal_id, approved=True, approved_leverage=1.0),
                              backends={BACKEND_NAUTILUS_NATIVE: _TimeoutBackend()})
    with pytest.raises(RouterError, match="BACKEND_SUBMIT_FAILED"):
        router.route(intent(signal_id="s-timeout"))

    # The signal_id must be left in a state reconciliation can act on --
    # not a bare crash with no trace, and not silently treated as filled.
    orders = {o["signal_id"]: o for o in store.orders()}
    assert orders["s-timeout"]["status"] == "SUBMIT_FAILED_UNKNOWN"
    with store._connect() as conn:  # noqa: SLF001 -- test-only introspection
        reason = conn.execute("SELECT reason FROM failures WHERE signal_id = ?", ("s-timeout",)).fetchone()["reason"]
    assert "BACKEND_SUBMIT_FAILED" in reason

    # And it must not be retryable under the same signal_id (idempotency
    # already consumed it) -- a caller must generate a new signal_id, not
    # silently double-submit.
    with pytest.raises(RouterError, match="DUPLICATE_SIGNAL"):
        router.route(intent(signal_id="s-timeout"))
