"""TASK K: dynamic correlation clusters are versioned candidates that can only tighten the static grouping and never touch a decision."""
import inspect
import math
import random

import pytest

from market_edge_exec.risk import clusters as static
from market_edge_exec.risk import dynamic_clusters as D
from market_edge_exec.risk import sizing_v2 as S

N = 800
C = D.CANDIDATES["CLUSTER-DYN-V1-C65"]


def closes(returns, start=100.0):
    out, p = [start], start
    for r in returns:
        p *= math.exp(r)
        out.append(p)
    return out


def factor_series(seed, loadings, n=N, noise=0.004):
    """Assets that load on one common factor plus their own noise, returned as closes."""
    rnd = random.Random(seed)
    factor = [rnd.gauss(0, 0.01) for _ in range(n)]
    return {a: closes([l * f + rnd.gauss(0, noise) for f in factor]) for a, l in loadings.items()}, factor


def test_correlated_alts_link_beyond_the_static_map_and_an_independent_asset_does_not():
    data, _ = factor_series(1, {"BTC": 1.0, "SOL": 1.2, "DOGE": 1.1})           # SOL and DOGE are in different static clusters
    rnd = random.Random(2)
    data["FIL"] = closes([rnd.gauss(0, 0.01) for _ in range(N)])                # independent of the factor
    assert static.cluster_for("SOL")[0] != static.cluster_for("DOGE")[0]
    r = D.compute(data, C)
    assert r["assignments"]["SOL"] == r["assignments"]["DOGE"] == r["assignments"]["BTC"]
    assert r["assignments"]["FIL"] != r["assignments"]["SOL"]
    assert {frozenset((l["a"], l["b"])) for l in r["links"]} >= {frozenset(("SOL", "DOGE")), frozenset(("BTC", "SOL"))}
    assert all(l["min_abs_corr"] >= C.link_level for l in r["links"])


@pytest.mark.parametrize("seed", range(12))
@pytest.mark.parametrize("version", list(D.CANDIDATES))
def test_never_looser_than_the_static_map_on_arbitrary_data(seed, version):
    rnd = random.Random(seed)
    assets = ["BTC", "ETH", "SOL", "AVAX", "DOGE", "PEPE", "UNI", "AAVE", "FET", "XYZ1", "XYZ2", "XYZ3"]
    loadings = {a: rnd.uniform(-0.5, 1.5) for a in assets}
    data, _ = factor_series(seed, loadings, noise=rnd.uniform(0.001, 0.02))
    for a in rnd.sample(assets, 3):
        data[a] = closes([rnd.gauss(0, 0.01) for _ in range(N)])                # some fully independent
    r = D.compute(data, D.CANDIDATES[version])
    assert D.refines_static(r)
    # both members of every static cluster (and all UNCLASSIFIED assets together) share a dynamic cluster
    for members in ({a for a in assets if static.cluster_for(a)[0] == c} for c in set(static.cluster_for(a)[0] for a in assets)):
        assert len({r["assignments"][a] for a in members}) == 1


def test_known_correlated_pair_is_kept_together_even_when_the_data_says_they_are_independent():
    rnd = random.Random(5)
    data = {"BTC": closes([rnd.gauss(0, 0.01) for _ in range(N)]), "ETH": closes([rnd.gauss(0, 0.01) for _ in range(N)])}   # statically one MAJORS cluster
    r = D.compute(data, C)
    assert r["assignments"]["BTC"] == r["assignments"]["ETH"] and not r["links"]


def test_unclassified_assets_stay_in_one_shared_cluster():
    rnd = random.Random(6)
    data = {a: closes([rnd.gauss(0, 0.01) for _ in range(N)]) for a in ("ZZA", "ZZB", "ZZC")}
    assert {static.cluster_for(a)[0] for a in data} == {static.UNCLASSIFIED}
    r = D.compute(data, C)
    assert len(set(r["assignments"].values())) == 1


def test_insufficient_data_gives_no_dynamic_link_and_keeps_only_the_static_cluster():
    data, _ = factor_series(7, {"SOL": 1.0, "DOGE": 1.0, "BTC": 1.0}, n=N)
    data["DOGE"] = data["DOGE"][-20:]                                            # too little history for any window
    r = D.compute(data, C)
    assert not any("DOGE" in (l["a"], l["b"]) for l in r["links"])
    assert r["assignments"]["DOGE"] != r["assignments"]["SOL"]
    info = D.pair_link(D._returns(data, C)["SOL"], D._returns(data, C)["DOGE"], C)
    assert info["linked"] is False and "insufficient" in info["reason"]


def test_a_correlation_that_flips_sign_between_windows_is_not_a_link():
    rnd = random.Random(8)
    a = [rnd.gauss(0, 0.01) for _ in range(1000)]
    b = [(-x if i < 600 else x) + rnd.gauss(0, 0.001) for i, x in enumerate(a)]  # anti-correlated long ago, correlated recently
    info = D.pair_link(a, b, D.Candidate("T", (100, 300, 900), 0.5, vol_scaled=False))
    assert info["linked"] is False and info["reason"] == "sign changes between windows"


def test_the_link_needs_every_window_to_clear_the_level():
    rnd = random.Random(9)
    a = [rnd.gauss(0, 0.01) for _ in range(1000)]
    b = [x + (rnd.gauss(0, 0.001) if i >= 700 else rnd.gauss(0, 0.05)) for i, x in enumerate(a)]   # tight recently, loose in the long window
    info = D.pair_link(a, b, D.Candidate("T", (100, 300, 900), 0.8, vol_scaled=False))
    assert info["windows"][100] > 0.9 and info["windows"][900] < 0.8 and info["linked"] is False and info["min_abs"] == min(abs(v) for v in info["windows"].values())


def test_candidates_are_named_parameter_sets_and_several_are_evaluated_side_by_side():
    assert len(D.CANDIDATES) >= 3 and len({c.link_level for c in D.CANDIDATES.values()}) >= 3
    assert all(k == c.version for k, c in D.CANDIDATES.items())
    data, _ = factor_series(10, {"BTC": 1.0, "SOL": 0.8, "DOGE": 0.6})
    results = {v: D.compute(data, c) for v, c in D.CANDIDATES.items()}
    assert all(r["version"] == v and r["params"]["link_level"] == D.CANDIDATES[v].link_level for v, r in results.items())
    # a stricter link level can only link fewer pairs (a subset of the looser candidate's links on the same data)
    l50 = {frozenset((l["a"], l["b"])) for l in results["CLUSTER-DYN-V1-C50"]["links"]}
    l80 = {frozenset((l["a"], l["b"])) for l in results["CLUSTER-DYN-V1-C80"]["links"]}
    assert l80 <= l50


def test_point_in_time_later_data_does_not_change_earlier_scaled_returns():
    rnd = random.Random(11)
    r = [rnd.gauss(0, 0.01) for _ in range(300)]
    short, long = D._scale(r[:200]), D._scale(r)
    assert all((math.isnan(x) and math.isnan(y)) or x == y for x, y in zip(short, long[:200]))


def test_betas_match_a_known_loading():
    rnd = random.Random(12)
    m = [rnd.gauss(0, 0.01) for _ in range(500)]
    a = [1.5 * x + rnd.gauss(0, 0.0005) for x in m]
    assert D.beta(a, m, 500) == pytest.approx(1.5, abs=0.05)
    data = {"BTC": closes(m), "SOL": closes(a)}
    f = D.compute(data, D.Candidate("T", (72, 168), 0.6, vol_scaled=False))["factors"]
    assert f["SOL"]["beta_btc"][168] == pytest.approx(1.5, abs=0.1) and f["BTC"]["beta_btc"][168] == pytest.approx(1.0, abs=1e-9)


def test_direction_aware_same_bet():
    data, _ = factor_series(13, {"BTC": 1.0, "SOL": 1.0})
    rnd = random.Random(14)
    inverse = closes([-(math.log(b / a)) + rnd.gauss(0, 0.001) for a, b in zip(data["SOL"], data["SOL"][1:])])
    data["FIL"] = inverse
    r = D.compute(data, C)
    assert D.same_bet(r, "BTC", "long", "SOL", "long") and not D.same_bet(r, "BTC", "long", "SOL", "short")
    assert r["assignments"]["FIL"] == r["assignments"]["SOL"]
    assert D.same_bet(r, "SOL", "long", "FIL", "short") and not D.same_bet(r, "SOL", "long", "FIL", "long")   # stably anti-correlated
    assert not D.same_bet(r, "BTC", "long", "UNKNOWN", "long")


def test_deterministic():
    data, _ = factor_series(15, {"BTC": 1.0, "SOL": 1.0, "AVAX": 1.0})
    assert D.compute(data, C) == D.compute(data, C)


# ---- isolation ------------------------------------------------------------------------------------------------------
def test_module_is_pure_and_cannot_reach_a_decision():
    src = inspect.getsource(D)
    for forbidden in ("sizing_v2", "ledger", "engine", "router", "portfolio", "sqlite3", "requests", "urllib", "open("):
        assert forbidden not in src.replace("sizing or", "").replace("sizing, the ledger or the engine", ""), forbidden


def test_authoritative_static_clustering_is_untouched():
    assert static.CLUSTER_METHOD_VERSION == "CLUSTER-STATIC-V1"
    assert static.cluster_for("SOL") == ("L1_PLATFORMS", True) and static.cluster_for("NOPE") == (static.UNCLASSIFIED, False)
    assert S.cluster_for is static.cluster_for
    before = static.cluster_table()
    data, _ = factor_series(16, {"BTC": 1.0, "SOL": 1.0, "DOGE": 1.0})
    D.compute(data, C)
    assert static.cluster_table() == before
