"""DATA 18 (#66): counterfactual portfolio learning. Costs are the real model's, alternatives are never assumed executable, everything is hypothetical."""
import json
import math
import os
import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.analysis import portfolio as P
from market_edge_exec.paper import lifecycle
from market_edge_exec.shadow import contracts as C, resolve as R
from tests.test_shadow import BAR, HEADERS, T0, bars_path
from tests.test_snapshot_builder import make_source

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
DAY = 24 * C.HOUR


def row(i, r, *, scan=None, rank=1, executed=False, cluster=None, episode=None, asset="BTC", pick=None, status="NOT_SUBMITTED", reason=None, ts=None):
    return {"observation_id": f"o{i}", "scan_id": scan or f"s{i}", "asset": asset, "direction": "long", "strategy": "S", "decision_ts": ts if ts is not None else T0 + i * 5 * DAY,
            "rank": rank, "is_pick": (rank == 1) if pick is None else pick, "production_rank": rank, "cluster": cluster or f"c{i}", "episode": episode or f"e{i}",
            "exec_status": status, "reject_reason": reason, "executed": executed, "r": r}


# ---- cost fidelity and executability --------------------------------------------------------------------------------
def test_the_r_used_is_exactly_the_real_cost_models_r_for_the_same_fill(tmp_path):
    store = make_source(tmp_path, n_scans=4, extra_same_cluster=False)
    data = P.load(store.path)
    assert data["rows"] and data["cost_model"]["re_costed_here"] is False
    assert data["cost_model"]["fee_pct_per_side"] == lifecycle.FEE_PCT and data["cost_model"]["slippage_pct_per_side"] == lifecycle.SLIPPAGE_PCT
    first = T0 - T0 % BAR
    n = (T0 + 3 * 4 * DAY + C.FULL_WINDOW_MS + 3 * C.HOUR - first) // BAR + 2
    bars = bars_path(first, [100 + 4 * math.sin(i / 400) for i in range(n)], spread=0.05)
    checked = 0
    with closing(sqlite3.connect(store.path)) as c:
        c.row_factory = sqlite3.Row
        for r in data["rows"]:
            o = c.execute("SELECT decision, first_bar_ts FROM shadow_observations WHERE observation_id=?", (r["observation_id"],)).fetchone()
            cand = json.loads(__import__("zlib").decompress(o["decision"]).decode())["candidate"]
            window = [b for b in bars if o["first_bar_ts"] <= b["time"] < o["first_bar_ts"] + C.FULL_WINDOW_MS]
            expect = R.current_policy(cand["direction"], cand["stop"], cand["tp1"], cand["tp2"], window, o["first_bar_ts"] + C.FULL_WINDOW_MS)["policy_r"]
            assert expect is not None and r["r"] == pytest.approx(expect, abs=1e-5), (r["observation_id"], r["r"], expect)
            checked += 1
    assert checked >= 4


def test_the_cost_model_really_is_the_lifecycle_one_and_the_analysis_has_none_of_its_own(monkeypatch):
    bars = bars_path(T0, [100.0, 101.0, 99.0, 98.0, 97.0, 96.0], spread=0.05)
    end = T0 + 6 * BAR
    honest = R.current_policy("long", 98.0, 102.0, 104.0, bars, end)["policy_r"]
    monkeypatch.setattr(lifecycle, "SLIPPAGE_PCT", 0.0)
    monkeypatch.setattr(lifecycle, "FEE_PCT", 0.0)
    assert R.current_policy("long", 98.0, 102.0, 104.0, bars, end)["policy_r"] != honest      # the R depends on the shared constants
    src = open(P.__file__).read()
    for cheating in ("0.0005", "0.0003", "FEE_PCT =", "SLIPPAGE_PCT =", "* (1 -", "* (1 +"):
        assert cheating not in src, cheating


def test_alternatives_that_were_not_valid_or_resolved_are_excluded_never_assumed_executable(tmp_path):
    store = make_source(tmp_path, n_scans=4, extra_same_cluster=False, unresolved_tail=True)
    with closing(sqlite3.connect(store.path)) as c:
        c.execute("INSERT INTO shadow_observations SELECT 'bad-1', scan_id, kind, asset, coin, direction, strategy, decision_ts, first_bar_ts, production_rank, scan_candidate_rank, "
                  "is_production_pick, production_state, execution_status, execution_rejection_reason, research_candidate_valid, invalid_reason, observation_cluster_id, "
                  "market_episode_id, overlap_fraction, generator_version, '', model_version, dataset_version, outcome_venue, outcome_interval, decision, decision_hash, created_at_ms, "
                  "source_commit FROM shadow_observations LIMIT 1")
        c.commit()
    data = P.load(store.path)
    ids = {r["observation_id"] for r in data["rows"]}
    assert "bad-1" not in ids
    assert sum(data["excluded"].values()) > 0 and all(isinstance(v, int) for v in data["excluded"].values())
    assert any(k.startswith("DATA_QUALITY_") or k.startswith("OUTCOME_UNRESOLVED") for k in data["excluded"]), data["excluded"]
    # every row kept has a real, resolved R and was research-valid at decision time
    assert all(isinstance(r["r"], float) for r in data["rows"])


def test_the_database_is_only_read(tmp_path):
    import hashlib
    store = make_source(tmp_path, n_scans=4, extra_same_cluster=False)
    before = hashlib.sha256(open(store.path, "rb").read()).hexdigest(), os.stat(store.path).st_mtime_ns
    P.analyse(store.path, bootstrap_n=50)
    assert (hashlib.sha256(open(store.path, "rb").read()).hexdigest(), os.stat(store.path).st_mtime_ns) == before


# ---- the comparisons -------------------------------------------------------------------------------------------------
def scans_with(n, r1, r2, r3=None):
    rows = []
    for i in range(n):
        rows.append(row(3 * i, r1(i), scan=f"s{i}", rank=1, cluster=f"c{i}", episode=f"e{i}", ts=T0 + i * 5 * DAY))
        rows.append(row(3 * i + 1, r2(i), scan=f"s{i}", rank=2, cluster=f"c{i}", episode=f"e{i}", ts=T0 + i * 5 * DAY))
        if r3:
            rows.append(row(3 * i + 2, r3(i), scan=f"s{i}", rank=3, cluster=f"c{i}", episode=f"e{i}", ts=T0 + i * 5 * DAY))
    return rows


def test_rank_one_clearly_better_and_clearly_no_different_are_told_apart():
    better = P.rank_comparison(scans_with(60, lambda i: 1.0 + (i % 3) * 0.1, lambda i: 0.0 + (i % 3) * 0.1, lambda i: -0.5), bootstrap_n=300)
    assert better["rank1_vs_rank2"]["verdict"] == "FIRST_BETTER" and better["rank1_vs_rank3"]["verdict"] == "FIRST_BETTER"
    assert better["rank1_vs_rank2"]["first_wins_share"] == 1.0 and better["mean_R_by_rank"]["1"]["n"] == 60
    same = P.rank_comparison(scans_with(60, lambda i: math.sin(i), lambda i: math.sin(i + 1)), bootstrap_n=300)
    assert same["rank1_vs_rank2"]["verdict"] == "NO_CLEAR_DIFFERENCE"
    worse = P.rank_comparison(scans_with(60, lambda i: -1.0 + (i % 3) * 0.1, lambda i: 0.5), bootstrap_n=300)
    assert worse["rank1_vs_rank2"]["verdict"] == "SECOND_BETTER"


def test_too_few_scans_never_produce_a_finding():
    r = P.rank_comparison(scans_with(10, lambda i: 5.0, lambda i: -5.0), bootstrap_n=100)
    assert r["rank1_vs_rank2"]["verdict"].startswith("NOT_ENOUGH_SCANS: have 10, need 30")
    assert r["rank1_vs_rank3"]["scans"] == 0


def test_a_scan_without_the_alternative_is_not_compared():
    rows = [row(0, 1.0, rank=1), row(1, 2.0, scan="s9", rank=1)]     # no rank-2 candidate anywhere
    assert P.rank_comparison(rows, bootstrap_n=50)["rank1_vs_rank2"]["scans"] == 0


def test_chosen_versus_rejected_reports_regret_against_only_real_alternatives():
    rows = []
    for i in range(40):
        rows.append(row(2 * i, 0.5, scan=f"s{i}", rank=1, executed=True, cluster=f"c{i}", ts=T0 + i * 5 * DAY))
        rows.append(row(2 * i + 1, 2.0 if i % 2 else -1.0, scan=f"s{i}", rank=2, cluster=f"c{i}", ts=T0 + i * 5 * DAY))
    out = P.chosen_vs_rejected(rows, bootstrap_n=200)
    assert out["chosen_vs_best_rejected"]["scans"] == 40 and out["mean_regret_R"] == pytest.approx(0.5 * 1.5)   # half the scans lose 1.5R to the better rejected candidate
    assert P.chosen_vs_rejected([row(0, 1.0, executed=True)], bootstrap_n=50)["chosen_vs_mean_of_rejected"]["scans"] == 0     # nothing to compare with


def test_concentration_flags_selections_that_share_an_episode_and_compares_drawdown():
    rows, i = [], 0
    for k in range(6):           # each pair shares an episode within hours: the second one loses
        ts = T0 + k * 5 * DAY
        rows.append(row(i, 1.0, scan=f"a{k}", executed=True, episode=f"E{k}", cluster=f"K{k}", ts=ts)); i += 1
        rows.append(row(i, -1.5, scan=f"b{k}", executed=True, episode=f"E{k}", cluster=f"K{k}b", ts=ts + 2 * C.HOUR)); i += 1
    rows.append(row(i, 0.3, scan="solo", executed=True, episode="Z", cluster="ZZ", ts=T0 + 40 * DAY))
    out = P.concentration(rows)
    assert out["concentrated"]["n"] == 12 and out["not_concentrated"]["n"] == 1 and out["concentrated"]["mean_R"] == pytest.approx(-0.25)
    assert out["hypothetical_first_per_episode"]["n"] == 7 and out["hypothetical_first_per_episode"]["cumulative_R"] > out["actual"]["cumulative_R"]
    assert out["hypothetical_first_per_episode"]["max_drawdown_R"] < out["actual"]["max_drawdown_R"]
    assert out["hypothetical_first_per_episode"]["note"].startswith("HYPOTHETICAL") and out["enough_for_a_finding"] is False


def test_cap_effect_counts_only_cap_rejections_and_says_it_is_informational():
    rows = [row(0, 2.0, pick=True, status="REJECTED", reason="PORTFOLIO_EXPOSURE_CAP"), row(1, -1.0, pick=True, status="REJECTED", reason="MAX_CONCURRENT_POSITIONS_EXCEEDED"),
            row(2, 5.0, pick=True, status="REJECTED", reason="KILL_SWITCH_ACTIVE"), row(3, 4.0, pick=False, status="REJECTED", reason="PORTFOLIO_EXPOSURE_CAP"),
            row(4, 0.5, executed=True, status="EXECUTED")]
    out = P.cap_effect(rows)
    assert out["blocked_by_caps"]["n"] == 2 and out["blocked_by_caps"]["sum_R"] == pytest.approx(1.0) and out["taken"]["n"] == 1
    assert out["blocked_by_caps"]["reasons"] == {"PORTFOLIO_EXPOSURE_CAP": 1, "MAX_CONCURRENT_POSITIONS_EXCEEDED": 1}
    assert "HYPOTHETICAL" in out["reading"] and "does not propose changing a cap" in out["reading"] and out["enough_for_a_finding"] is False


# ---- labelling and reach --------------------------------------------------------------------------------------------
def test_the_whole_report_is_labelled_hypothetical_and_proposes_nothing(tmp_path):
    store = make_source(tmp_path, n_scans=6, extra_same_cluster=False)
    result = P.analyse(store.path, bootstrap_n=50)
    assert result["label"].startswith("HYPOTHETICAL") and result["proposes_changes"] is False and "DATA 6/7/8/10/11" in result["note"]
    md = P.render_markdown(result)
    assert "HYPOTHETICAL" in md and "not re-costed here" in md and "Findings only" in md
    assert P.analyse(store.path, bootstrap_n=50) == result            # deterministic


def test_the_api_serves_it_and_the_module_reaches_nothing_that_can_act():
    src = open(P.__file__).read()
    for banned in ("record_sizing", "open_from_signal", "execution_router", "INSERT", "UPDATE ", "DELETE ", "requests", "httpx", "risk.engine"):
        assert banned not in src, banned


def test_api_route(tmp_path):
    from market_edge_exec.api.app import create_app
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"))
    r = TestClient(app).get("/research/counterfactual-portfolio", headers=HEADERS).json()
    assert r["candidates_used"] == 0 and r["label"].startswith("HYPOTHETICAL") and r["rank_comparison"]["rank1_vs_rank2"]["scans"] == 0
