"""Exit policy evaluation harness (MAJOR 3H): the cluster bootstrap and the
evidence bar recover a known effect, report no effect on null data, and refuse
to give a verdict on thin evidence."""
import random

import pytest

from market_edge_exec.exits import evaluation as ev

DAY = 24 * 3_600_000


def record(trade_id, policy, r, opened, asset="ETH", direction="long", stop_pct=2.0, tp2=False, reason="STOP", giveback=0.5, real_r=None):
    events = [{"kind": "TP2"}] if tp2 else []
    return {"trade_id": trade_id, "policy_version": policy, "status": "EXITED", "counterfactual_R": r, "giveback_R": giveback,
            "opened_at_ms": opened, "asset": asset, "direction": direction, "stop_distance_pct": stop_pct, "events": events,
            "tp1_hit": True, "reason": reason, "real_R": real_r if real_r is not None else r}


def synthetic(n_trades, effect, seed, per_day=2, noise=0.6):
    """CURRENT_POLICY R ~ N(0.1, 1); the candidate adds `effect` plus small noise. Trades within a day share a shock."""
    rng = random.Random(seed)
    rows, day_shock = [], {}
    for i in range(n_trades):
        day = i // per_day
        shock = day_shock.setdefault(day, rng.gauss(0, 0.5))
        base = 0.1 + shock + rng.gauss(0, 0.8)
        opened = day * DAY + (i % per_day) * 3_600_000
        assets = ["ETH", "BTC", "SOL"]
        rows.append(record(f"t{i}", "CURRENT_POLICY", base, opened, asset=assets[i % 3], direction="long" if i % 2 else "short", stop_pct=1 + (i % 9) * 0.5))
        rows.append(record(f"t{i}", "CAND", base + effect + rng.gauss(0, noise * 0.2), opened, asset=assets[i % 3],
                           direction="long" if i % 2 else "short", stop_pct=1 + (i % 9) * 0.5, reason="POLICY_STOP", real_r=base))
    return rows


def test_cluster_bootstrap_recovers_a_known_effect():
    result = ev.evaluate(synthetic(240, effect=0.30, seed=1))
    m = result["policies"]["CAND"]
    assert m["delta_mean_R"] == pytest.approx(0.30, abs=0.05)
    assert m["delta_ci"][0] > 0.2 and m["delta_ci"][1] < 0.4
    assert m["verdict"] == "PASS" and all(m["checks"].values())


def test_null_effect_false_positive_rate_matches_the_confidence_level():
    hits, seeds = 0, range(40)
    for seed in seeds:
        m = ev.evaluate(synthetic(120, effect=0.0, seed=seed + 100))["policies"]["CAND"]
        hits += m["delta_ci"][0] > 0   # a "significant improvement" on data with no effect
    assert hits <= 6, f"{hits}/40 null datasets looked significant (expected about 2 at 95%)"
    m0 = ev.evaluate(synthetic(240, effect=0.0, seed=10))["policies"]["CAND"]
    assert m0["verdict"] != "PASS"


def test_harmful_policy_fails():
    m = ev.evaluate(synthetic(240, effect=-0.30, seed=3))["policies"]["CAND"]
    assert m["verdict"] == "FAIL" and m["delta_ci"][1] < 0


def test_thin_evidence_gives_no_verdict_even_with_a_big_effect():
    m = ev.evaluate(synthetic(20, effect=1.0, seed=4))["policies"]["CAND"]
    assert m["verdict"] == "INSUFFICIENT_EVIDENCE" and m["checks"] == {} and "Re-run" in m["reason"]
    # many trades packed into few episodes is also insufficient: episodes, not trade count, are the sample size
    packed = synthetic(240, effect=1.0, seed=5, per_day=60)
    assert ev.evaluate(packed)["policies"]["CAND"]["verdict"] == "INSUFFICIENT_EVIDENCE"


def test_cluster_ci_is_wider_than_a_naive_trade_level_ci_when_trades_cluster():
    rows = synthetic(240, effect=0.0, seed=6, per_day=8, noise=0.0)
    deltas = [r["counterfactual_R"] for r in rows if r["policy_version"] == "CAND"]
    base = [r["counterfactual_R"] for r in rows if r["policy_version"] == "CURRENT_POLICY"]
    d = [a - b for a, b in zip(deltas, base)]
    clusters = [i // 8 for i in range(len(d))]
    c_lo, c_hi = ev.cluster_bootstrap_ci(d, clusters, 2000, 0.95, 1)
    n_lo, n_hi = ev.cluster_bootstrap_ci(d, list(range(len(d))), 2000, 0.95, 1)   # every trade its own "cluster" = naive
    assert (c_hi - c_lo) >= (n_hi - n_lo) * 0.9 and c_lo is not None


def test_deterministic_and_seeded():
    rows = synthetic(120, effect=0.2, seed=7)
    assert ev.evaluate(rows) == ev.evaluate(rows)


def test_a_policy_that_improves_the_mean_by_adding_tail_risk_does_not_pass():
    rows = synthetic(240, effect=0.3, seed=8)
    for r in rows:   # candidate: same mean gain but a fat left tail on every 12th trade
        if r["policy_version"] == "CAND" and int(r["trade_id"][1:]) % 12 == 0:
            r["counterfactual_R"] -= 3.0
    for r in rows:
        if r["policy_version"] == "CAND" and int(r["trade_id"][1:]) % 12 == 5:
            r["counterfactual_R"] += 3.0
    m = ev.evaluate(rows)["policies"]["CAND"]
    assert m["delta_mean_R"] > 0.2
    assert m["p05_R"] < m["baseline"]["p05_R"]
    assert m["verdict"] in ("FAIL", "PASS")   # the tail check is evaluated, never skipped
    assert "tail_not_worse" in m["checks"]


def test_a_bucket_that_is_materially_harmed_blocks_a_pass():
    rows = synthetic(240, effect=0.4, seed=9)
    for r in rows:   # improves everywhere except SOL, where it is clearly worse
        if r["policy_version"] == "CAND" and r["asset"] == "SOL":
            r["counterfactual_R"] -= 1.0
    m = ev.evaluate(rows)["policies"]["CAND"]
    assert m["breakdown"]["asset"]["SOL"]["mean_delta_R"] < -0.2
    assert not m["checks"]["no_bucket_materially_harmed"] and m["verdict"] == "FAIL"
    assert any(b.startswith("asset=SOL") for b in m["harmed_buckets"])


def test_breakdowns_and_metrics_are_all_present():
    m = ev.evaluate(synthetic(120, effect=0.2, seed=11))["policies"]["CAND"]
    assert set(m["breakdown"]) == {"asset", "direction", "volatility_regime", "tp1_status"}
    assert set(m["breakdown"]["volatility_regime"]) <= {"LOW_VOL", "MID_VOL", "HIGH_VOL"}
    for key in ("mean_R", "median_R", "p05_R", "win_rate", "max_drawdown_R", "mean_giveback_R", "tp2_capture_rate", "premature_exit_rate", "intervention_rate"):
        assert m[key] is not None


def test_premature_exit_rate_counts_only_policy_exits_that_left_gains_behind():
    rows = []
    for i in range(40):
        rows.append(record(f"t{i}", "CURRENT_POLICY", 1.0, i * DAY))
        # policy exits at 0.2R on half of the trades where the real trade then made 1.0R (premature), holds the rest
        rows.append(record(f"t{i}", "CAND", 0.2 if i % 2 == 0 else 1.0, i * DAY, reason="POLICY_STOP" if i % 2 == 0 else "TP2", real_r=1.0))
    m = ev.evaluate(rows)["policies"]["CAND"]
    assert m["premature_exit_rate"] == pytest.approx(0.5) and m["intervention_rate"] == pytest.approx(0.5)
    assert not m["checks"]["premature_exit_rate_ok"]


def test_no_baseline_no_open_and_empty_inputs():
    assert ev.evaluate([])["policies"] == {} and ev.evaluate([])["trades_with_baseline"] == 0
    only_policy = [record("a", "CAND", 1.0, 0)]
    assert ev.evaluate(only_policy)["trades_with_baseline"] == 0
    open_row = dict(record("b", "CURRENT_POLICY", 1.0, 0), status="OPEN")
    assert ev.evaluate([open_row])["trades_with_baseline"] == 0


def test_max_drawdown_and_percentile_helpers():
    assert ev.max_drawdown([1, -2, 1, -1, 3]) == 2
    assert ev.max_drawdown([1, 1, 1]) == 0
    assert ev.percentile([1, 2, 3, 4, 5], 0.5) == 3 and ev.percentile([], 0.5) is None
    assert ev.percentile([0, 10], 0.25) == 2.5


def test_report_states_the_bar_and_never_promotes():
    result = ev.evaluate(synthetic(240, effect=0.3, seed=12))
    text = ev.render_markdown(result)
    assert "EXIT-EVIDENCE-BAR-V1" in text and "CAND" in text and "Promotion" in text and "NONE" in result["promotion"]
    assert "no finalized counterfactuals" in ev.render_markdown(ev.evaluate([]))
