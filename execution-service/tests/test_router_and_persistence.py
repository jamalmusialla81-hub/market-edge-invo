"""Tests 2,3,4,5,6,7,13: one signal -> one order, duplicate blocked (incl.
across a simulated restart), risk rejection prevents backend call, leverage
ceiling enforced at the router, partial fill updates position correctly,
restart restores persisted positions."""
import tempfile
from pathlib import Path

import pytest

from market_edge_exec.domain.contracts import ExecutionIntent, RiskDecision
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.persistence.store import Store
from market_edge_exec.risk.engine import DEFAULT_LEVERAGE
from market_edge_exec.routing.router import BACKEND_NAUTILUS_NATIVE, ExecutionRouter, RouterError


class FakeBackend:
    def __init__(self, name):
        self.name = name
        self.submitted = []

    def submit(self, intent):
        from market_edge_exec.domain.contracts import ExecutionFill
        self.submitted.append(intent)
        return ExecutionFill.create({"signal_id": intent.signal_id, "fill_id": f"f-{intent.signal_id}", "status": "FILLED", "quantity_filled": intent.quantity, "avg_price": intent.limit_price, "backend": self.name})

    def cancel(self, signal_id):
        from market_edge_exec.domain.contracts import ExecutionFill
        return ExecutionFill.create({"signal_id": signal_id, "fill_id": f"cancel-{signal_id}", "status": "CANCELLED", "quantity_filled": 0, "backend": self.name})


def intent(signal_id="s1", **overrides):
    base = dict(signal_id=signal_id, instrument="BTC-PERP", side="buy", quantity=0.1, order_type="MARKET",
                strategy_id="alpha", limit_price=60000, stop=56000, leverage=DEFAULT_LEVERAGE)
    base.update(overrides)
    return ExecutionIntent.create(base)


def approve(**overrides):
    base = dict(signal_id="s1", approved=True, approved_leverage=5)
    base.update(overrides)
    return RiskDecision.create(base)


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "exec.sqlite3")


def test_one_signal_produces_exactly_one_order(db_path):
    store = Store(db_path)
    backend = FakeBackend(BACKEND_NAUTILUS_NATIVE)
    router = ExecutionRouter(store=store, risk_gate=lambda i: approve(), backends={BACKEND_NAUTILUS_NATIVE: backend})
    backend_name, fill = router.route(intent())
    assert fill.status == "FILLED"
    assert len(backend.submitted) == 1


def test_duplicate_signal_is_blocked_within_the_same_process(db_path):
    store = Store(db_path)
    backend = FakeBackend(BACKEND_NAUTILUS_NATIVE)
    router = ExecutionRouter(store=store, risk_gate=lambda i: approve(), backends={BACKEND_NAUTILUS_NATIVE: backend})
    router.route(intent())
    with pytest.raises(RouterError, match="EXECUTION_ROUTER_DUPLICATE_SIGNAL"):
        router.route(intent())
    assert len(backend.submitted) == 1


def test_duplicate_signal_is_still_blocked_after_a_simulated_restart(db_path):
    backend_a = FakeBackend(BACKEND_NAUTILUS_NATIVE)
    store_a = Store(db_path)
    router_a = ExecutionRouter(store=store_a, risk_gate=lambda i: approve(), backends={BACKEND_NAUTILUS_NATIVE: backend_a})
    router_a.route(intent())
    del store_a, router_a  # simulate process exit

    backend_b = FakeBackend(BACKEND_NAUTILUS_NATIVE)  # fresh in-memory state, same DB file
    store_b = Store(db_path)
    router_b = ExecutionRouter(store=store_b, risk_gate=lambda i: approve(), backends={BACKEND_NAUTILUS_NATIVE: backend_b})
    with pytest.raises(RouterError, match="EXECUTION_ROUTER_DUPLICATE_SIGNAL"):
        router_b.route(intent())
    assert len(backend_b.submitted) == 0


def test_risk_rejection_prevents_backend_call(db_path):
    store = Store(db_path)
    backend = FakeBackend(BACKEND_NAUTILUS_NATIVE)
    router = ExecutionRouter(store=store, risk_gate=lambda i: approve(approved=False, reason="MAX_PORTFOLIO_EXPOSURE"), backends={BACKEND_NAUTILUS_NATIVE: backend})
    with pytest.raises(RouterError, match="EXECUTION_ROUTER_RISK_REJECTED"):
        router.route(intent())
    assert len(backend.submitted) == 0


def test_leverage_ceiling_enforced_at_router(db_path):
    store = Store(db_path)
    backend = FakeBackend(BACKEND_NAUTILUS_NATIVE)
    router = ExecutionRouter(store=store, risk_gate=lambda i: approve(approved_leverage=1), backends={BACKEND_NAUTILUS_NATIVE: backend})
    with pytest.raises(RouterError, match="EXECUTION_ROUTER_LEVERAGE_EXCEEDS_APPROVAL"):
        router.route(intent(leverage=5))
    assert len(backend.submitted) == 0


def test_kill_switch_blocks_new_intents_at_router(db_path):
    store = Store(db_path)
    backend = FakeBackend(BACKEND_NAUTILUS_NATIVE)
    router = ExecutionRouter(store=store, risk_gate=lambda i: approve(), backends={BACKEND_NAUTILUS_NATIVE: backend})
    router.kill()
    with pytest.raises(RouterError, match="EXECUTION_ROUTER_KILLED"):
        router.route(intent())
    assert len(backend.submitted) == 0


def test_partial_fill_updates_position_correctly(db_path):
    store = Store(db_path)
    portfolio = NautilusPortfolio(store)
    portfolio.apply_fill(intent(quantity=1.0), fill_price=60000, quantity_filled=0.4, backend="NAUTILUS_NATIVE")
    position = portfolio.position("BTC-PERP")
    assert position.quantity == pytest.approx(0.4)
    portfolio.apply_fill(intent(quantity=1.0), fill_price=60100, quantity_filled=0.6, backend="NAUTILUS_NATIVE")
    position = portfolio.position("BTC-PERP")
    assert position.quantity == pytest.approx(1.0)


def test_restart_restores_persisted_positions(db_path):
    store_a = Store(db_path)
    portfolio_a = NautilusPortfolio(store_a)
    portfolio_a.apply_fill(intent(quantity=1.0), fill_price=60000, quantity_filled=1.0, backend="NAUTILUS_NATIVE")
    del portfolio_a, store_a  # simulate process exit

    store_b = Store(db_path)  # fresh process, same DB file
    portfolio_b = NautilusPortfolio(store_b)
    restored = portfolio_b.position("BTC-PERP")
    assert restored is not None
    assert restored.quantity == pytest.approx(1.0)
    assert restored.avg_entry == pytest.approx(60000)
