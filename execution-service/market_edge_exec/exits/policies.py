"""Candidate exit policies (MAJOR 3A-3F) and the CURRENT_POLICY baseline.

Every policy has the same shape, a pure function
    (PositionState, params) -> Action
so the replay engine treats them identically. Parameters are versioned by
name (the registry key IS the policy_version stored on every record): a change
of any number means a NEW name, never an edit, so an old record can never be
silently reinterpreted.

Policies can only make a trade exit EARLIER or its stop TIGHTER than the fixed
lifecycle: the replay ratchets stops (never loosens them) and the original
hard stop stays the floor. None of this is authoritative for a real trade.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Callable

from market_edge_exec.exits.model import Action, FULL_EXIT, HOLD, MOVE_TO_BREAKEVEN, TIGHTEN_STOP, TRAIL_STOP
from market_edge_exec.exits.state import PositionState
from market_edge_exec.paper import lifecycle

POLICY_REGISTRY_VERSION = "EXIT-POLICIES-V3"   # V2 = V1 plus Task O structural variants; V3 = V2 plus STATE_AWARE_GIVEBACK_V1; no earlier policy changed
HOUR_MS = 3_600_000
# Round-trip fees + one exit slippage, from the lifecycle's own constants: a
# stop here means "about no loss after costs", not "exactly at entry".
COST_FRACTION = 2 * lifecycle.FEE_PCT + lifecycle.SLIPPAGE_PCT


def _toward(state: PositionState, level_from_entry: float) -> float:
    """A price `level_from_entry` (price units, >= 0 is in profit) from entry."""
    return state.entry + level_from_entry if state.direction == "long" else state.entry - level_from_entry


def current_policy(state: PositionState, params: dict) -> Action:
    """The fixed lifecycle (stop / TP1 50% + breakeven / TP2 / timeout): never intervenes."""
    return Action(HOLD)


# ---- 3A breakeven protection -------------------------------------------------
def breakeven(state: PositionState, params: dict) -> Action:
    if state.mfe_R < params["activate_R"]:
        return Action(HOLD)
    cost = state.entry * COST_FRACTION if params["plus_costs"] else 0.0
    return Action(MOVE_TO_BREAKEVEN, stop=_toward(state, cost))


# ---- 3B MFE giveback trail ---------------------------------------------------
def mfe_trail(state: PositionState, params: dict) -> Action:
    if state.mfe_R < params["activate_R"]:
        return Action(HOLD)
    return Action(TRAIL_STOP, stop=_toward(state, (1.0 - params["giveback"]) * state.mfe_price))


# ---- 3C volatility-aware trail ------------------------------------------------
def vol_trail(state: PositionState, params: dict) -> Action:
    if state.mfe_R < params["activate_R"] or state.volatility is None:
        return Action(HOLD)   # no observed volatility yet: no trail, never a guessed one
    stop = state.best_price - params["k"] * state.volatility if state.direction == "long" \
        else state.best_price + params["k"] * state.volatility
    return Action(TRAIL_STOP, stop=stop)


# ---- 3D post-TP1 profit protection ---------------------------------------------
def post_tp1_protect(state: PositionState, params: dict) -> Action:
    if not state.tp1_hit or state.tp1 is None:
        return Action(HOLD)
    return Action(TIGHTEN_STOP, stop=_toward(state, params["lock_fraction"] * abs(state.tp1 - state.entry)))


# ---- 3E momentum deterioration (deterministic, interpretable) --------------------
def momentum_decay(state: PositionState, params: dict) -> Action:
    if (state.mfe_R >= params["activate_R"] and state.unrealized_R > 0
            and state.adverse_closes >= params["adverse_closes"] and state.distance_from_peak_R >= params["retrace_R"]):
        return Action(FULL_EXIT, note="MOMENTUM_DECAY")
    return Action(HOLD)


# ---- 3F time + profit decay ------------------------------------------------------
def time_decay(state: PositionState, params: dict) -> Action:
    if state.mfe_R < params["activate_R"]:
        return Action(HOLD)
    stalled = state.time_since_mfe_ms
    if stalled >= 2 * params["hours"] * HOUR_MS and 0 < state.unrealized_R < 0.75 * state.mfe_R:
        return Action(FULL_EXIT, note="STALLED_WINNER")
    if stalled >= params["hours"] * HOUR_MS:
        return Action(TIGHTEN_STOP, stop=_toward(state, 0.5 * state.mfe_price))
    return Action(HOLD)


# ---- Task O: fixed structural variants of the baseline lifecycle -------------------------------------------------
def structural_variant(state: PositionState, params: dict) -> Action:
    """Never intervenes. The variant lives in its params (`tp1_fraction`, `max_hold_h`), which the replay hands to the
    same lifecycle.advance / evaluate_tick the baseline uses, so it differs from CURRENT_POLICY in exactly that one number."""
    return Action(HOLD)


# ---- 3Q STATE_AWARE_GIVEBACK_V1 (#121) -------------------------------------------------------------------------
def state_aware_giveback(state: PositionState, params: dict) -> Action:
    """Interpretable: it only acts on a winner that has given back a large FRACTION of its peak, has not made a new peak for a while and
    whose momentum has turned. A trade that made its peak recently, or is still moving with the position, is HELD (case A). Missing
    momentum or volatility means no decision, never a guess. Stops only tighten and the hard stop stays the floor; exits only come earlier."""
    if state.mfe_R < params["activate_R"] or state.mfe_R <= 0 or state.momentum_R is None or state.volatility is None:
        return Action(HOLD)
    giveback_fraction = state.distance_from_peak_R / state.mfe_R
    recent_peak = state.time_since_mfe_ms < params["stall_h"] * HOUR_MS
    healthy = recent_peak or state.momentum_R > 0
    if giveback_fraction < params["giveback_fraction"] or healthy:
        return Action(HOLD)
    if params["mode"] == "EXIT":
        return Action(FULL_EXIT, note="STATE_AWARE_GIVEBACK") if state.unrealized_R > 0 else Action(HOLD)
    protect = state.price - params["vol_mult"] * state.volatility if state.direction == "long" else state.price + params["vol_mult"] * state.volatility
    return Action(TIGHTEN_STOP, stop=protect)


# The whole grid is declared here, before any evaluation: 2 giveback fractions x 2 stall times for PROTECT, and the stricter fraction for EXIT.
STATE_AWARE_GRID = {"activate_R": 0.8, "vol_mult": 1.5, "giveback_fraction": (0.40, 0.55), "stall_h": (1, 3),
                    "variants": (("PROTECT", 0.40, 1), ("PROTECT", 0.40, 3), ("PROTECT", 0.55, 1), ("PROTECT", 0.55, 3),
                                 ("EXIT", 0.55, 1), ("EXIT", 0.55, 3))}


@dataclass(frozen=True)
class Policy:
    version: str
    study: str        # which MAJOR 3 sub-task it belongs to
    fn: Callable
    params: dict
    description: str


def _build() -> dict:
    out = {}

    def add(version, study, fn, params, description):
        out[version] = Policy(version, study, fn, MappingProxyType(dict(params)), description)

    add("CURRENT_POLICY", "3G-baseline", current_policy, {}, "The fixed lifecycle: stop, TP1 50% + breakeven, TP2, timeout.")
    for r in (0.5, 0.75, 1.0):
        tag = str(r).rstrip("0").rstrip(".") if r != 1.0 else "1.0"
        add(f"BREAKEVEN_V1_R{tag}", "3A", breakeven, {"activate_R": r, "plus_costs": False},
            f"Stop to entry once MFE reaches +{r}R (independent of TP1).")
        add(f"BREAKEVEN_V1_R{tag}_COSTS", "3A", breakeven, {"activate_R": r, "plus_costs": True},
            f"Stop to entry plus round-trip costs once MFE reaches +{r}R.")
    for g in (25, 33, 50):
        add(f"MFE_TRAIL_{g}", "3B", mfe_trail, {"activate_R": 0.5, "giveback": g / 100},
            f"After +0.5R MFE, stop locks all but {g}% of the peak favourable move.")
    for k in (2, 3):
        add(f"VOL_TRAIL_V1_K{k}", "3C", vol_trail, {"activate_R": 0.5, "k": float(k)},
            f"After +0.5R MFE, stop trails the peak by {k} x mean 5m candle range (PATH_RANGE_V1).")
    for lock in (25, 50):
        add(f"POST_TP1_PROTECT_V1_L{lock}", "3D", post_tp1_protect, {"lock_fraction": lock / 100},
            f"After TP1, stop locks {lock}% of the entry-to-TP1 distance.")
    for n in (2, 3):
        add(f"MOMENTUM_DECAY_V1_N{n}", "3E", momentum_decay, {"activate_R": 0.75, "adverse_closes": n, "retrace_R": 0.4},
            f"Exit a winner (MFE >= 0.75R, still in profit) after {n} consecutive adverse 5m closes and a 0.4R retrace.")
    for h in (12, 24):
        add(f"TIME_DECAY_V1_H{h}", "3F", time_decay, {"activate_R": 0.5, "hours": h},
            f"Winner (MFE >= 0.5R) with no new peak for {h}h: stop to half the MFE; at {2 * h}h exit if it faded below 75% of the peak.")
    # 3O: the baseline's own fixed structure. Every one differs from CURRENT_POLICY by exactly one named number.
    for split in (25, 75):
        add(f"TP1_SPLIT_V1_{split}_{100 - split}", "3O", structural_variant, {"tp1_fraction": split / 100},
            f"Take {split}% at TP1 and {100 - split}% at TP2 (baseline is 50/50); stop to breakeven after TP1 as before.")
    for h in (48, 72):
        add(f"TIMEOUT_V1_H{h}", "3O", structural_variant, {"max_hold_h": h},
            f"Time out after {h}h instead of {lifecycle.MAX_HOLD_MS // HOUR_MS}h. Only shorter timeouts are listed: the real trade's price path "
            f"ends at its own exit, so a longer timeout can never be replayed without inventing prices.")
    # 3Q: STATE_AWARE_GIVEBACK_V1, a preregistered handful (STATE_AWARE_GRID); strategy is a research breakdown only, never a parameter.
    for mode, frac, hours in STATE_AWARE_GRID["variants"]:
        add(f"STATE_AWARE_GIVEBACK_V1_{mode}_G{int(round(frac * 100))}_H{hours}", "3Q", state_aware_giveback,
            {"mode": mode, "activate_R": STATE_AWARE_GRID["activate_R"], "giveback_fraction": frac, "stall_h": hours,
             "vol_mult": STATE_AWARE_GRID["vol_mult"]},
            f"Winner (MFE >= {STATE_AWARE_GRID['activate_R']}R) that gave back >= {int(frac * 100)}% of its peak, no new peak for {hours}h and momentum "
            f"turned: {'exit' if mode == 'EXIT' else 'stop to ' + str(STATE_AWARE_GRID['vol_mult']) + ' x PATH_RANGE_V1 behind the price'}. "
            f"Held while the peak is recent or momentum is with the trade.")
    return out


REGISTRY = MappingProxyType(_build())
BASELINE = "CURRENT_POLICY"


def registry_view() -> list[dict]:
    return [{"policy_version": p.version, "study": p.study, "params": dict(p.params), "description": p.description}
            for p in REGISTRY.values()]
