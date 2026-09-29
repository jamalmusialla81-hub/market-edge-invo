"""Risk Sizing V2 -- planned-loss position sizing (pure functions, no I/O).

Each trade gets a planned-LOSS budget; notional follows from the stop
distance plus execution costs, and is then cut by every hard cap:

    r_eff   = BASE_RISK_PCT * m_vol * m_DD          (m_vol, m_DD <= 1: can only reduce)
    B       = E * r_eff
    L       = d_stop + max(EXECUTION_BUFFER_FLOOR_PCT, fees + entry slip + stress exit slip)
    N_risk  = B / L
    N_final = MIN(N_risk, 5% E, liquidity, cluster room, portfolio room, gross room, margin)
    qty     = floor(N_final / entry, venue step)       (never rounded up)

5% of equity is a CEILING, never a target: a trade capped at 5% keeps its
smaller planned loss; nothing is ever enlarged to use a budget. Any missing,
stale or invalid safety input fails closed with a machine-readable reason.

The parameters below are INITIAL ENGINEERING POLICY, versioned in
SIZING_RULE_VERSION -- not claimed to be empirical optima. They are never
tuned against research data here.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, replace
from statistics import median
from typing import Optional

from market_edge_exec.paper import lifecycle
from market_edge_exec.risk.clusters import CLUSTER_METHOD_VERSION, cluster_for

SIZING_RULE_VERSION = "RISK-SIZING-V2.0"
MODE_SHADOW, MODE_PAPER = "SHADOW", "PAPER"
DAY_MS = 86_400_000

# Machine-readable outcomes.
INVALID_STOP = "INVALID_STOP"
NO_EQUITY = "NO_EQUITY"
STALE_MARKET_DATA = "STALE_MARKET_DATA"
NO_VOLATILITY_STATE = "NO_VOLATILITY_STATE"
NO_LIQUIDITY_STATE = "NO_LIQUIDITY_STATE"
DRAWDOWN_RISK_PAUSE = "DRAWDOWN_RISK_PAUSE"
MAX_POSITIONS = "MAX_POSITIONS"
POSITION_NOTIONAL_CAP = "POSITION_NOTIONAL_CAP"
PORTFOLIO_GROSS_CAP = "PORTFOLIO_GROSS_CAP"
PORTFOLIO_PLANNED_RISK_CAP = "PORTFOLIO_PLANNED_RISK_CAP"
CLUSTER_PLANNED_RISK_CAP = "CLUSTER_PLANNED_RISK_CAP"
LIQUIDITY_CAP = "LIQUIDITY_CAP"
EXCESS_EXPECTED_SLIPPAGE = "EXCESS_EXPECTED_SLIPPAGE"
MARGIN_CAP = "MARGIN_CAP"
MIN_ORDER_EXCEEDS_SAFE_SIZE = "MIN_ORDER_EXCEEDS_SAFE_SIZE"
INVALID_RISK_CALCULATION = "INVALID_RISK_CALCULATION"
RISK_BUDGET = "RISK_BUDGET"   # binding constraint when nothing else cut the size


@dataclass(frozen=True)
class SizingPolicy:
    base_risk_pct: float = 0.005
    max_position_notional_pct: float = 0.05
    max_portfolio_gross_pct: float = 0.20
    max_open_planned_risk_pct: float = 0.02
    max_cluster_planned_risk_pct: float = 0.01
    max_positions: int = 4
    max_leverage: float = 1.0
    rv_lookback_days: int = 20
    vol_reference_lookback_days: int = 180
    vol_mult_min: float = 0.50
    vol_mult_max: float = 1.00
    execution_buffer_floor_pct: float = 0.0025
    max_expected_entry_slippage_bps: float = 25.0
    kelly_enabled: bool = False
    # Drawdown throttle: (drawdown below, multiplier); at or above dd_pause_pct new entries pause.
    dd_steps: tuple = ((0.05, 1.00), (0.10, 0.75), (0.15, 0.50))
    dd_pause_pct: float = 0.15
    fee_pct: float = lifecycle.FEE_PCT                   # per side
    default_slippage_pct: float = lifecycle.SLIPPAGE_PCT  # per side, when no depth is available
    stress_exit_slippage_mult: float = 2.0               # stops fill worse than entries
    gap_stress_pct: float = 0.0005                       # gap/latency allowance on the exit
    vol_venue: str = "HYPERLIQUID"
    vol_interval: str = "1d"
    max_vol_bar_age_ms: int = 2 * DAY_MS                 # last completed daily bar must be this recent
    max_depth_age_ms: int = 30_000
    version: str = SIZING_RULE_VERSION

    def __post_init__(self):
        if self.kelly_enabled:
            raise ValueError("KELLY_DISABLED_BY_POLICY: no Kelly sizing without separate forward evidence")
        if not self.vol_mult_max <= 1.0:
            raise ValueError("vol_mult_max > 1 would let low volatility upsize risk")
        if self.max_leverage > 1.0:
            raise ValueError("MAX_LEVERAGE above 1x is not enabled in this policy version")

    def tightened(self, *, max_risk_pct: Optional[float] = None, max_gross_pct: Optional[float] = None,
                  max_positions: Optional[int] = None) -> "SizingPolicy":
        """Operator settings may only tighten the hard policy, never loosen it."""
        return replace(self,
                       base_risk_pct=min(self.base_risk_pct, max_risk_pct) if max_risk_pct else self.base_risk_pct,
                       max_portfolio_gross_pct=min(self.max_portfolio_gross_pct, max_gross_pct) if max_gross_pct else self.max_portfolio_gross_pct,
                       max_positions=min(self.max_positions, max_positions) if max_positions else self.max_positions)

    def public(self) -> dict:
        d = asdict(self)
        d["dd_steps"] = [list(s) for s in self.dd_steps]
        return d


DEFAULT_POLICY = SizingPolicy()


@dataclass
class OpenRisk:
    """Current (not original) risk of one open position."""
    asset: str
    cluster_id: str
    notional: float
    margin: float
    planned_loss: float


@dataclass
class VolInput:
    venue: str
    interval: str
    closes: list
    last_bar_open_ms: int


@dataclass
class DepthInput:
    venue: str
    bids: list      # [[px, sz], ...] best first
    asks: list
    at_ms: int


@dataclass
class VenueRules:
    min_notional: float = 10.0     # Hyperliquid minimum order value
    qty_decimals: int = 8


@dataclass
class SizingRequest:
    asset: str
    direction: str
    entry_price: float
    stop_price: float
    equity: float
    peak_equity: Optional[float]
    open_positions: list
    now_ms: int
    vol: Optional[VolInput] = None
    depth: Optional[DepthInput] = None
    venue: VenueRules = field(default_factory=VenueRules)
    requested_leverage: float = 1.0
    require_depth: bool = True
    provenance: dict = field(default_factory=dict)


@dataclass
class SizingDecision:
    approved: bool
    reason: Optional[str]
    quantity: float
    record: dict


def _finite(*xs) -> bool:
    return all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in xs)


# ---- inputs ------------------------------------------------------------------
def drawdown_multiplier(dd: float, policy: SizingPolicy) -> Optional[float]:
    """None means: new entries paused (DRAWDOWN_RISK_PAUSE)."""
    if dd >= policy.dd_pause_pct:
        return None
    for below, mult in policy.dd_steps:
        if dd < below:
            return mult
    return None


def volatility_state(vol: Optional[VolInput], now_ms: int, policy: SizingPolicy) -> tuple[Optional[dict], Optional[str]]:
    """Point-in-time realised volatility (annualised stdev of daily log
    returns over RV_LOOKBACK_DAYS) and its asset-relative reference: the
    median of that RV over the trailing VOL_REFERENCE_LOOKBACK_DAYS. Same
    venue only; never substituted."""
    if vol is None:
        return None, "missing"
    if vol.venue != policy.vol_venue or vol.interval != policy.vol_interval:
        return None, f"wrong source {vol.venue} {vol.interval}"
    closes = [c for c in (vol.closes or []) if _finite(c) and c > 0]
    n, ref_n = policy.rv_lookback_days, policy.vol_reference_lookback_days
    if len(closes) != len(vol.closes or []) or len(closes) < n + ref_n + 1:
        return None, f"need {n + ref_n + 1} valid daily closes, have {len(closes)}"
    if not _finite(vol.last_bar_open_ms) or now_ms - (vol.last_bar_open_ms + DAY_MS) > policy.max_vol_bar_age_ms:
        return None, "stale daily candles"
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:])]

    def rv(end: int) -> float:
        window = rets[end - n:end]
        m = sum(window) / n
        return math.sqrt(sum((r - m) ** 2 for r in window) / (n - 1)) * math.sqrt(365)
    current = rv(len(rets))
    reference = median(rv(end) for end in range(len(rets) - ref_n + 1, len(rets) + 1))
    if not current > 0 or not reference > 0:
        return None, "zero volatility"
    mult = min(policy.vol_mult_max, max(policy.vol_mult_min, reference / current))
    return {"realised_vol": current, "vol_reference": reference, "vol_multiplier": mult,
            "vol_bars": len(closes), "vol_last_bar_open_ms": vol.last_bar_open_ms}, None


def _levels(side: list) -> list[tuple[float, float]]:
    out = []
    for lvl in side or []:
        px, sz = (lvl[0], lvl[1]) if isinstance(lvl, (list, tuple)) else (lvl.get("px"), lvl.get("sz"))
        px, sz = float(px), float(sz)
        if not (_finite(px, sz) and px > 0 and sz > 0):
            raise ValueError("bad depth level")
        out.append((px, sz))
    return out


def liquidity_state(depth: Optional[DepthInput], direction: str, now_ms: int, policy: SizingPolicy) -> tuple[Optional[dict], Optional[str]]:
    """The largest order whose average fill stays within
    MAX_EXPECTED_ENTRY_SLIPPAGE_BPS of the mid, walking the real book."""
    if depth is None:
        return None, "missing"
    if depth.venue != policy.vol_venue:
        return None, f"wrong venue {depth.venue}"
    if not _finite(depth.at_ms) or now_ms - depth.at_ms > policy.max_depth_age_ms or depth.at_ms > now_ms + 5_000:
        return None, "stale depth"
    try:
        bids, asks = _levels(depth.bids), _levels(depth.asks)
    except (TypeError, ValueError):
        return None, "invalid depth"
    if not bids or not asks or bids[0][0] >= asks[0][0]:
        return None, "invalid depth"
    mid = (bids[0][0] + asks[0][0]) / 2
    book = asks if direction == "long" else bids
    bound = policy.max_expected_entry_slippage_bps / 10_000
    cap_notional, cost, qty = 0.0, 0.0, 0.0     # cost = sum px*sz consumed
    for px, sz in book:
        # average px after adding x units of this level must stay within the bound
        limit = mid * (1 + bound) if direction == "long" else mid * (1 - bound)
        adverse = (px - limit) if direction == "long" else (limit - px)
        if adverse <= 0:
            cost, qty = cost + px * sz, qty + sz
            continue
        # solve (cost + px*x) / (qty + x) = limit for x
        x = (limit * qty - cost) / adverse if direction == "long" else (cost - limit * qty) / adverse
        x = max(0.0, min(sz, x))
        cost, qty = cost + px * x, qty + x
        break
    cap_notional = qty * mid

    def slippage_at(notional: float) -> float:
        if notional <= 0:
            return 0.0
        need, c, q = notional / mid, 0.0, 0.0
        for px, sz in book:
            take = min(sz, need - q)
            c, q = c + px * take, q + take
            if q >= need - 1e-15:
                break
        if q < need - 1e-12:
            return math.inf
        return abs(c / q / mid - 1)
    return {"mid": mid, "liquidity_cap_notional": cap_notional, "slippage_at": slippage_at,
            "depth_at_ms": depth.at_ms, "book_levels": len(book)}, None


# ---- the sizer ---------------------------------------------------------------
def size(req: SizingRequest, policy: SizingPolicy = DEFAULT_POLICY) -> SizingDecision:
    rec: dict = {"sizing_rule_version": policy.version, "cluster_method_version": CLUSTER_METHOD_VERSION,
                 "timestamp": req.now_ms, "asset": req.asset, "direction": req.direction,
                 "wallet_equity": req.equity, "base_risk_pct": policy.base_risk_pct, "kelly": "OFF",
                 "entry_price": req.entry_price, "stop_price": req.stop_price, "market_data_provenance": dict(req.provenance),
                 "policy": policy.public()}
    cluster_id, reliable = cluster_for(req.asset)
    rec.update({"cluster_id": cluster_id, "cluster_assignment": "STATIC" if reliable else "CONSERVATIVE_FALLBACK_SHARED_UNCLASSIFIED"})

    def reject(reason: str, detail: Optional[str] = None) -> SizingDecision:
        rec.update({"approved": False, "rejection_reason": reason, "rejection_detail": detail, "final_notional": 0.0,
                    "final_quantity": 0.0, "planned_loss_dollars": 0.0, "planned_loss_pct_equity": 0.0,
                    "sizing_binding_constraint": reason})
        return SizingDecision(False, reason, 0.0, rec)

    if not _finite(req.equity) or req.equity <= 0:
        return reject(NO_EQUITY)
    # Size against equity already net of this trade's own worst-case entry
    # cost (fee + the slippage bound on a full 5% position): the new trade's
    # fee and slippage lower equity the moment it opens, and the caps must
    # still hold after that, not just before.
    E = req.equity * (1 - policy.max_position_notional_pct * (policy.fee_pct + policy.max_expected_entry_slippage_bps / 10_000))
    rec["sizing_equity"] = E
    entry, stop = req.entry_price, req.stop_price
    if req.direction not in ("long", "short") or not _finite(entry, stop) or entry <= 0 or stop <= 0:
        return reject(INVALID_STOP, "missing or non-finite entry/stop/direction")
    if (req.direction == "long" and not stop < entry) or (req.direction == "short" and not stop > entry):
        return reject(INVALID_STOP, "stop on the wrong side of entry")
    d_stop = abs(entry - stop) / entry
    if not 0 < d_stop < 1:
        return reject(INVALID_STOP, f"stop distance {d_stop}")
    rec["stop_distance_pct"] = d_stop

    if len(req.open_positions) >= policy.max_positions:
        return reject(MAX_POSITIONS, f"{len(req.open_positions)} open >= {policy.max_positions}")

    peak = req.peak_equity if _finite(req.peak_equity) and req.peak_equity > 0 else E
    dd = max(0.0, (peak - E) / peak)
    m_dd = drawdown_multiplier(dd, policy)
    rec.update({"drawdown_pct": dd, "drawdown_multiplier": m_dd})
    if m_dd is None:
        return reject(DRAWDOWN_RISK_PAUSE, f"drawdown {dd:.4f} >= {policy.dd_pause_pct}")

    vol, why = volatility_state(req.vol, req.now_ms, policy)
    if vol is None:
        return reject(NO_VOLATILITY_STATE, why)
    rec.update({k: vol[k] for k in ("realised_vol", "vol_reference", "vol_multiplier", "vol_bars", "vol_last_bar_open_ms")})

    liq, why_liq = liquidity_state(req.depth, req.direction, req.now_ms, policy)
    if liq is None and req.require_depth:
        return reject(NO_LIQUIDITY_STATE, why_liq)
    rec["liquidity_status"] = "BOOK" if liq else f"UNAVAILABLE ({why_liq}) -- not applied, research record only"

    r_eff = policy.base_risk_pct * vol["vol_multiplier"] * m_dd
    B = E * r_eff
    rec.update({"effective_risk_pct": r_eff, "risk_budget_dollars": B})

    # Execution allowance. Entry slippage is estimated at the largest size
    # this trade could possibly have (the 5% ceiling); if the book cannot
    # fill that within the bound, the bound itself is assumed. Either way a
    # thinner book can only raise the estimate, never lower it.
    pos_cap = policy.max_position_notional_pct * E
    bound = policy.max_expected_entry_slippage_bps / 10_000
    entry_slip = min(bound, liq["slippage_at"](pos_cap)) if liq else policy.default_slippage_pct
    stress_exit = max(entry_slip, policy.default_slippage_pct) * policy.stress_exit_slippage_mult + policy.gap_stress_pct
    expected_total = 2 * policy.fee_pct + entry_slip + stress_exit
    allowance = max(policy.execution_buffer_floor_pct, expected_total)
    L = d_stop + allowance
    rec.update({"expected_entry_fee": policy.fee_pct, "expected_exit_fee": policy.fee_pct,
                "expected_entry_slippage": entry_slip, "stress_exit_slippage": stress_exit,
                "expected_execution_cost": expected_total, "execution_buffer_pct": allowance,
                "effective_loss_fraction": L})

    N_risk = B / L
    open_notional = sum(p.notional for p in req.open_positions)
    open_margin = sum(p.margin for p in req.open_positions)
    open_planned = sum(p.planned_loss for p in req.open_positions)
    cluster_planned = sum(p.planned_loss for p in req.open_positions if p.cluster_id == cluster_id)
    leverage = max(1.0, min(float(req.requested_leverage or 1.0), policy.max_leverage))
    caps = {
        RISK_BUDGET: N_risk,
        POSITION_NOTIONAL_CAP: pos_cap,
        LIQUIDITY_CAP: liq["liquidity_cap_notional"] if liq else math.inf,
        CLUSTER_PLANNED_RISK_CAP: (policy.max_cluster_planned_risk_pct * E - cluster_planned) / L,
        PORTFOLIO_PLANNED_RISK_CAP: (policy.max_open_planned_risk_pct * E - open_planned) / L,
        PORTFOLIO_GROSS_CAP: policy.max_portfolio_gross_pct * E - open_notional,
        MARGIN_CAP: (E - open_margin) * leverage,
    }
    rec.update({"raw_risk_notional": N_risk, "position_notional_cap": pos_cap,
                "liquidity_cap_notional": liq["liquidity_cap_notional"] if liq else None,
                "cluster_cap_notional": caps[CLUSTER_PLANNED_RISK_CAP], "portfolio_cap_notional": caps[PORTFOLIO_PLANNED_RISK_CAP],
                "portfolio_gross_cap_notional": caps[PORTFOLIO_GROSS_CAP], "margin_cap_notional": caps[MARGIN_CAP],
                "existing_open_planned_risk": open_planned, "existing_cluster_planned_risk": cluster_planned,
                "remaining_cluster_risk": policy.max_cluster_planned_risk_pct * E - cluster_planned,
                "remaining_open_planned_risk": policy.max_open_planned_risk_pct * E - open_planned,
                "existing_open_notional": open_notional, "leverage": leverage})
    for name in (CLUSTER_PLANNED_RISK_CAP, PORTFOLIO_PLANNED_RISK_CAP, PORTFOLIO_GROSS_CAP, MARGIN_CAP):
        if caps[name] <= 0:
            return reject(name, "no remaining capacity")
    if liq and caps[LIQUIDITY_CAP] <= 0:
        return reject(EXCESS_EXPECTED_SLIPPAGE, "the first unit already exceeds the slippage bound")

    binding = min(caps, key=lambda k: (caps[k], list(caps).index(k)))
    N_final = caps[binding]
    step = 10 ** -int(req.venue.qty_decimals)
    qty = math.floor(N_final / entry / step + 1e-9) * step        # round DOWN, never up
    qty = round(qty, int(req.venue.qty_decimals))
    while qty > 0 and qty * entry > N_final:                       # float guard: rounding can never exceed the safe size
        qty = round(qty - step, int(req.venue.qty_decimals))
    final_notional = qty * entry
    rec.update({"sizing_binding_constraint": binding,
                "sizing_reduction_reason": None if binding == RISK_BUDGET else f"{binding} reduced size below the risk-budget size",
                "cluster_cap_applied": binding == CLUSTER_PLANNED_RISK_CAP})
    if qty <= 0 or final_notional < req.venue.min_notional:
        return reject(MIN_ORDER_EXCEEDS_SAFE_SIZE, f"safe notional {final_notional:.4f} < venue minimum {req.venue.min_notional}")

    planned = final_notional * L
    tol = 1e-9 * max(1.0, E)
    checks = [planned <= B + tol, final_notional <= pos_cap + tol,
              open_notional + final_notional <= policy.max_portfolio_gross_pct * E + tol,
              open_planned + planned <= policy.max_open_planned_risk_pct * E + tol,
              cluster_planned + planned <= policy.max_cluster_planned_risk_pct * E + tol,
              final_notional <= caps[LIQUIDITY_CAP] + tol, final_notional <= caps[MARGIN_CAP] + tol]
    if not all(checks):
        return reject(INVALID_RISK_CALCULATION, f"post-check failed: {checks}")
    rec.update({"approved": True, "rejection_reason": None, "final_quantity": qty, "final_notional": final_notional,
                "final_notional_pct_equity": final_notional / E, "planned_loss_dollars": planned,
                "planned_loss_pct_equity": planned / E, "margin_required": final_notional / leverage,
                "planned_price_loss_dollars": final_notional * d_stop})
    return SizingDecision(True, None, qty, rec)


def kelly_fraction(*_args, policy: SizingPolicy = DEFAULT_POLICY) -> None:
    """Disabled interface. Kelly may never size a trade in this policy
    version and could never bypass any cap even when researched later."""
    if policy.kelly_enabled:  # unreachable: SizingPolicy refuses kelly_enabled=True
        raise RuntimeError("KELLY_DISABLED_BY_POLICY")
    return None


# ---- current (evolving) risk of an open position -------------------------------
def current_risk(trade: dict, original: Optional[dict] = None, floor_pct: float = DEFAULT_POLICY.execution_buffer_floor_pct) -> dict:
    """Risk still at stake now: remaining quantity to the ACTIVE stop (entry
    after TP1, per the lifecycle's breakeven rule) plus the original
    execution allowance on what is left. Never writes the original record."""
    remaining = float(trade.get("remaining_qty") or 0.0)
    entry = float(trade["entry_fill"])
    active_stop = entry if trade.get("tp1_hit") else float(trade["stop"])
    adverse = max(0.0, (entry - active_stop) if trade["direction"] == "long" else (active_stop - entry))
    allowance = (original or {}).get("execution_buffer_pct") or floor_pct
    mark = trade.get("mark_price") or entry
    notional = remaining * float(mark)
    planned = remaining * adverse + remaining * entry * allowance
    cluster_id = (original or {}).get("cluster_id") or cluster_for(trade.get("asset") or trade.get("instrument", ""))[0]
    return {"remaining_qty": remaining, "active_stop": active_stop, "current_notional": notional,
            "current_margin": notional / max(1.0, float(trade.get("approved_leverage") or 1.0)),
            "current_planned_loss": planned, "cluster_id": cluster_id}
