"""ExitShadow: records what a real trade's engine observed and keeps every
registered policy's counterfactual replay up to date. Research only.

It is handed a trade dict to READ. It never writes to a trade, never routes,
never touches capital, the portfolio, Nautilus or Hummingbot, and every call
is wrapped so a failure here can never affect the real trade path.
"""
from __future__ import annotations

import dataclasses
import time
from typing import Optional

from market_edge_exec.exits import EXIT_MANAGER_VERSION, policies as pol, replay as rp
from market_edge_exec.exits.model import TradeSpec, spec_from_trade
from market_edge_exec.exits.state import RunState
from market_edge_exec.exits.store import ExitStore
from market_edge_exec.paper import lifecycle
from market_edge_exec.telemetry.logging import log_event


def _run_from_json(data: dict) -> RunState:
    return RunState(**data)


def real_outcome(spec: TradeSpec, trade: dict) -> dict:
    """The real trade's own after-cost R (same units as a counterfactual), for like-for-like comparison."""
    net = float(trade.get("realized_pnl") or 0.0) - float(trade.get("fees") or 0.0)
    kinds = [e["kind"] for e in trade.get("exits") or []]
    return {"real_R": net / spec.risk_dollars, "real_net_pnl": net, "real_exit_reason": trade.get("exit_reason"),
            "real_exit_time": trade.get("closed_at_ms"), "real_reached_tp1": "TP1" in kinds, "real_reached_tp2": "TP2" in kinds}


class ExitShadow:
    def __init__(self, ledger, registry=pol.REGISTRY):
        self.store = ExitStore(ledger._connect)
        self.registry = registry
        self._batch = 0

    # ---- recording (called by the engine AFTER it evaluated an observation) -----
    def record_tick(self, trade: dict, price: float, at_ms: int, high: Optional[float], low: Optional[float], eval_ms: int) -> None:
        hi = max([price, *[h for h in (high,) if h is not None]])
        lo = min([price, *[l for l in (low,) if l is not None]])
        self._batch += 1
        self.store.append_observations(trade["trade_id"], [{"kind": "TICK", "at_ms": at_ms, "eval_ms": eval_ms, "price": price,
                                                            "high": hi, "low": lo, "open": price, "batch": self._batch, "last": True}])

    def record_candles(self, trade: dict, candles: list[dict], eval_ms: int) -> None:
        self._batch += 1
        ordered = sorted(candles, key=lambda c: c["time"])
        self.store.append_observations(trade["trade_id"], [
            {"kind": "CANDLE", "at_ms": c["time"], "eval_ms": eval_ms, "price": c["close"], "high": c["high"], "low": c["low"],
             "open": c["open"], "batch": self._batch, "last": i == len(ordered) - 1} for i, c in enumerate(ordered)])

    # ---- replay ---------------------------------------------------------------
    def update(self, trade: dict, finalize: bool = False) -> dict:
        """Advance every policy's replay by the observations it has not yet seen
        (incremental; identical to a full replay). With `finalize` (the real trade
        has closed) the rows are frozen with the real outcome attached."""
        spec = spec_from_trade(trade)
        if spec is None:
            return {}
        stored = self.store.load(spec.trade_id)
        out = {}
        for name, policy in self.registry.items():
            row = stored.get(name)
            if row and row["finalized"]:
                out[name] = row["record"]
                continue
            run = _run_from_json(row["state"]) if row else rp.new_run(spec)
            rp.replay(spec, self.store.observations(spec.trade_id, run.last_seq), policy, run)
            record = rp.summarize(spec, run)
            record.update({"policy_version": name, "study": policy.study, "registry_version": pol.POLICY_REGISTRY_VERSION,
                           "manager_version": EXIT_MANAGER_VERSION, "asset": spec.asset, "direction": spec.direction,
                           "opened_at_ms": spec.opened_at_ms, "stop_distance_pct": spec.risk_distance / spec.entry * 100.0,
                           "params": dict(policy.params)})
            if finalize:
                record.update(real_outcome(spec, trade))
                if record["status"] == "OPEN":
                    record["status"] = "PATH_ENDED_OPEN"   # the real trade ended first; never a fabricated exit
            self.store.save(spec.trade_id, name, dict(policy.params), dataclasses.asdict(run), record, finalized=finalize)
            out[name] = record
        return out

    def safe(self, label: str, fn, *args, **kwargs):
        """A failure in research code must never affect the real trade path."""
        try:
            return fn(*args, **kwargs)
        except Exception as error:  # noqa: BLE001
            log_event("exit_shadow_error", reason=label, detail=str(error)[:300])
            return None
