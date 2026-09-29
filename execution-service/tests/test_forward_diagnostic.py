"""MAJOR 5-pre (#72): forward data diagnostic harness. Evidence and uncertainty only, read-only, placebo actually checked."""
import hashlib
import json
import os
import random

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.analysis import forward_diagnostic as D
from market_edge_exec.api.app import create_app
from tests.test_counterfactual_portfolio import row
from tests.test_snapshot_builder import make_source

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")


def null_rows(n_clusters=60, per=3, seed=1, effect=0.0):
    """Clusters of long/short rows; outcomes are cluster noise plus `effect` for longs only."""
    rng = random.Random(seed)
    rows = []
    for c in range(n_clusters):
        direction = "long" if c % 2 == 0 else "short"
        base = rng.gauss(0, 1)
        for k in range(per):
            r = row(c * per + k, base + rng.gauss(0, 0.3) + (effect if direction == "long" else 0.0), cluster=f"c{c}", scan=f"s{c}")
            r["direction"] = direction
            rows.append(r)
    return rows


# ---- on a real resolved shadow database -------------------------------------------------------------------------
def test_real_shadow_db_gives_a_full_report_with_counts_on_every_section(tmp_path):
    store = make_source(tmp_path, n_scans=8, extra_same_cluster=False)
    r = D.diagnose(store.path)
    ev = r["evidence"]
    assert ev["counts"]["resolved_candidates"] > 0 and ev["sufficient"] is False     # tiny fixture: never "sufficient"
    assert any(m.startswith("independent_clusters") for m in ev["missing"])
    for key in ("rejected_vs_accepted", "skipped_vs_taken", "long_vs_short"):
        assert r[key]["verdict"].startswith("NOT_ENOUGH"), r[key]["verdict"]
        for g in r[key]["groups"].values():
            assert {"n", "clusters", "ci95"} <= set(g)
    assert r["placebo_calibration"]["status"] == "NOT_RUN" and "clusters" in r["placebo_calibration"]["reason"]
    assert r["exit_counterfactuals"]["status"] == "NOT_PROVIDED"
    assert r["promotion"].startswith("NONE")
    md = D.render_markdown(r)
    assert "INSUFFICIENT" in md and "Placebo calibration" in md and "NOT RUN" in md


def test_the_databases_are_only_read(tmp_path):
    store = make_source(tmp_path, n_scans=4, extra_same_cluster=False)
    paper = str(tmp_path / "paper.sqlite3")
    create_app(db_path=paper)
    before = [(hashlib.sha256(open(p, "rb").read()).hexdigest(), os.stat(p).st_mtime_ns) for p in (store.path, paper)]
    D.diagnose(store.path, paper)
    assert [(hashlib.sha256(open(p, "rb").read()).hexdigest(), os.stat(p).st_mtime_ns) for p in (store.path, paper)] == before


def test_exit_counterfactuals_run_through_the_3h_harness_when_a_ledger_is_given(tmp_path):
    store = make_source(tmp_path, n_scans=4, extra_same_cluster=False)
    paper = str(tmp_path / "paper.sqlite3")
    create_app(db_path=paper)
    ex = D.diagnose(store.path, paper)["exit_counterfactuals"]
    assert ex["status"] == "EVALUATED" and ex["trades_with_baseline"] == 0
    assert ex["evidence_bar"] == "EXIT-EVIDENCE-BAR-V1"


# ---- the comparison and its placebo ------------------------------------------------------------------------------
def test_null_data_finds_no_difference():
    rows = null_rows(effect=0.0)
    c = D.compare([r for r in rows if r["direction"] == "long"], [r for r in rows if r["direction"] == "short"], "LONG", "SHORT", permutations=200)
    assert c["verdict"] in ("NO_CLEAR_DIFFERENCE",) and c["placebo_permutation_p"] > D.ALPHA


def test_a_planted_effect_is_found_with_ci_and_placebo_agreeing():
    rows = null_rows(effect=2.0)
    c = D.compare([r for r in rows if r["direction"] == "long"], [r for r in rows if r["direction"] == "short"], "LONG", "SHORT", permutations=200)
    assert c["verdict"] == "LONG_HIGHER"
    assert c["delta_ci95"][0] > 0 and c["placebo_permutation_p"] < D.ALPHA


def test_rows_are_not_evidence_clusters_are():
    # 200 rows but only 6 clusters: many rows, little independent evidence
    rows = null_rows(n_clusters=6, per=34, effect=2.0)
    c = D.compare([r for r in rows if r["direction"] == "long"], [r for r in rows if r["direction"] == "short"], "LONG", "SHORT")
    assert c["verdict"].startswith("NOT_ENOUGH") and c["groups"]["LONG"]["n"] > 100


def test_calibration_is_actually_run_and_near_nominal_on_null_data():
    rows = null_rows(n_clusters=80, effect=0.0)
    cal = D.calibrate(rows, lambda r: r["direction"] == "long", runs=60)
    assert cal["status"] == "CHECKED" and cal["runs"] >= 50
    assert cal["false_positive_rate"] <= 2 * D.ALPHA


def test_evidence_floors_need_every_count_not_just_rows():
    rows = [row(i, 0.1, asset="BTC", cluster="c0") for i in range(500)]
    ev = D.evidence(rows, [])
    assert ev["sufficient"] is False
    assert any(m.startswith("assets") for m in ev["missing"]) and any(m.startswith("max_single_asset_share") for m in ev["missing"])


def test_group_breakdowns_say_when_a_group_is_too_small():
    rows = null_rows(n_clusters=30) + [row(999, 5.0, asset="DOGE", cluster="d0")]
    g = D.by_group(rows, "asset")
    assert g["DOGE"]["enough"] is False and g["BTC"]["enough"] is True and g["DOGE"]["clusters"] == 1


def test_no_trade_share_is_reported_with_its_interval_and_caveat():
    states = [{"production_state": "NO_TRADE", "classification": "MISSED_OPPORTUNITY" if i % 4 == 0 else "NO_TRADE_CORRECT",
               "cluster": f"c{i}", "asset": "BTC", "decision_ts": i, "episode": f"e{i}", "observation_id": f"m{i}"} for i in range(40)]
    states.append({"production_state": "NO_TRADE", "classification": None, "cluster": "x", "asset": "BTC", "decision_ts": 0, "episode": "x", "observation_id": "u"})
    nt = D.no_trade(states)
    assert nt["resolved_no_trade_states"] == 40 and nt["unresolved"] == 1
    assert nt["missed_opportunity_share"] == pytest.approx(0.25) and nt["ci95"][0] < 0.25 < nt["ci95"][1]
    assert "DIAGNOSTIC_UNVALIDATED" in nt["caveat"]


def test_cli(tmp_path, capsys):
    store = make_source(tmp_path, n_scans=4, extra_same_cluster=False)
    assert D.main([store.path]) == 0
    assert "Forward data diagnostic batch" in capsys.readouterr().out
    assert D.main([store.path, "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["diagnostic_version"] == D.DIAGNOSTIC_VERSION
