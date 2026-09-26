"""Part E: real Market Edge signal -> paper execution bridge.

Covers: freshness validation (stale scan results are rejected before risk
or execution ever see them), correct risk-owned position sizing (the
signal's own numbers never set the traded quantity), rejection logging
(no-trade decisions are recorded, not silently dropped), and duplicate
signal_id handling end to end through the real router."""
import time

import pytest

from market_edge_exec.persistence.store import Store
from market_edge_exec.risk.engine import AccountState
from market_edge_exec.routing.router import BACKEND_NAUTILUS_NATIVE, ExecutionRouter
from market_edge_exec.signal_bridge.bridge import MAX_SIGNAL_AGE_SECONDS, is_fresh, process_signal
from market_edge_exec.domain.contracts import AlphaSignal, ExecutionFill


class FakeBackend:
    def __init__(self):
        self.submitted = []

    def submit(self, intent):
        self.submitted.append(intent)
        return ExecutionFill.create({"signal_id": intent.signal_id, "fill_id": f"fake-{intent.signal_id}", "status": "FILLED", "quantity_filled": intent.quantity, "avg_price": intent.limit_price, "backend": BACKEND_NAUTILUS_NATIVE})


def make_signal(**overrides):
    base = dict(signal_id="me-BTC-1", asset="BTC", direction="long", timestamp=int(time.time() * 1000), entry=60000, stop=56000, strategy_id="market-edge-alpha")
    base.update(overrides)
    return base


@pytest.fixture
def setup(tmp_path):
    store = Store(str(tmp_path / "bridge.sqlite3"))
    account = AccountState(equity=10_000.0, peak_equity=10_000.0)
    backend = FakeBackend()
    router = ExecutionRouter(store=store, risk_gate=lambda i: None, backends={BACKEND_NAUTILUS_NATIVE: backend})
    return store, account, router, backend


def test_fresh_signal_is_accepted_and_sized_by_risk_not_by_the_signal(setup):
    store, account, router, backend = setup
    result = process_signal(make_signal(), "BTC-PERP", router, account, store)
    assert result.accepted is True
    assert result.backend == BACKEND_NAUTILUS_NATIVE
    # risk_budget (1% of 10,000 equity) / stop_distance (4000) = 0.025 -- not
    # anything the raw signal payload specified (it has no quantity field at all).
    submitted_intent = backend.submitted[0]
    assert submitted_intent.quantity == pytest.approx(result.assessment.position_size)
    assert submitted_intent.quantity == pytest.approx(10_000 * 0.01 / 4000)


def test_stale_signal_is_rejected_before_risk_or_execution(setup):
    store, account, router, backend = setup
    old_ts = int(time.time() * 1000) - (MAX_SIGNAL_AGE_SECONDS + 60) * 1000
    result = process_signal(make_signal(timestamp=old_ts), "BTC-PERP", router, account, store)
    assert result.accepted is False
    assert result.reason == "STALE_SIGNAL"
    assert backend.submitted == []  # never reached execution
    failures = store.record_failure  # smoke: no exception recording it; check via direct query below
    with store._connect() as conn:  # noqa: SLF001
        row = conn.execute("SELECT reason FROM failures WHERE signal_id = ?", (result.signal_id,)).fetchone()
    assert row["reason"] == "STALE_SIGNAL"


def test_is_fresh_boundary():
    now_ms = 1_000_000_000
    assert is_fresh(AlphaSignal.create({"signal_id": "s", "asset": "BTC", "direction": "long", "timestamp": now_ms - MAX_SIGNAL_AGE_SECONDS * 1000}), now_ms) is True
    assert is_fresh(AlphaSignal.create({"signal_id": "s", "asset": "BTC", "direction": "long", "timestamp": now_ms - (MAX_SIGNAL_AGE_SECONDS + 1) * 1000}), now_ms) is False
    assert is_fresh(AlphaSignal.create({"signal_id": "s", "asset": "BTC", "direction": "long", "timestamp": now_ms + 5_000}), now_ms) is True
    assert is_fresh(AlphaSignal.create({"signal_id": "s", "asset": "BTC", "direction": "long", "timestamp": now_ms + 120_000}), now_ms) is False


def test_risk_rejection_is_logged_as_a_no_trade_decision_not_dropped(setup):
    store, account, router, backend = setup
    account.killed = True  # forces risk.approve() to reject with KILL_SWITCH_ACTIVE
    result = process_signal(make_signal(), "BTC-PERP", router, account, store)
    assert result.accepted is False
    assert result.reason == "KILL_SWITCH_ACTIVE"
    with store._connect() as conn:  # noqa: SLF001
        row = conn.execute("SELECT reason FROM failures WHERE signal_id = ?", (result.signal_id,)).fetchone()
    assert row["reason"] == "KILL_SWITCH_ACTIVE"


def test_duplicate_signal_id_is_rejected_on_the_second_call(setup):
    store, account, router, backend = setup
    first = process_signal(make_signal(), "BTC-PERP", router, account, store)
    assert first.accepted is True
    second = process_signal(make_signal(), "BTC-PERP", router, account, store)
    assert second.accepted is False
    assert "DUPLICATE" in second.reason
    assert len(backend.submitted) == 1  # never re-executed


def test_missing_entry_or_stop_is_rejected_with_a_clear_reason(setup):
    store, account, router, backend = setup
    result = process_signal(make_signal(entry=None), "BTC-PERP", router, account, store)
    assert result.accepted is False
    assert result.reason == "SIGNAL_MISSING_ENTRY_OR_STOP"
