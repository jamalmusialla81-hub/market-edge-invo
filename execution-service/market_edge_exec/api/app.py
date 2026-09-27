"""FastAPI transport between the Node app and this Python service.

All endpoints require the X-API-Key header (checked against
MARKET_EDGE_EXEC_API_KEY; unset means "reject everything" rather than
silently allowing unauthenticated calls). No exchange secrets ever pass
through here — the service holds them (once real backends exist), the API
only carries ExecutionIntent/ExecutionFill/PositionSnapshot shapes. There is
no public live-trading endpoint: this service is PAPER ONLY, enforced by
`PAPER_ONLY = True` below rather than by an env flag a deploy could flip.
"""
from __future__ import annotations

import os
import sqlite3
import time
from contextlib import closing

from fastapi import Depends, FastAPI, Header, HTTPException

from market_edge_exec.control.settings import BOUNDS as SETTINGS_BOUNDS, ControlStore, SettingsError
from market_edge_exec.domain.contracts import ContractError, ExecutionIntent
from market_edge_exec.hummingbot.factory import build_hummingbot_client
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.paper.engine import PaperEngine
from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.paper.performance import build_performance, position_view, signal_rows, trade_view
from market_edge_exec.paper.report import build_report
from market_edge_exec.persistence.store import Store
from market_edge_exec.reconciliation.reconcile import reconcile
from market_edge_exec.risk.engine import approve
from market_edge_exec.routing.router import BACKEND_HUMMINGBOT, BACKEND_NAUTILUS_NATIVE, ExecutionRouter, RouterError
from market_edge_exec.signal_bridge.bridge import process_signal

PAPER_ONLY = True  # hard-coded, not configurable via request or env


class PaperBackendAdapter:
    """Wraps NautilusPortfolio so it satisfies the router's backend.submit(intent) contract."""

    def __init__(self, portfolio: NautilusPortfolio, name: str):
        self._portfolio = portfolio
        self._name = name

    def submit(self, intent: ExecutionIntent):
        from market_edge_exec.domain.contracts import ExecutionFill
        import time
        price = intent.limit_price or intent.stop or 0.0
        self._portfolio.apply_fill(intent, price, intent.quantity, self._name)
        return ExecutionFill.create({
            "signal_id": intent.signal_id, "fill_id": f"{self._name}-{intent.signal_id}", "status": "FILLED",
            "quantity_filled": intent.quantity, "avg_price": price, "backend": self._name, "timestamp": int(time.time() * 1000),
        })

    def cancel(self, signal_id: str):
        from market_edge_exec.domain.contracts import ExecutionFill
        import time
        return ExecutionFill.create({"signal_id": signal_id, "fill_id": f"{self._name}-{signal_id}-cancel", "status": "CANCELLED", "quantity_filled": 0, "backend": self._name, "timestamp": int(time.time() * 1000)})


def create_app(db_path: str = "market_edge_exec.sqlite3", hummingbot_mode: str = None) -> FastAPI:
    """hummingbot_mode: 'disabled' (default: no Hummingbot backend at all),
    'real' (bridge must be reachable at startup) or 'mock' (tests only).
    There is no runtime fallback between them."""
    app = FastAPI(title="Market Edge Execution Service (paper-only)")
    store = Store(db_path)
    portfolio = NautilusPortfolio(store)
    mode = hummingbot_mode or os.environ.get("HUMMINGBOT_MODE", "disabled")
    hummingbot = None if mode == "disabled" else build_hummingbot_client(mode)
    ledger = PaperLedger(db_path)
    control = ControlStore(db_path)

    # Account state is re-derived from the persistent ledger on every call.
    # It used to be one AccountState built at startup and never updated, so
    # risk limits never saw open trades.
    def current_account():
        return ledger.account_state(killed=router.killed)

    def risk_gate(intent: ExecutionIntent):
        return approve(intent, current_account(), control.risk_limits()).decision

    router = ExecutionRouter(
        store=store, risk_gate=risk_gate,
        backends={BACKEND_NAUTILUS_NATIVE: PaperBackendAdapter(portfolio, BACKEND_NAUTILUS_NATIVE),
                  **({BACKEND_HUMMINGBOT: hummingbot} if hummingbot else {})},
    )
    paper = PaperEngine(ledger, router, store, portfolio=portfolio, limits_provider=control.risk_limits,
                        entries_gate=lambda: "ENTRIES_PAUSED" if control.entries_paused() else None,
                        max_mark_age_provider=control.stale_data_timeout_s)
    app.state.store, app.state.portfolio, app.state.hummingbot, app.state.router = store, portfolio, hummingbot, router
    app.state.ledger, app.state.paper, app.state.control = ledger, paper, control
    app.state.request_shutdown = None  # set by run_server.py when it owns the uvicorn server
    started_at = time.time()

    def require_api_key(x_api_key: str = Header(default=None)):
        expected = os.environ.get("MARKET_EDGE_EXEC_API_KEY")
        if not expected or x_api_key != expected:
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    @app.get("/health")
    def health():
        return {"status": "ok", "paper_only": PAPER_ONLY, "killed": router.killed, "hummingbot_mode": mode}

    @app.post("/execution/intent", dependencies=[Depends(require_api_key)])
    def submit_intent(payload: dict):
        try:
            intent = ExecutionIntent.create(payload)
        except ContractError as error:
            raise HTTPException(status_code=422, detail=str(error))
        try:
            backend_name, fill = router.route(intent)
        except RouterError as error:
            raise HTTPException(status_code=409, detail=str(error))
        return {"backend": backend_name, "fill": fill.to_dict()}

    @app.post("/execution/signal", dependencies=[Depends(require_api_key)])
    def submit_signal(payload: dict):
        """Part E entry point: takes a Market Edge AlphaSignal shape
        (signal_id/asset/direction/timestamp/entry/stop/targets/strategy_id)
        plus the instrument to trade it as, validates freshness, has risk
        compute the real position size (never the caller's), and routes.
        Rejections (stale, invalid, risk) are logged and returned, never
        silently dropped -- see signal_bridge/bridge.py."""
        signal_payload = payload.get("signal")
        instrument = payload.get("instrument")
        if not isinstance(signal_payload, dict) or not instrument:
            raise HTTPException(status_code=422, detail="signal and instrument are required")
        result = process_signal(signal_payload, instrument, router, current_account(), store,
                                 venue_preference=payload.get("venue_preference"))
        if not result.accepted:
            raise HTTPException(status_code=409, detail={"signal_id": result.signal_id, "reason": result.reason})
        return {"accepted": True, "signal_id": result.signal_id, "backend": result.backend, "fill": result.fill}

    @app.post("/execution/cancel", dependencies=[Depends(require_api_key)])
    def cancel_intent(payload: dict):
        signal_id, backend_name = payload.get("signal_id"), payload.get("backend")
        if not signal_id or not backend_name:
            raise HTTPException(status_code=422, detail="signal_id and backend are required")
        try:
            fill = router.cancel(signal_id, backend_name)
        except RouterError as error:
            raise HTTPException(status_code=409, detail=str(error))
        return {"fill": fill.to_dict()}

    @app.get("/positions", dependencies=[Depends(require_api_key)])
    def positions():
        return {"positions": [p.to_dict() for p in portfolio.open_positions()]}

    @app.get("/orders", dependencies=[Depends(require_api_key)])
    def orders():
        return {"orders": store.orders()}

    @app.post("/reconcile", dependencies=[Depends(require_api_key)])
    def reconcile_now():
        result = _reconcile()
        control.record_reconcile(result)
        return result

    def _reconcile():
        # Only positions this service actually routed to Hummingbot belong in
        # this comparison. A position filled via NAUTILUS_NATIVE has no
        # reason to appear in Hummingbot's own position list -- that is not
        # a divergence, Nautilus is that fill's own canonical record. Found
        # by running the real forward loop (Part F): every real
        # NAUTILUS_NATIVE fill was tripping the kill switch as a false
        # "unknown position" the instant /reconcile ran, since it compared
        # ALL canonical positions against Hummingbot's regardless of which
        # backend actually executed them.
        canonical = [p.to_dict() for p in portfolio.open_positions() if p.backend == BACKEND_HUMMINGBOT]
        try:
            backend_positions = hummingbot.positions() if hummingbot else []
        except Exception as error:
            router.kill("RECONCILIATION_BACKEND_UNAVAILABLE")
            return {"reconciled": False, "error": f"HUMMINGBOT_POSITIONS_UNAVAILABLE: {error}", "orphan_orders": [],
                    "unknown_positions": [], "mismatched": [], "missing_fills": [], "halted": router.killed}
        result = reconcile(canonical, backend_positions, store=store)
        native = [p.to_dict() for p in portfolio.open_positions() if p.backend == BACKEND_NAUTILUS_NATIVE]
        ledger_check = paper.reconcile_ledger(native)
        reconciled = result.reconciled and ledger_check["reconciled"]
        if not reconciled:
            router.kill("RECONCILIATION_FAILED")
        return {
            "reconciled": reconciled, "orphan_orders": result.orphan_orders,
            "unknown_positions": result.unknown_positions, "mismatched": result.mismatched + ledger_check["mismatched"],
            "missing_fills": result.missing_fills, "halted": router.killed,
        }

    @app.post("/kill", dependencies=[Depends(require_api_key)])
    def kill(payload: dict):
        router.kill(payload.get("reason") or "MANUAL_KILL_SWITCH")
        return {"halted": True, "reason": store.active_halt()}

    # ---- persistent forward-paper session -----------------------------
    @app.post("/paper/signal", dependencies=[Depends(require_api_key)])
    def paper_signal(payload: dict):
        signal_payload, instrument = payload.get("signal"), payload.get("instrument")
        if not isinstance(signal_payload, dict) or not instrument:
            raise HTTPException(status_code=422, detail="signal and instrument are required")
        result = paper.open_from_signal(
            signal_payload, instrument, payload.get("mark_price"), payload.get("mark_at_ms"),
            requested_leverage=float(payload.get("requested_leverage") or 1.0),
            venue_preference=payload.get("venue_preference"), now_ms=payload.get("now_ms"), coin=payload.get("coin"),
            meta=payload.get("meta") if isinstance(payload.get("meta"), dict) else None,
        )
        return {"accepted": result.accepted, "signal_id": result.signal_id, "reason": result.reason, "trade": result.trade}

    @app.post("/paper/no-trade", dependencies=[Depends(require_api_key)])
    def paper_no_trade(payload: dict):
        paper.record_no_trade(payload.get("reason") or "NO_VALID_CANDIDATE", payload.get("detail"))
        return {"recorded": True}

    @app.get("/paper/open", dependencies=[Depends(require_api_key)])
    def paper_open():
        return {"trades": [{"trade_id": t["trade_id"], "instrument": t["instrument"], "asset": t["asset"], "coin": t.get("coin") or t["asset"],
                            "last_checked_ms": t["last_checked_ms"], "opened_at_ms": t["opened_at_ms"]}
                           for t in ledger.trades("OPEN")]}

    @app.post("/paper/mark", dependencies=[Depends(require_api_key)])
    def paper_mark(payload: dict):
        instrument, candles = payload.get("instrument"), payload.get("candles")
        if not instrument or not isinstance(candles, list):
            raise HTTPException(status_code=422, detail="instrument and candles are required")
        result = paper.mark(instrument, candles, now_ms=payload.get("now_ms"))
        return {"instrument": result.instrument, "exits": result.exits, "mark_price": result.mark_price, "skipped": result.skipped}

    @app.post("/paper/segment/start", dependencies=[Depends(require_api_key)])
    def segment_start(payload: dict):
        return {"segment_row": ledger.start_segment(payload.get("segment") or "unnamed")}

    @app.post("/paper/segment/end", dependencies=[Depends(require_api_key)])
    def segment_end(payload: dict):
        ledger.end_segment(int(payload["segment_row"]))
        return {"ended": True}

    @app.get("/paper/report", dependencies=[Depends(require_api_key)])
    def paper_report():
        return build_report(ledger, halted_reason=store.active_halt())

    # ---- desktop app: read-only views ---------------------------------
    # All derived from the ledger/store on every call; the app holds no
    # trading state of its own.
    @app.get("/paper/account", dependencies=[Depends(require_api_key)])
    def paper_account():
        totals = ledger.totals()
        account = current_account()
        peak = account.peak_equity or totals["equity"]
        return {**totals, "daily_pnl": account.daily_pnl, "peak_equity": peak,
                "total_pnl": totals["equity"] - totals["starting_equity"],
                "drawdown_pct": max(0.0, (peak - totals["equity"]) / peak * 100) if peak else 0.0,
                "exposure_pct": totals["open_notional"] / totals["equity"] * 100 if totals["equity"] else None,
                "effective_leverage": totals["open_notional"] / totals["equity"] if totals["equity"] else None,
                "execution_mode": "PAPER"}

    @app.get("/paper/positions", dependencies=[Depends(require_api_key)])
    def paper_positions():
        return {"positions": [position_view(t) for t in ledger.trades("OPEN")]}

    @app.get("/paper/trades", dependencies=[Depends(require_api_key)])
    def paper_trades():
        return {"trades": [trade_view(t) for t in reversed(ledger.trades())]}

    @app.get("/paper/signals", dependencies=[Depends(require_api_key)])
    def paper_signals(limit: int = 500):
        return {"signals": signal_rows(ledger, limit=max(1, min(limit, 5000)))}

    @app.get("/paper/performance", dependencies=[Depends(require_api_key)])
    def paper_performance():
        return build_performance(ledger, halted_reason=store.active_halt())

    @app.get("/risk/config", dependencies=[Depends(require_api_key)])
    def risk_config():
        return {"settings": control.settings(), "bounds": {k: list(v) for k, v in SETTINGS_BOUNDS.items()},
                "starting_equity": ledger.starting_equity(), "starting_equity_editable": not ledger.trades()}

    @app.put("/risk/config", dependencies=[Depends(require_api_key)])
    def update_risk_config(payload: dict):
        update = dict(payload or {})
        starting_equity = update.pop("starting_equity", None)
        if not update and starting_equity is None:
            raise HTTPException(status_code=422, detail="EMPTY_UPDATE")
        if starting_equity is not None:
            # Changing the account base after trades exist would rewrite every
            # historical return/drawdown figure, so it's only allowed on a
            # fresh session.
            if ledger.trades():
                raise HTTPException(status_code=409, detail="starting_equity: locked once the paper session has trades")
            if isinstance(starting_equity, bool) or not isinstance(starting_equity, (int, float)) or not (100 <= starting_equity <= 10_000_000):
                raise HTTPException(status_code=422, detail="starting_equity: must be a number in [100, 10000000]")
        try:
            settings = control.update_settings(update) if update else control.settings()
        except SettingsError as error:
            raise HTTPException(status_code=422, detail=str(error))
        if starting_equity is not None:
            with closing(sqlite3.connect(db_path)) as conn:
                conn.execute("UPDATE paper_account SET starting_equity = ? WHERE id = 1", (float(starting_equity),))
                conn.commit()
            control.audit("STARTING_EQUITY_UPDATED", {"starting_equity": float(starting_equity)})
        return {"settings": settings, "starting_equity": ledger.starting_equity()}

    @app.get("/risk/usage", dependencies=[Depends(require_api_key)])
    def risk_usage():
        limits, settings = control.risk_limits(), control.settings()
        account = current_account()
        open_trades = ledger.trades("OPEN")
        peak = account.peak_equity or account.equity
        max_open_risk_pct = max((t["risk_amount"] / account.equity * 100 for t in open_trades), default=0.0) if account.equity else None
        return {"usage": [
            {"key": "max_risk_per_trade_pct", "label": "Risk per trade", "current": max_open_risk_pct, "limit": limits.max_risk_per_trade_pct, "unit": "%"},
            {"key": "max_portfolio_exposure_pct", "label": "Total exposure", "current": account.open_notional / account.equity * 100 if account.equity else None,
             "limit": limits.max_portfolio_exposure_pct, "unit": "%"},
            {"key": "max_concurrent_positions", "label": "Concurrent positions", "current": account.open_positions, "limit": limits.max_concurrent_positions, "unit": ""},
            {"key": "leverage_ceiling", "label": "Leverage", "current": max((t["approved_leverage"] for t in open_trades), default=0.0),
             "limit": limits.leverage_ceiling, "unit": "x"},
            {"key": "daily_loss_limit_pct", "label": "Daily loss", "current": max(0.0, -account.daily_pnl / account.equity * 100) if account.equity else None,
             "limit": limits.daily_loss_limit_pct, "unit": "%"},
            {"key": "drawdown_limit_pct", "label": "Drawdown", "current": max(0.0, (peak - account.equity) / peak * 100) if peak else 0.0,
             "limit": limits.drawdown_limit_pct, "unit": "%"},
            {"key": "min_liquidation_buffer_pct", "label": "Liquidation buffer (min open)", "current": min((t["liquidation_buffer_pct"] for t in open_trades
             if t.get("liquidation_buffer_pct") is not None), default=None), "limit": limits.min_liquidation_buffer_pct, "unit": "%", "floor": True},
            {"key": "stale_data_timeout_s", "label": "Stale-data timeout (entry mid age)", "current": None, "limit": settings["stale_data_timeout_s"], "unit": "s"},
        ]}

    # ---- desktop app: controls ----------------------------------------
    @app.post("/control/pause", dependencies=[Depends(require_api_key)])
    def pause_entries(payload: dict = None):
        control.set_entries_paused(True, (payload or {}).get("reason") or "OPERATOR_PAUSE")
        return {"entries_paused": True}

    @app.post("/control/resume", dependencies=[Depends(require_api_key)])
    def resume_entries():
        control.set_entries_paused(False)
        return {"entries_paused": False, "halted": store.active_halt()}

    @app.post("/control/clear-halt", dependencies=[Depends(require_api_key)])
    def clear_halt(payload: dict):
        """Human-only: clears the kill switch, but only after a fresh
        reconciliation comes back clean. A failed reconciliation leaves the
        halt in place (and _reconcile re-engages it)."""
        if (payload or {}).get("confirm") != "CLEAR_HALT":
            raise HTTPException(status_code=422, detail="confirm must be CLEAR_HALT")
        previous = store.active_halt()
        result = _reconcile()
        control.record_reconcile(result)
        if not result["reconciled"]:
            raise HTTPException(status_code=409, detail={"reason": "RECONCILIATION_FAILED", "reconcile": result})
        store.clear_halts()
        router.killed = False
        control.audit("HALT_CLEARED", {"previous_reason": previous})
        return {"halted": None, "previous_reason": previous, "reconcile": result}

    @app.get("/system/status", dependencies=[Depends(require_api_key)])
    def system_status():
        try:
            import nautilus_trader
            nautilus = {"ok": True, "version": nautilus_trader.__version__,
                        "role": "canonical position/PnL bookkeeping on Nautilus value types (NautilusPortfolio)"}
        except Exception as error:  # pragma: no cover - import already succeeded at startup
            nautilus = {"ok": False, "error": str(error)}
        try:
            with closing(sqlite3.connect(db_path)) as conn:
                check = conn.execute("PRAGMA quick_check").fetchone()[0]
            sqlite = {"ok": check == "ok", "quick_check": check, "path": os.path.abspath(db_path),
                      "size_bytes": os.path.getsize(db_path) if os.path.exists(db_path) else 0}
        except Exception as error:
            sqlite = {"ok": False, "error": str(error), "path": os.path.abspath(db_path)}
        hb = {"mode": mode, "ok": mode == "disabled" or hummingbot is not None,
              "backend": getattr(hummingbot, "backend_name", None) if hummingbot else None}
        signals = signal_rows(ledger, limit=1)
        return {
            "paper_only": PAPER_ONLY, "execution_mode": "PAPER", "uptime_s": time.time() - started_at,
            "halted": store.active_halt(), "entries_paused": control.entries_paused(),
            "nautilus": nautilus, "sqlite": sqlite, "hummingbot": hb,
            "last_reconcile": control.last_reconcile(), "latest_signal": signals[0] if signals else None,
            "open_positions": len(ledger.trades("OPEN")), "segments": ledger.runtime_segments()[-5:],
            "control_audit": control.audit_log(20),
        }

    @app.post("/system/shutdown", dependencies=[Depends(require_api_key)])
    def shutdown():
        """Graceful stop for the desktop app's process manager. Every write
        in this service is its own committed SQLite transaction, so stopping
        between requests cannot leave a half-written position."""
        if app.state.request_shutdown is None:
            raise HTTPException(status_code=409, detail="SHUTDOWN_NOT_MANAGED")
        app.state.request_shutdown()
        return {"shutting_down": True}

    return app
