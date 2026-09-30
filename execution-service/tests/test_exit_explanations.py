"""TASK S: 'why did this trade exit?' explanations are built from recorded facts only, and the exit kinds that cannot be told apart are stated."""
import os

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.paper import trade_detail as TD
from tests.test_risk_sizing_v2_paper import post, now_ms

os.environ["MARKET_EDGE_EXEC_API_KEY"] = "test-key"


@pytest.fixture
def app_client(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), sizing_mode="SHADOW")
    return app, TestClient(app)


def test_stop_exit_explains_itself_with_friction_overshoot_and_latency(app_client):
    app, client = app_client
    t = post(client, "e1", stop_pct=0.10)["trade"]
    opened = t["opened_at_ms"]
    app.state.paper.tick("SOL-PERP", 99.0, opened + 1_000, "TEST", trigger="POLL_HEARTBEAT", now_ms=opened + 1_000)
    app.state.paper.tick("SOL-PERP", t["stop"] - 0.5, opened + 6_000, "TEST", trigger="WS_TRADE", now_ms=opened + 6_400)
    trade = app.state.ledger.trade("e1")
    [x] = TD.exit_explanations(trade)
    assert x["kind"] == "STOP" and "fell through the stop" in x["why"] and x["trigger"] == "WS_TRADE" and "live exchange trade print" in x["seen_by"]
    assert x["overshoot_bps"] == pytest.approx(0.5 / t["stop"] * 10_000) and x["overshoot_R"] > 0
    assert x["decision_latency_ms"] == 400 and x["since_previous_observation_ms"] == 5_000
    assert x["friction_provenance"] == "measured" and x["actual_slippage_bps"] > x["expected_slippage_bps"] and x["difference_bps"] > 0
    assert x["recorded"] == {"friction": True, "stop_overshoot": True}
    detail = TD.build_trade_detail(app.state.ledger, trade, now_ms(), 60.0)
    assert detail["exit_explanations"] == TD.exit_explanations(trade) and detail["exit_coverage"] == TD.EXIT_COVERAGE


def test_old_exit_without_recorded_fields_shows_none_never_invented():
    trade = {"exits": [{"kind": "TP1", "quantity": 1.0, "fill_price": 110.0, "level": 110.0, "pnl": 9.0, "at_ms": 5}]}
    [x] = TD.exit_explanations(trade)
    assert x["kind"] == "TP1" and "first target" in x["why"] and x["trigger"] == "CANDLE_5M" and "no live price" in x["seen_by"]
    for k in ("overshoot_bps", "actual_slippage_bps", "expected_slippage_bps", "difference_bps", "decision_latency_ms", "friction_provenance"):
        assert x[k] is None, k
    assert x["recorded"] == {"friction": False, "stop_overshoot": False}


def test_every_lifecycle_exit_kind_has_an_explanation_and_unknown_kinds_are_labelled_not_guessed():
    for kind in ("TP1", "TP2", "STOP", "BREAKEVEN_STOP", "TIMEOUT"):
        assert kind in TD.EXIT_WHY
    [x] = TD.exit_explanations({"exits": [{"kind": "WEIRD", "quantity": 1, "fill_price": 1, "at_ms": 1}]})
    assert "no explanation text" in x["why"]


def test_coverage_says_manual_kill_switch_and_adaptive_exits_are_not_distinguishable():
    cov = TD.EXIT_COVERAGE
    assert set(cov) == {"MANUAL", "KILL_SWITCH", "ADAPTIVE"} and not any(c["distinguishable"] for c in cov.values())
    assert cov["MANUAL"]["exists"] is False and cov["ADAPTIVE"]["exists"] is False and cov["KILL_SWITCH"]["exists"] is True


def test_the_gap_claims_are_true_of_the_code_today(app_client):
    """If someone adds a manual path or a kill-switch exit kind, this fails and the coverage text must be updated."""
    import inspect
    from market_edge_exec.paper import engine, lifecycle
    src = inspect.getsource(engine) + inspect.getsource(lifecycle)
    assert '"MANUAL"' not in src and "'MANUAL'" not in src            # nothing emits a manual exit kind
    kinds = {"TP1", "TP2", "STOP", "BREAKEVEN_STOP", "TIMEOUT"}
    assert all(f'"{k}"' in src for k in kinds)
    app, client = app_client
    t = post(client, "k1", stop_pct=0.10)["trade"]
    app.state.router.kill("TEST_KILL")
    app.state.paper.tick("SOL-PERP", t["stop"] - 1, t["opened_at_ms"] + 2_000, "TEST", trigger="WS_TRADE", now_ms=t["opened_at_ms"] + 2_000)
    ex = app.state.ledger.trade("k1")["exits"][0]
    assert ex["kind"] == "STOP" and not any("kill" in str(k).lower() for k in ex)      # exits still go through, unmarked
    assert app.state.ledger.trade("k1")["status"] == "CLOSED"
