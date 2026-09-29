"""Risk Sizing V2: the mathematical invariants the policy promises.

Each monotonicity test sweeps one input while holding the rest fixed and
asserts the final size never increases; each cap test asserts the cap is never
exceeded under many combinations."""
import itertools
import math

import pytest

from market_edge_exec.risk import sizing_v2 as S
from market_edge_exec.risk.clusters import UNCLASSIFIED, cluster_for

NOW = 1_790_000_000_000
DAY = S.DAY_MS
E = 10_000.0
# Sizing equity: wallet equity net of the new trade's worst-case entry cost
# (0.05 x (0.05% fee + 0.25% slippage bound) = 0.015%), so caps still hold after entry.
ES = E * (1 - 0.05 * 0.003)


def closes(n=260, amp=0.01, calm_tail=None):
    """Daily closes with a controllable recent volatility regime."""
    out, p = [], 100.0
    for i in range(n):
        a = calm_tail if calm_tail is not None and i >= n - 25 else amp
        p *= 1 + a * math.sin(i * 1.7)
        out.append(p)
    return out


def vol(series=None):
    return S.VolInput("HYPERLIQUID", "1d", series or closes(), NOW - NOW % DAY - DAY)


def depth(size_per_level=5.0, spread=0.0002, levels=20, step=0.0005):
    mid = 100.0
    bids = [[mid * (1 - spread / 2 - i * step), size_per_level] for i in range(levels)]
    asks = [[mid * (1 + spread / 2 + i * step), size_per_level] for i in range(levels)]
    return S.DepthInput("HYPERLIQUID", bids, asks, NOW - 1_000)


def req(stop_pct=0.02, direction="long", equity=E, peak=None, open_positions=(), dep="none", vol_input="default",
        asset="BTC", venue=None, lev=1.0, require_depth=None):
    entry = 100.0
    stop = entry * (1 - stop_pct) if direction == "long" else entry * (1 + stop_pct)
    d = None if dep == "none" else dep
    return S.SizingRequest(asset, direction, entry, stop, equity, peak if peak is not None else equity, list(open_positions), NOW,
                           vol=vol() if vol_input == "default" else vol_input, depth=d, venue=venue or S.VenueRules(),
                           requested_leverage=lev, require_depth=(d is not None) if require_depth is None else require_depth)


def notional(r, policy=S.DEFAULT_POLICY):
    d = S.size(r, policy)
    return d.record["final_notional"] if d.approved else 0.0


# ---- the worked examples ------------------------------------------------------
@pytest.mark.parametrize("stop_pct,expected,binding", [
    (0.01, 0.05 * ES, "POSITION_NOTIONAL_CAP"), (0.05, 0.05 * ES, "POSITION_NOTIONAL_CAP"),
    (0.10, None, "RISK_BUDGET"), (0.20, None, "RISK_BUDGET"), (0.30, None, "RISK_BUDGET")])
def test_10k_equity_examples_tight_stops_hit_the_5pct_ceiling_wide_stops_shrink(stop_pct, expected, binding):
    d = S.size(req(stop_pct))
    r = d.record
    assert d.approved and r["sizing_binding_constraint"] == binding
    assert r["final_notional"] <= 500.0 + 1e-9                       # never above 5% of $10k
    if expected:
        assert r["final_notional"] == pytest.approx(expected)
        assert r["planned_loss_dollars"] < 50.0                       # under-risked, and kept that way
    else:
        assert r["planned_loss_dollars"] == pytest.approx(0.005 * ES, rel=1e-6)   # 0.50% of (sizing) equity
        assert r["planned_loss_dollars"] <= 50.0
        assert r["final_notional"] == pytest.approx(0.005 * ES / r["effective_loss_fraction"], rel=1e-6)


def test_five_percent_is_a_ceiling_not_a_target():
    tight = S.size(req(0.01)).record
    assert tight["final_notional"] == pytest.approx(0.05 * ES) and tight["final_notional"] <= 500.0
    assert tight["planned_loss_pct_equity"] == pytest.approx(tight["final_notional"] * tight["effective_loss_fraction"] / ES)
    assert tight["planned_loss_pct_equity"] < 0.005                  # NOT enlarged to consume 0.50%
    wide = S.size(req(0.30)).record
    assert wide["final_notional"] < 200                              # NOT enlarged to reach 5%


# ---- monotonicity -------------------------------------------------------------
def nonincreasing(values):
    return all(b <= a + 1e-9 for a, b in zip(values, values[1:]))


def test_wider_stop_never_increases_size():
    assert nonincreasing([notional(req(s)) for s in (0.002, 0.005, 0.01, 0.03, 0.06, 0.1, 0.2, 0.4, 0.8)])


def test_higher_execution_costs_never_increase_size():
    sizes = [notional(req(0.1), S.SizingPolicy(execution_buffer_floor_pct=f)) for f in (0.0, 0.0025, 0.005, 0.01, 0.03)]
    assert nonincreasing(sizes) and sizes[0] > sizes[-1]
    sizes = [notional(req(0.1), S.SizingPolicy(fee_pct=f)) for f in (0.0, 0.0005, 0.002, 0.005)]
    assert nonincreasing(sizes)


def test_higher_volatility_never_increases_size_and_low_volatility_never_upsizes():
    sizes, mults = [], []
    for tail in (0.001, 0.005, 0.01, 0.02, 0.04, 0.08):
        d = S.size(req(0.1, vol_input=vol(closes(calm_tail=tail))))
        sizes.append(d.record["final_notional"]); mults.append(d.record["vol_multiplier"])
    assert nonincreasing(sizes)
    assert all(S.DEFAULT_POLICY.vol_mult_min <= m <= 1.0 for m in mults)
    calm = S.size(req(0.1, vol_input=vol(closes(calm_tail=0.0001)))).record
    assert calm["vol_multiplier"] == 1.0 and calm["effective_risk_pct"] <= 0.005 + 1e-15
    assert calm["planned_loss_dollars"] <= 50.0 + 1e-9
    with pytest.raises(ValueError):
        S.SizingPolicy(vol_mult_max=1.5)


def test_larger_drawdown_never_increases_size_and_pauses_at_15pct():
    sizes = []
    for dd in (0.0, 0.03, 0.05, 0.07, 0.10, 0.12, 0.149, 0.15, 0.3):
        d = S.size(req(0.1, equity=E * (1 - dd), peak=E))
        sizes.append(d.record["final_notional"] if d.approved else 0.0)
        if dd >= 0.15:
            assert (d.approved, d.reason) == (False, "DRAWDOWN_RISK_PAUSE")
    assert nonincreasing(sizes)
    assert S.drawdown_multiplier(0.04, S.DEFAULT_POLICY) == 1.0 and S.drawdown_multiplier(0.06, S.DEFAULT_POLICY) == 0.75
    assert S.drawdown_multiplier(0.11, S.DEFAULT_POLICY) == 0.5 and S.drawdown_multiplier(0.15, S.DEFAULT_POLICY) is None


def open_pos(asset, planned, notional_=400.0):
    return S.OpenRisk(asset, cluster_for(asset)[0], notional_, notional_, planned)


def test_smaller_cluster_or_portfolio_capacity_never_increases_size():
    cl = [notional(req(0.02, open_positions=[open_pos("ETH", p, 100)])) for p in (0, 20, 50, 80, 99, 100)]
    assert nonincreasing(cl) and cl[-1] == 0.0                       # ETH shares BTC's MAJORS cluster: 1% = $100
    pf = [notional(req(0.1, asset="SOL", open_positions=[open_pos("DOGE", p, 100), open_pos("UNI", p, 100)]))
          for p in (0, 30, 60, 75, 90, 100)]
    assert nonincreasing(pf) and pf[-1] == 0.0                       # $200 = 2% of equity is full
    gross = [notional(req(0.02, asset="SOL", open_positions=[open_pos("DOGE", 0, n)])) for n in (0, 1000, 1600, 1800, 1999, 2000)]
    assert nonincreasing(gross) and gross[-1] == 0.0


def test_worse_liquidity_never_increases_size_and_bounds_expected_slippage():
    sizes = [notional(req(0.02, dep=depth(size_per_level=s))) for s in (50.0, 5.0, 1.0, 0.5, 0.2, 0.05)]
    assert nonincreasing(sizes)
    thin = S.size(req(0.02, dep=depth(size_per_level=0.5)))
    assert thin.record["sizing_binding_constraint"] == "LIQUIDITY_CAP"
    assert thin.record["expected_entry_slippage"] <= 0.0025 + 1e-12
    wide = S.size(req(0.02, dep=depth(spread=0.01)))                # mid-to-ask already 50 bps
    assert (wide.approved, wide.reason) == (False, "EXCESS_EXPECTED_SLIPPAGE")


def test_leverage_changes_margin_never_planned_loss():
    # MAX_LEVERAGE is 1x in this policy version; any request is clamped, and the
    # planned price loss depends only on notional and stop, not leverage.
    a, b = S.size(req(0.1, lev=1.0)).record, S.size(req(0.1, lev=10.0)).record
    assert a["leverage"] == b["leverage"] == 1.0
    assert a["planned_loss_dollars"] == b["planned_loss_dollars"] and a["final_notional"] == b["final_notional"]
    with pytest.raises(ValueError):
        S.SizingPolicy(max_leverage=3.0)


# ---- hard caps under many combinations ------------------------------------------
def test_caps_are_never_exceeded_across_a_grid():
    assets = ["BTC", "ETH", "SOL", "AVAX", "DOGE", "PEPE", "UNI", "ZZZ", "QQQ"]
    for stop_pct, n_open, planned, notion, asset in itertools.product((0.003, 0.02, 0.1, 0.35), (0, 1, 2, 3, 4),
                                                                      (0, 10, 40), (100, 450, 500), assets):
        opens = [open_pos(a, planned, notion) for a in assets[:n_open]]
        d = S.size(req(stop_pct, asset=asset, open_positions=opens))
        if n_open >= 4:
            assert (d.approved, d.reason) == (False, "MAX_POSITIONS")
        if not d.approved:
            continue
        r = d.record
        cluster = cluster_for(asset)[0]
        assert r["final_notional"] <= 0.05 * E + 1e-9
        assert r["planned_loss_dollars"] <= 0.005 * E + 1e-9
        assert sum(p.notional for p in opens) + r["final_notional"] <= 0.20 * E + 1e-9
        assert sum(p.planned_loss for p in opens) + r["planned_loss_dollars"] <= 0.02 * E + 1e-9
        assert sum(p.planned_loss for p in opens if p.cluster_id == cluster) + r["planned_loss_dollars"] <= 0.01 * E + 1e-9


def test_unclassified_assets_share_one_conservative_cluster():
    assert cluster_for("ZZZ") == (UNCLASSIFIED, False) and cluster_for("QQQ") == (UNCLASSIFIED, False)
    assert cluster_for("ETH-PERP") == ("MAJORS", True)
    d = S.size(req(0.02, asset="QQQ", open_positions=[open_pos("ZZZ", 100.0, 100)]))
    assert (d.approved, d.reason) == (False, "CLUSTER_PLANNED_RISK_CAP")
    assert d.record["cluster_assignment"] == "CONSERVATIVE_FALLBACK_SHARED_UNCLASSIFIED"


# ---- rounding, minimum order, fail-closed -------------------------------------
def test_rounding_never_increases_quantity_above_the_safe_amount():
    for decimals in (0, 1, 2, 3, 5, 8):
        for stop_pct in (0.013, 0.071, 0.19):
            d = S.size(req(stop_pct, venue=S.VenueRules(min_notional=0.0, qty_decimals=decimals)))
            if not d.approved:
                continue
            r = d.record
            safe = min(r["raw_risk_notional"], r["position_notional_cap"])
            assert d.quantity * 100.0 <= safe + 1e-9
            assert r["planned_loss_dollars"] <= r["risk_budget_dollars"] + 1e-9


def test_minimum_order_larger_than_safe_size_is_rejected_not_upsized():
    d = S.size(req(0.3, equity=500.0))                     # safe notional ~ $8 < $10 venue minimum
    assert (d.approved, d.reason) == (False, "MIN_ORDER_EXCEEDS_SAFE_SIZE") and d.quantity == 0
    d = S.size(req(0.02, venue=S.VenueRules(min_notional=10.0, qty_decimals=0)))  # 4.99925 units -> 4 whole units, never 5
    assert d.approved and d.quantity == 4
    d = S.size(req(0.02, equity=150.0, venue=S.VenueRules(min_notional=10.0, qty_decimals=0)))  # $7.50 cap -> 0 units
    assert (d.approved, d.reason) == (False, "MIN_ORDER_EXCEEDS_SAFE_SIZE")


@pytest.mark.parametrize("mutate,reason", [
    (lambda r: setattr(r, "equity", 0.0), "NO_EQUITY"),
    (lambda r: setattr(r, "equity", float("nan")), "NO_EQUITY"),
    (lambda r: setattr(r, "stop_price", 101.0), "INVALID_STOP"),
    (lambda r: setattr(r, "stop_price", None), "INVALID_STOP"),
    (lambda r: setattr(r, "vol", None), "NO_VOLATILITY_STATE"),
    (lambda r: setattr(r, "vol", S.VolInput("BINANCE", "1d", closes(), NOW - DAY)), "NO_VOLATILITY_STATE"),
    (lambda r: setattr(r, "vol", S.VolInput("HYPERLIQUID", "1d", closes()[:100], NOW - DAY)), "NO_VOLATILITY_STATE"),
    (lambda r: setattr(r, "vol", S.VolInput("HYPERLIQUID", "1d", closes(), NOW - 5 * DAY)), "NO_VOLATILITY_STATE"),
    (lambda r: setattr(r, "vol", S.VolInput("HYPERLIQUID", "1d", [100.0] * 260, NOW - DAY)), "NO_VOLATILITY_STATE"),
    (lambda r: (setattr(r, "depth", None), setattr(r, "require_depth", True)), "NO_LIQUIDITY_STATE"),
    (lambda r: (setattr(r, "depth", S.DepthInput("HYPERLIQUID", [[99.9, 1]], [[100.1, 1]], NOW - 120_000)), setattr(r, "require_depth", True)), "NO_LIQUIDITY_STATE"),
    (lambda r: (setattr(r, "depth", S.DepthInput("HYPERLIQUID", [[100.2, 1]], [[100.1, 1]], NOW)), setattr(r, "require_depth", True)), "NO_LIQUIDITY_STATE"),
])
def test_missing_or_invalid_safety_inputs_fail_closed(mutate, reason):
    r = req(0.05, dep=depth())
    mutate(r)
    d = S.size(r)
    assert (d.approved, d.reason, d.quantity) == (False, reason, 0.0)


def test_kelly_is_disabled_and_cannot_be_enabled():
    assert S.kelly_fraction() is None
    with pytest.raises(ValueError, match="KELLY_DISABLED"):
        S.SizingPolicy(kelly_enabled=True)
    assert S.size(req(0.1)).record["kelly"] == "OFF"


def test_operator_settings_can_only_tighten_the_policy():
    p = S.DEFAULT_POLICY.tightened(max_risk_pct=0.01, max_gross_pct=0.5, max_positions=10)   # looser asks are ignored
    assert (p.base_risk_pct, p.max_portfolio_gross_pct, p.max_positions) == (0.005, 0.20, 4)
    p = S.DEFAULT_POLICY.tightened(max_risk_pct=0.0025, max_gross_pct=0.1, max_positions=2)
    assert (p.base_risk_pct, p.max_portfolio_gross_pct, p.max_positions) == (0.0025, 0.1, 2)


def test_record_carries_every_decision_time_field():
    r = S.size(req(0.1, dep=depth())).record
    for key in ("wallet_equity", "base_risk_pct", "effective_risk_pct", "drawdown_pct", "drawdown_multiplier", "realised_vol",
                "vol_reference", "vol_multiplier", "entry_price", "stop_price", "stop_distance_pct", "expected_entry_fee",
                "expected_exit_fee", "expected_entry_slippage", "stress_exit_slippage", "execution_buffer_pct",
                "risk_budget_dollars", "raw_risk_notional", "position_notional_cap", "liquidity_cap_notional",
                "cluster_cap_notional", "portfolio_cap_notional", "margin_cap_notional", "final_notional",
                "final_notional_pct_equity", "planned_loss_dollars", "planned_loss_pct_equity", "leverage", "margin_required",
                "cluster_id", "cluster_method_version", "sizing_rule_version", "sizing_binding_constraint",
                "sizing_reduction_reason", "timestamp", "market_data_provenance"):
        assert key in r, key
    assert r["sizing_rule_version"] == "RISK-SIZING-V2.0" and r["cluster_method_version"] == "CLUSTER-STATIC-V1"


def test_current_risk_after_tp1_uses_the_breakeven_stop():
    trade = {"direction": "long", "entry_fill": 100.0, "stop": 95.0, "remaining_qty": 4.0, "tp1_hit": False, "asset": "BTC", "mark_price": 101.0}
    before = S.current_risk(trade, {"execution_buffer_pct": 0.0025, "cluster_id": "MAJORS"})
    assert before["current_planned_loss"] == pytest.approx(4 * 5 + 4 * 100 * 0.0025)
    trade.update(tp1_hit=True, remaining_qty=2.0)
    after = S.current_risk(trade, {"execution_buffer_pct": 0.0025, "cluster_id": "MAJORS"})
    assert after["active_stop"] == 100.0 and after["current_planned_loss"] == pytest.approx(2 * 100 * 0.0025)
