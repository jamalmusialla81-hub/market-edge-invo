"""DATA 10 (#60): forward validation. Thin evidence is reported as thin, never rounded up; counts are always cited."""
import json
import os
import random
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.evaluation import forward as F
from market_edge_exec.experiments.registry import ExperimentRegistry
from market_edge_exec.shadow import contracts as C
from market_edge_exec.shadow.store import ShadowStore, _blob
from tests.test_shadow import HEADERS

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
T0 = 1_760_000_000_000
DAY = F.MS_DAY
ASSETS = ["BTC", "ETH", "SOL", "XRP", "ADA", "LINK"]


def make_scans(n, *, days=30, edge=0.5, assets=ASSETS, regimes=("trend", "range"), seed=3, choice_share=0.6):
    """Synthetic resolved forward scans; `edge` is the challenger's true advantage over production and random."""
    rng = random.Random(seed)
    out = []
    for i in range(n):
        base = rng.gauss(0, 1)
        agrees = rng.random() > choice_share
        prod = base
        chal = prod if agrees else base + edge + rng.gauss(0, 0.5)
        out.append({"scan_id": f"s{i}", "decision_ts": T0 + int(i * days * DAY / max(1, n - 1)), "cluster": f"c{i}", "episode": f"e{i}", "asset": assets[i % len(assets)],
                    "direction": "long", "regime": regimes[i % len(regimes)], "challenger_r": chal, "production_r": prod, "random_r": base - 0.3, "agrees": agrees,
                    "pairs": [(1.0, chal), (0.0, base - 0.6), (-1.0, base - 0.9)]})
    return out


def test_few_episodes_are_insufficient_however_many_days_pass():
    scans = make_scans(8, days=400)      # over a year of calendar time, eight scans
    r = F.validate(scans, bootstrap_n=50)
    assert r["verdict"] == "INSUFFICIENT_EVIDENCE" and r["promotable"] is False
    assert r["evidence"]["forward_days"] > 300, "elapsed time was long; that must not matter"
    assert any(m.startswith("resolved forward scans: have 8, need 60") for m in r["evidence_missing"])
    assert any(m.startswith("independent market episodes: have 8, need 30") for m in r["evidence_missing"])
    assert not any("forward days" in m for m in r["evidence_missing"])      # the day floor alone was met and did not rescue it


def test_enough_episodes_with_one_asset_is_still_insufficient():
    r = F.validate(make_scans(120, assets=["BTC"]), bootstrap_n=50)
    assert r["verdict"] == "INSUFFICIENT_EVIDENCE"
    assert any(m.startswith("distinct assets: have 1, need 4") for m in r["evidence_missing"])
    assert any("asset concentration: one asset is 100%" in m for m in r["evidence_missing"])
    assert r["performance"] is not None       # the numbers are shown, the verdict just does not use them


def test_enough_scans_but_one_regime_is_insufficient():
    r = F.validate(make_scans(120, regimes=("trend",)), bootstrap_n=50)
    assert r["verdict"] == "INSUFFICIENT_EVIDENCE" and any(m.startswith("distinct regimes: have 1, need 2") for m in r["evidence_missing"])


def test_a_short_window_is_insufficient_even_with_many_scans():
    r = F.validate(make_scans(120, days=5), bootstrap_n=50)
    assert r["verdict"] == "INSUFFICIENT_EVIDENCE" and any(m.startswith("forward days: have 5") for m in r["evidence_missing"])


def test_scans_where_it_always_agrees_carry_no_information():
    r = F.validate(make_scans(120, choice_share=0.05), bootstrap_n=50)
    assert r["verdict"] == "INSUFFICIENT_EVIDENCE" and any(m.startswith("scans where it chose differently") for m in r["evidence_missing"])


def test_the_evaluation_cites_specific_counts_not_a_vague_verdict():
    r = F.validate(make_scans(120), bootstrap_n=50)
    for key in ("resolved_scans", "independent_episodes", "clusters", "choice_scans", "forward_days", "assets", "regimes", "max_single_asset_share", "scans_with_production_pick"):
        assert isinstance(r["evidence"][key], (int, float)), key
    assert r["evidence"]["resolved_scans"] == 120 and r["evidence"]["independent_episodes"] == 120 and r["evidence"]["assets"] == 6
    assert set(r["floors"]) >= {"resolved_scans", "independent_episodes", "choice_scans", "days", "assets", "regimes"}
    assert "elapsed time alone is never sufficient" in r["elapsed_time_note"]


def test_a_real_and_stable_edge_can_reach_forward_promising_but_is_never_promotable():
    r = F.validate(make_scans(200, edge=1.0), bootstrap_n=300)
    assert r["evidence_missing"] == []
    assert r["verdict"] == "FORWARD_PROMISING", r["performance"]["vs_production"]
    assert r["promotable"] is False and r["performance"]["vs_production"]["ci"][0] > 0


def test_no_edge_is_reported_as_no_evidence():
    r = F.validate(make_scans(200, edge=0.0), bootstrap_n=300)
    assert r["evidence_missing"] == [] and r["verdict"] == "NO_EVIDENCE"


def test_an_edge_that_only_one_block_carries_is_not_promising():
    scans = make_scans(200, edge=0.0)
    for s in scans[:50]:                       # the whole advantage sits in the first quarter
        if not s["agrees"]:
            s["challenger_r"] = s["production_r"] + 3.0
    r = F.validate(scans, bootstrap_n=300)
    assert r["verdict"] != "FORWARD_PROMISING"
    assert r["performance"]["vs_production"]["without_best_block"]["ci_low_positive"] is False, "removing the carrying block must remove the evidence"


def test_a_thin_edge_does_not_survive_a_cost_haircut_check():
    r = F.validate(make_scans(200, edge=0.12, choice_share=0.6), bootstrap_n=300)
    sens = r["performance"]["vs_production"]["execution_sensitivity"]
    assert set(sens) == {"haircut_0.05R", "haircut_0.1R"}
    assert sens["haircut_0.1R"]["mean_delta_R"] < r["performance"]["vs_production"]["mean_delta_R"]


def test_placebo_calibration_makes_the_interval_more_skeptical():
    assert F.skepticism_alpha(None) == F.BASE_ALPHA == F.skepticism_alpha(0.03)
    assert F.skepticism_alpha(0.25) < F.BASE_ALPHA and F.skepticism_alpha(10) == 0.005


def test_the_evaluation_is_deterministic():
    a = F.validate(make_scans(150), bootstrap_n=200)
    b = F.validate(make_scans(150), bootstrap_n=200)
    assert a["result_hash"] == b["result_hash"]


# ---- collecting from a real store ------------------------------------------------------------------
def add_obs(store, oid, scan_id, asset, ts, cluster, *, r=None, window_end=None, status="OK"):
    with closing(store._connect()) as c:
        c.execute("INSERT INTO shadow_observations (observation_id, scan_id, kind, asset, coin, direction, strategy, decision_ts, first_bar_ts, production_rank, "
                  "scan_candidate_rank, is_production_pick, execution_status, research_candidate_valid, observation_cluster_id, market_episode_id, overlap_fraction, "
                  "generator_version, feature_version, dataset_version, outcome_venue, outcome_interval, decision, decision_hash, created_at_ms) "
                  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (oid, scan_id, "CANDIDATE", asset, asset, "long", "S", ts, ts, 1, 1, 0, "NOT_SUBMITTED", 1, cluster, cluster, 0.0,
                   "g", "f", "d", "v", "i", _blob({"candidate": {"regime": "trend"}}), "h" + oid, ts))
        if r is not None:
            c.execute("INSERT INTO shadow_labels VALUES (?,?,?,?,?,?,?,?,?)",
                      (oid, C.FINAL_BATCH, window_end or ts + 72 * 3_600_000, "OK", "l", "d", _blob({"72h": {"label_status": status, "policy_r": r}}), "lh" + oid, ts))
        c.commit()


def add_prediction(store, pid, scan_id, ts, chal, prod, oids, *, created=None, tamper=False):
    record = {"challenger_ranking": [{"oid": o, "asset": "BTC", "score": float(len(oids) - i)} for i, o in enumerate(oids)], "challenger_choice": chal,
              "production_choice": prod, "agrees_with_production": chal == prod}
    with closing(store._connect()) as c:
        c.execute("INSERT INTO shadow_model_predictions VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (pid, "m1", "ah", scan_id, ts, prod, chal, _blob(record), "bad" if tamper else C.content_hash(record), created or ts + 1000))
        c.commit()


def test_collect_joins_only_resolved_and_pre_outcome_predictions(tmp_path):
    store = ShadowStore(str(tmp_path / "s.sqlite3"))
    for scan_id, rs in (("A", (1.0, 0.0)), ("B", (2.0, 1.0)), ("P", (None, None)), ("U", (1.0,))):
        for k, r in enumerate(rs):
            add_obs(store, f"{scan_id}{k}", scan_id, "BTC", T0, f"c{scan_id}", r=r)
    add_obs(store, "U1", "U", "BTC", T0, "cU", r=1.0, status="INSUFFICIENT_DATA")      # label exists but is not OK
    for k in range(2):
        add_obs(store, f"L{k}", "L", "BTC", T0, "cL", r=1.0, window_end=T0 + 5)         # window closed before the prediction was frozen
    add_prediction(store, "pA", "A", T0, "A0", "A1", ["A0", "A1"])
    add_prediction(store, "pB", "B", T0 + 1, "B0", "B0", ["B0", "B1"])
    add_prediction(store, "pP", "P", T0 + 2, "P0", "P1", ["P0", "P1"])
    add_prediction(store, "pU", "U", T0 + 3, "U0", "U1", ["U0", "U1"])
    add_prediction(store, "pL", "L", T0 + 4, "L0", "L0", ["L0", "L1"], created=T0 + 999)
    add_prediction(store, "pT", "A", T0 + 5, "A0", "A0", ["A0", "A1"], tamper=True)
    got = F.collect(store, "m1")
    assert got["predictions"] == 6 and got["pending"] == 1
    assert got["excluded"] == {"UNRESOLVED_CANDIDATE_LABEL": 1, "PREDICTION_NOT_PRE_OUTCOME": 1, "RECORD_HASH_MISMATCH": 1}
    by = {s["scan_id"]: s for s in got["scans"]}
    assert set(by) == {"A", "B"}
    assert by["A"]["challenger_r"] == 1.0 and by["A"]["production_r"] == 0.0 and by["A"]["random_r"] == 0.5 and by["A"]["agrees"] is False
    assert by["B"]["agrees"] is True and by["B"]["challenger_r"] == by["B"]["production_r"] == 2.0 and by["A"]["regime"] == "trend"


def test_run_logs_to_the_registry_with_counts_and_promotes_nothing(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"))
    reg = ExperimentRegistry(app.state.shadow)
    for k in range(3):
        add_obs(app.state.shadow, f"a{k}", "A", "BTC", T0, "cA", r=float(k))
    add_prediction(app.state.shadow, "p1", "A", T0, "a2", "a0", ["a2", "a1", "a0"])
    client = TestClient(app)
    out = client.post("/research/shadow-models/m1/validate", headers=HEADERS).json()
    assert out["verdict"] == "INSUFFICIENT_EVIDENCE" and out["promotable"] is False and out["evidence"]["resolved_scans"] == 1
    h = reg.history(out["experiment_id"])
    assert h["status"] == "NO_EVIDENCE" and h["latest_results"]["evidence_missing"] == out["evidence_missing"]
    assert h["last_status_event"]["note"].startswith("INSUFFICIENT EVIDENCE: resolved forward scans: have 1, need 60")
    assert all(reg.status_of(e["experiment_id"]) != "SHADOW_CANDIDATE" for e in reg.list())
    dry = client.get("/research/shadow-models/m1/validation", headers=HEADERS).json()
    assert "experiment_id" not in dry and len(reg.list()) == 1        # the GET recorded nothing


def test_the_module_can_only_read_and_never_writes_a_deployment_or_a_state():
    src = open(F.__file__).read()
    for banned in ("INSERT INTO shadow_model_deployments", "deploy(", "retire(", "SHADOW_CANDIDATE", "assert_placebo_passed"):
        assert banned not in src.replace('"SHADOW_CANDIDATE"', ""), banned
    assert "INSERT" not in src and "UPDATE" not in src and "DELETE" not in src
