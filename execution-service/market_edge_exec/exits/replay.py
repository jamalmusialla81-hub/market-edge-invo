"""Counterfactual replay (MAJOR 3G): a deterministic, pure state machine that
walks the observations a real trade actually saw through the fixed lifecycle
with one candidate policy layered on top.

  * `step()` consumes ONE observation, so an open trade can be replayed
    incrementally and reach exactly the result a full replay would.
  * No lookahead: an observation is first judged against the stop the policy
    had set BEFORE it; only then is it added to the state the policy reads.
  * The original hard stop is a floor: stops only ratchet tighter, so a policy
    can close a position EARLIER, never loosen protection.
  * CURRENT_POLICY never intervenes, and goes through the very same
    lifecycle.advance / evaluate_tick the real engine uses, so its replay of a
    real trade reproduces that trade's actual exits.

Pure: no database, no clock, no randomness, and nothing that can reach a trade,
order, router, portfolio or Nautilus.
"""
from __future__ import annotations

from typing import Iterable, Optional

from market_edge_exec.exits import policies as pol
from market_edge_exec.exits.model import (
    Action, FULL_EXIT, Observation, PARTIAL_EXIT, STOP_ACTIONS, TradeSpec,
)
from market_edge_exec.exits.state import RunState, baseline_stop, compute_state, effective_stop, CLOSES_KEPT, VOL_WINDOW
from market_edge_exec.paper import lifecycle

POLICY_STOP, POLICY_EXIT, POLICY_PARTIAL = "POLICY_STOP", "POLICY_EXIT", "POLICY_PARTIAL"
STOP_CHANGES_KEPT = 40


def new_run(spec: TradeSpec) -> RunState:
    return RunState(qty_left=spec.quantity, best_price=spec.entry, worst_price=spec.entry, best_at_ms=spec.opened_at_ms,
                    last_price=spec.entry, last_known_ms=spec.opened_at_ms, last_exit_at_ms=spec.opened_at_ms, fees=spec.entry_fee)


def _tighter(long: bool, a: float, b: float) -> bool:
    return a > b if long else a < b


def _evaluate(spec: TradeSpec, run: RunState, obs: Observation) -> list:
    """Exit events the fixed lifecycle produces for this observation, against
    the (possibly policy-tightened) stop in force BEFORE it."""
    eff, base = effective_stop(spec, run), baseline_stop(spec, run.tp1_hit)
    override: Optional[float] = eff if eff != base else None
    side = lifecycle.exit_side(spec.direction)
    if obs.kind == "CANDLE":
        candle = {"time": obs.at_ms, "open": obs.open, "high": obs.high, "low": obs.low, "close": obs.price}
        # The fixed timeout is judged once per sweep, after its last candle.
        now = obs.eval_ms if obs.last else spec.opened_at_ms
        events = lifecycle.advance(spec.direction, spec.entry, spec.stop, spec.tp1, spec.tp2, run.qty_left, spec.quantity,
                                   run.tp1_hit, spec.opened_at_ms, [candle], now, spec.max_hold_ms, active_stop_override=override)
        if override is not None:
            for e in events:
                if e.kind in ("STOP", "BREAKEVEN_STOP") and e.level == override:
                    # a candle that opens through a policy stop fills at the open, not at the better stop level
                    gap_base = min(override, obs.open) if spec.long else max(override, obs.open)
                    e.fill_price = lifecycle.slipped(gap_base, side)
    else:
        if obs.at_ms < run.last_exit_at_ms:
            return []
        events = lifecycle.evaluate_tick(spec.direction, spec.entry, spec.stop, spec.tp1, spec.tp2, run.qty_left, spec.quantity,
                                         run.tp1_hit, spec.opened_at_ms, obs.price, obs.at_ms, spec.max_hold_ms,
                                         active_stop_override=override)
    if override is not None:
        for e in events:
            if e.kind in ("STOP", "BREAKEVEN_STOP"):
                e.kind = POLICY_STOP
    return events


def _apply_events(spec: TradeSpec, run: RunState, events: list) -> None:
    for e in events:
        if run.status != "OPEN":
            break
        realized = lifecycle.pnl(spec.direction, spec.entry, e.fill_price, e.quantity)
        run.realized_pnl += realized
        run.fees += lifecycle.fee(e.fill_price, e.quantity)
        run.exit_slippage += abs(e.fill_price - e.level) * e.quantity
        run.qty_left = max(0.0, run.qty_left - e.quantity)
        run.last_exit_at_ms = max(run.last_exit_at_ms, e.at_ms)
        run.events.append({"kind": e.kind, "quantity": e.quantity, "level": e.level, "fill_price": e.fill_price,
                           "pnl": realized, "at_ms": e.at_ms})
        if e.kind == "TP1":
            run.tp1_hit = True
        if run.qty_left <= 1e-12:
            run.qty_left, run.status, run.closed_at_ms, run.exit_reason = 0.0, "CLOSED", e.at_ms, e.kind


def _update_extremes(spec: TradeSpec, run: RunState, obs: Observation) -> None:
    hi, lo = max(obs.high, obs.price), min(obs.low, obs.price)
    if spec.long:
        if hi > run.best_price:
            run.best_price, run.best_at_ms = hi, obs.at_ms
        run.worst_price = min(run.worst_price, lo)
    else:
        if lo < run.best_price:
            run.best_price, run.best_at_ms = lo, obs.at_ms
        run.worst_price = max(run.worst_price, hi)
    run.last_price, run.last_known_ms = obs.price, obs.known_at_ms
    if obs.kind == "CANDLE":
        run.closes = (run.closes + [obs.price])[-CLOSES_KEPT:]
        run.ranges = (run.ranges + [obs.high - obs.low])[-VOL_WINDOW:]


def _exit_now(spec: TradeSpec, run: RunState, obs: Observation, kind: str, quantity: float) -> None:
    fill = lifecycle.slipped(obs.price, lifecycle.exit_side(spec.direction))
    _apply_events(spec, run, [lifecycle.ExitEvent(kind, quantity, obs.price, fill, obs.known_at_ms)])


def _apply_action(spec: TradeSpec, run: RunState, obs: Observation, action: Action) -> None:
    if action.kind in STOP_ACTIONS and action.stop is not None:
        through = action.stop >= run.last_price if spec.long else action.stop <= run.last_price
        if through:   # a stop on the wrong side of the market is an exit now
            _exit_now(spec, run, obs, POLICY_EXIT, run.qty_left)
        elif _tighter(spec.long, action.stop, effective_stop(spec, run)):
            run.cf_stop = action.stop
            run.stop_changes = (run.stop_changes + [[obs.known_at_ms, action.kind, action.stop]])[-STOP_CHANGES_KEPT:]
    elif action.kind == FULL_EXIT:
        _exit_now(spec, run, obs, POLICY_EXIT, run.qty_left)
    elif action.kind == PARTIAL_EXIT and action.fraction and 0 < action.fraction < 1 and run.partials == 0:
        run.partials += 1   # at most one partial per policy per trade
        part = min(round(spec.quantity * action.fraction, 8), run.qty_left)
        if part > 0:
            _exit_now(spec, run, obs, POLICY_PARTIAL, part)


def step(spec: TradeSpec, run: RunState, obs: Observation, policy: pol.Policy) -> None:
    """Consume one observation. Idempotent per observation seq."""
    if obs.seq <= run.last_seq:
        return
    run.last_seq = obs.seq
    if run.status != "OPEN":
        return
    run.obs_count += 1
    _apply_events(spec, run, _evaluate(spec, run, obs))
    if run.status != "OPEN":
        return   # closed by the fixed lifecycle (or its own stop): MFE/MAE stop here
    _update_extremes(spec, run, obs)
    _apply_action(spec, run, obs, policy.fn(compute_state(spec, run), policy.params))


def replay(spec: TradeSpec, observations: Iterable[Observation], policy: pol.Policy, run: Optional[RunState] = None) -> RunState:
    run = run or new_run(spec)
    for obs in observations:
        step(spec, run, obs, policy)
    return run


def summarize(spec: TradeSpec, run: RunState) -> dict:
    """The per-(trade, policy) counterfactual record. R is after fees, in units
    of the initial stop risk (|entry - stop| * quantity)."""
    long, one_r = spec.long, spec.risk_dollars
    exited = sum(e["quantity"] for e in run.events)
    open_unrealized = 0.0 if run.status == "CLOSED" else lifecycle.pnl(spec.direction, spec.entry, run.last_price, run.qty_left)
    net = run.realized_pnl + open_unrealized - run.fees
    mfe = max(0.0, (run.best_price - spec.entry) if long else (spec.entry - run.best_price))
    mae = max(0.0, (spec.entry - run.worst_price) if long else (run.worst_price - spec.entry))
    r = net / one_r
    mfe_r = mfe * spec.quantity / one_r
    return {
        "status": "EXITED" if run.status == "CLOSED" else "OPEN",
        "counterfactual_exit_time": run.closed_at_ms,
        "counterfactual_exit_price": (sum(e["fill_price"] * e["quantity"] for e in run.events) / exited) if exited else None,
        "counterfactual_R": r,
        "counterfactual_net_pnl": net,
        "counterfactual_fees": run.fees,
        "counterfactual_slippage": run.exit_slippage,
        "MFE": mfe, "MAE": mae, "MFE_R": mfe_r, "MAE_R": mae * spec.quantity / one_r,
        "giveback_R": mfe_r - r,
        "reason": run.exit_reason,
        "tp1_hit": run.tp1_hit,
        "events": list(run.events),
        "stop_changes": list(run.stop_changes),
        "observations": run.obs_count,
        "risk_dollars": one_r,
    }
