"""MAJOR 6-pre (#70): Risk Sizing V2 forward comparison harness. Read-only, evidence + recommendation only."""
import hashlib
import json
import os
import sqlite3

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.evaluation import sizing_review as SR
from market_edge_exec.paper.ledger import PaperLedger

from tests.test_risk_sizing_v2_paper import HEADERS, post

DAY = 86_400_000
T0 = 1_780_000_000_000


def _stop_out(client, trade, low):
    t0 = trade["opened_at_ms"]
    client.post("/paper/mark", headers=HEADERS, json={"instrument": f"{trade['asset']}-PERP", "candles": [
        {"time": t0 - t0 % 300_000 + 300_000, "open": 100, "high": 100.2, "low": low, "close": low + 0.5}]})


def test_real_shadow_trade_is_paired_and_v2_scaling_matches_a_real_v2_run(tmp_path):
    shadow_db, paper_db = str(tmp_path / "s.sqlite3"), str(tmp_path / "p.sqlite3")
    shadow, paper = create_app(db_path=shadow_db, sizing_mode="SHADOW"), create_app(db_path=paper_db, sizing_mode="PAPER")
    cs, cp = TestClient(shadow), TestClient(paper)
    ts, tp = post(cs, "x1", stop_pct=0.10)["trade"], post(cp, "x1", stop_pct=0.10)["trade"]
    _stop_out(cs, ts, 89.0)
    _stop_out(cp, tp, 89.0)

    r = SR.review(shadow_db)
    assert r["trades"] == 1 and r["verdict"] == "INSUFFICIENT_EVIDENCE"
    pair = SR.load_pairs(shadow_db)["pairs"][0]
    assert pair["legacy_net"] == pytest.approx(shadow.state.ledger.sizing_outcome("x1")["realised_net_pnl"])
    # The scaled counterfactual equals what V2 actually realised when it was authoritative on the same path.
    real_v2_net = paper.state.ledger.sizing_outcome("x1")["realised_net_pnl"]
    assert pair["v2_qty"] == pytest.approx(tp["quantity"])
    assert pair["v2_net"] == pytest.approx(real_v2_net, rel=1e-6)
    # Legacy budgets price loss only, so a stop with slippage and fees overshoots it; V2's plan includes costs.
    assert pair["legacy_overshoot"] is True and pair["v2_overshoot"] is False


def test_paper_mode_trades_have_no_counterfactual_and_are_excluded(tmp_path):
    db = str(tmp_path / "p.sqlite3")
    app = create_app(db_path=db, sizing_mode="PAPER")
    c = TestClient(app)
    _stop_out(c, post(c, "p1", stop_pct=0.10)["trade"], 89.0)
    r = SR.review(db)
    assert r["trades"] == 0 and r["ledger_counts"]["excluded"] == {"MODE_PAPER_NO_COUNTERFACTUAL": 1}


def test_open_trades_are_never_judged(tmp_path):
    db = str(tmp_path / "s.sqlite3")
    c = TestClient(create_app(db_path=db, sizing_mode="SHADOW"))
    assert post(c, "o1", stop_pct=0.10)["accepted"]
    assert SR.review(db)["ledger_counts"]["excluded"] == {"OPEN_OR_UNRESOLVED": 1}


# ---- synthetic ledgers for the evidence bar ---------------------------------------------
def _legacy(ts, qty, planned, asset="SOL"):
    return {"sizing_rule_version": "LEGACY", "approved": True, "timestamp": ts, "asset": asset, "direction": "long",
            "wallet_equity": 10_000.0, "final_quantity": qty, "planned_loss_dollars": planned,
            "sizing_binding_constraint": "RISK_BUDGET", "cluster_id": "L1"}


def _v2(ts, qty, planned, approved=True, asset="SOL", reason=None):
    return {"sizing_rule_version": "V2", "approved": approved, "timestamp": ts, "asset": asset, "direction": "long",
            "wallet_equity": 10_000.0, "final_quantity": qty if approved else 0.0, "planned_loss_dollars": planned if approved else 0.0,
            "rejection_reason": reason, "risk_budget_dollars": 100.0, "vol_multiplier": 0.8, "drawdown_multiplier": 1.0,
            "sizing_binding_constraint": "RISK_BUDGET" if approved else reason, "cluster_id": "L1", "cluster_cap_applied": False}


def _ledger(tmp_path, trades):
    """trades: (legacy_qty, legacy_planned, v2_qty, v2_planned, legacy_net_pnl, v2_approved)."""
    db = str(tmp_path / "l.sqlite3")
    ledger = PaperLedger(db)
    for i, (lq, lp, vq, vp, net, ok) in enumerate(trades):
        sid, ts = f"t{i}", T0 + i * DAY
        ledger.record_sizing(sid, "SOL", "SHADOW", "AUTHORITATIVE", {**_legacy(ts, lq, lp), "role": "AUTHORITATIVE"}, at_ms=ts)
        ledger.record_sizing(sid, "SOL", "SHADOW", "COUNTERFACTUAL",
                             {**_v2(ts, vq, vp, ok, reason=None if ok else "NO_VOLATILITY_STATE"), "role": "COUNTERFACTUAL"}, at_ms=ts)
    with sqlite3.connect(db) as conn:
        for i, (lq, lp, vq, vp, net, ok) in enumerate(trades):
            sid, ts = f"t{i}", T0 + i * DAY
            conn.execute("INSERT INTO risk_sizing_outcomes VALUES (?,?,?)", (sid, ts + 3600_000, json.dumps(
                {"signal_id": sid, "realised_net_pnl": net, "exit_reason": "STOP" if net < 0 else "TP2"})))
    return db


def test_below_the_floor_is_insufficient_never_a_verdict(tmp_path):
    db = _ledger(tmp_path, [(1.0, 100.0, 0.5, 80.0, 50.0, True)] * 10)
    r = SR.review(db)
    assert r["verdict"] == "INSUFFICIENT_EVIDENCE" and r["checks"] == {} and "NOT YET" in r["recommendation"]


def test_empty_ledger_is_insufficient_with_zero_counts(tmp_path):
    db = str(tmp_path / "e.sqlite3")
    PaperLedger(db)
    r = SR.review(db)
    assert (r["trades"], r["independent_episodes"], r["verdict"]) == (0, 0, "INSUFFICIENT_EVIDENCE")


def test_v2_that_keeps_losses_inside_plan_passes(tmp_path):
    # Legacy loses 110 against a 100 plan (costs outside the budget); V2 at 0.8x size loses 88 against a 95 plan.
    trades = [(1.0, 100.0, 0.8, 95.0, -110.0 if i % 3 == 0 else 60.0, True) for i in range(40)]
    r = SR.review(_ledger(tmp_path, trades))
    assert r["trades"] == 40 and r["independent_episodes"] == 40
    assert r["legacy"]["overshoot_rate"] == 1.0 and r["v2"]["overshoot_rate"] == 0.0
    assert r["verdict"] == "PASS", r["failed_checks"]
    assert "PAPER" in r["recommendation"] and r["promotion"].startswith("NONE")


def test_v2_that_overshoots_its_own_plan_fails(tmp_path):
    # V2 larger than legacy and its losses blow through its own (too small) plan.
    trades = [(1.0, 100.0, 1.5, 100.0, -110.0 if i % 2 == 0 else 20.0, True) for i in range(40)]
    r = SR.review(_ledger(tmp_path, trades))
    assert r["verdict"] == "FAIL"
    assert {"v2_overshoot_within_cap", "drawdown_not_worse"} <= set(r["failed_checks"])
    assert "SHADOW" in r["recommendation"]


def test_v2_rejections_count_as_zero_not_dropped(tmp_path):
    trades = [(1.0, 100.0, 0.8, 95.0, 50.0, i % 4 != 0) for i in range(40)]
    r = SR.review(_ledger(tmp_path, trades))
    assert r["trades"] == 40 and r["v2_rejected_trades"] == 10
    assert r["v2_rejections_by_reason"] == {"NO_VOLATILITY_STATE": 10}
    assert r["v2"]["total_net_pnl"] == pytest.approx(30 * 50.0 * 0.8)


def test_tampered_record_is_excluded_and_counted(tmp_path):
    db = _ledger(tmp_path, [(1.0, 100.0, 0.8, 95.0, 50.0, True)] * 3)
    with sqlite3.connect(db) as conn:      # simulate a corrupted copy: rebuild the table without the immutability trigger
        conn.execute("DROP TRIGGER risk_sizing_decisions_no_update")
        conn.execute("UPDATE risk_sizing_decisions SET record = replace(record, '0.8', '9.9') WHERE role='COUNTERFACTUAL' AND signal_id='t0'")
    loaded = SR.load_pairs(db)
    assert loaded["excluded"]["RECORD_HASH_MISMATCH"] == 1
    assert all(p["v2_qty"] != 9.9 for p in loaded["pairs"])


def test_review_is_read_only(tmp_path):
    db = _ledger(tmp_path, [(1.0, 100.0, 0.8, 95.0, -50.0, True)] * 5)
    before = hashlib.sha256(open(db, "rb").read()).hexdigest()
    SR.review(db)
    assert hashlib.sha256(open(db, "rb").read()).hexdigest() == before
    with pytest.raises(sqlite3.OperationalError):
        SR._connect_ro(db).execute("INSERT INTO risk_sizing_outcomes VALUES ('z', 1, '{}')")


def test_cli_renders_markdown_and_json(tmp_path, capsys):
    db = _ledger(tmp_path, [(1.0, 100.0, 0.8, 95.0, 50.0, True)] * 2)
    assert SR.main([db]) == 0
    out = capsys.readouterr().out
    assert "INSUFFICIENT_EVIDENCE" in out and "Promotion:** NONE" in out
    assert SR.main([db, "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["trades"] == 2
