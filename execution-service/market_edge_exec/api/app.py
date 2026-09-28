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

from market_edge_exec import __version__
from market_edge_exec.buildinfo import build_info
from market_edge_exec.control.settings import BOUNDS as SETTINGS_BOUNDS, ControlStore, SettingsError
from market_edge_exec.domain.contracts import ContractError, ExecutionIntent
from market_edge_exec.hummingbot.factory import build_hummingbot_client
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.paper.candles import hyperliquid_fetcher, trade_candles
from market_edge_exec.paper.engine import PaperEngine
from market_edge_exec.paper.trade_detail import HINDSIGHT_FIELDS, build_trade_detail, monitor_status
from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.paper.performance import build_performance, position_view, signal_rows, trade_view
from market_edge_exec.paper.report import build_report
from market_edge_exec.persistence import migrations
from market_edge_exec.persistence.store import Store
from market_edge_exec.reconciliation.reconcile import reconcile
from market_edge_exec.risk.engine import RiskLimits, approve
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


def create_app(db_path: str = "market_edge_exec.sqlite3", hummingbot_mode: str = None,
               risk_limits: RiskLimits = None, candle_fetcher=None) -> FastAPI:
    """hummingbot_mode: 'disabled' (default: no Hummingbot backend at all),
    'real' (bridge must be reachable at startup) or 'mock' (tests only).
    There is no runtime fallback between them.
    risk_limits: None (default) applies the operator's persisted settings on
    top of RiskLimits() (the production policy: 1% risk, 5% per-position
    notional ceiling, 20% aggregate, 4 concurrent). Tests pass a wider
    RiskLimits() to isolate lifecycle mechanics from sizing."""
    app = FastAPI(title="Market Edge Execution Service (paper-only)", version=__version__)
    # Refuses a database from a newer build, and backs up an older one
    # before anything (including the stores' CREATE TABLE IF NOT EXISTS)
    # touches it. Raises MigrationError; never wipes.
    migration = migrations.prepare(db_path)
    store = Store(db_path)
    portfolio = NautilusPortfolio(store)
    mode = hummingbot_mode or os.environ.get("HUMMINGBOT_MODE", "disabled")
    hummingbot = None if mode == "disabled" else build_hummingbot_client(mode)
    ledger = PaperLedger(db_path)
    control = ControlStore(db_path)
    migration = migrations.apply(migration)
    limits_provider = (lambda: risk_limits) if risk_limits is not None else control.risk_limits

    # Account state is re-derived from the persistent ledger on every call.
    # It used to be one AccountState built at startup and never updated, so
    # risk limits never saw open trades.
    def current_account():
        return ledger.account_state(killed=router.killed)

    def risk_gate(intent: ExecutionIntent):
        return approve(intent, current_account(), limits_provider()).decision

    router = ExecutionRouter(
        store=store, risk_gate=risk_gate,
        backends={BACKEND_NAUTILUS_NATIVE: PaperBackendAdapter(portfolio, BACKEND_NAUTILUS_NATIVE),
                  **({BACKEND_HUMMINGBOT: hummingbot} if hummingbot else {})},
    )
    paper = PaperEngine(ledger, router, store, portfolio=portfolio, limits_provider=limits_provider,
                        entries_gate=lambda: "ENTRIES_PAUSED" if control.entries_paused() else None,
                        max_mark_age_provider=control.stale_data_timeout_s)
    app.state.store, app.state.portfolio, app.state.hummingbot, app.state.router = store, portfolio, hummingbot, router
    app.state.ledger, app.state.paper, app.state.control = ledger, paper, control
    app.state.migration = migration
    app.state.candle_fetcher = candle_fetcher or hyperliquid_fetcher()
    # Latest heartbeat from the open-position monitor (runtime only; the
    # per-position state it produces is persisted on the trades themselves).
    app.state.monitor = {"state": "NOT_REPORTED", "at_ms": None}
    app.state.request_shutdown = None  # set by run_server.py when it owns the uvicorn server
    started_at = time.time()

    def require_api_key(x_api_key: str = Header(default=None)):
        expected = os.environ.get("MARKET_EDGE_EXEC_API_KEY")
        if not expected or x_api_key != expected:
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    @app.get("/health")
    def health():
        return {"status": "ok", "paper_only": PAPER_ONLY, "killed": router.killed, "hummingbot_mode": mode,
                "version": __version__, "schema_version": migration.to_version, "build": build_info()}

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
            market_price_source=payload.get("market_price_source") or "UNKNOWN",
        )
        return {"accepted": result.accepted, "signal_id": result.signal_id, "reason": result.reason, "trade": result.trade}

    @app.post("/paper/no-trade", dependencies=[Depends(require_api_key)])
    def paper_no_trade(payload: dict):
        paper.record_no_trade(payload.get("reason") or "NO_VALID_CANDIDATE", payload.get("detail"))
        return {"recorded": True}

    @app.get("/paper/open", dependencies=[Depends(require_api_key)])
    def paper_open():
        # Geometry is included so the monitor can spot a level crossing on
        # the exchange stream and post it at once; evaluation stays here.
        return {"trades": [{"trade_id": t["trade_id"], "instrument": t["instrument"], "asset": t["asset"], "coin": t.get("coin") or t["asset"],
                            "last_checked_ms": t["last_checked_ms"], "opened_at_ms": t["opened_at_ms"],
                            "direction": t["direction"], "entry_fill": t["entry_fill"], "stop": t["stop"], "tp1": t["tp1"],
                            "tp2": t["tp2"], "tp1_hit": t["tp1_hit"], "remaining_qty": t["remaining_qty"]}
                           for t in ledger.trades("OPEN")]}

    # ---- open-position monitor (signal-bridge/position_monitor.mjs) ------
    @app.post("/paper/tick", dependencies=[Depends(require_api_key)])
    def paper_tick(payload: dict):
        """One real observed price for one open position. Evaluates ONLY
        stop/TP1/TP2/timeout; this endpoint can never open a trade."""
        instrument = payload.get("instrument")
        if not instrument or not payload.get("source"):
            raise HTTPException(status_code=422, detail="instrument and source are required")
        result = paper.tick(instrument, payload.get("price"), payload.get("at_ms"), payload["source"],
                            trigger=payload.get("trigger") or "POLL_HEARTBEAT", observed_high=payload.get("observed_high"),
                            observed_low=payload.get("observed_low"), now_ms=payload.get("now_ms"))
        return {"instrument": result.instrument, "exits": result.exits, "price": result.price, "skipped": result.skipped,
                "monitor_status": result.monitor_status}

    @app.post("/paper/monitor/heartbeat", dependencies=[Depends(require_api_key)])
    def monitor_heartbeat(payload: dict):
        payload = dict(payload or {})
        offline = [i for i in payload.get("offline_instruments") or [] if isinstance(i, str)]
        if offline:
            paper.set_monitor_offline(offline, str(payload.get("error") or "no live price from the monitor's market data source"))
        app.state.monitor = {**payload, "received_at_ms": int(time.time() * 1000)}
        return {"recorded": True, "flagged_offline": len(offline)}

    def _monitor_summary(now_ms: int) -> dict:
        max_age = paper.monitor_max_price_age_s()
        open_trades = ledger.trades("OPEN")
        statuses = [monitor_status(t, now_ms, max_age)["status"] for t in open_trades]
        # A position that just opened is AWAITING_PRICE for a few seconds;
        # it only counts as unmonitored once it has waited past the limit.
        stale = sum(1 for t, s in zip(open_trades, statuses)
                    if s in ("STALE", "MARKET_DATA_OFFLINE") or (s == "AWAITING_PRICE" and (now_ms - t["opened_at_ms"]) / 1000 > max_age))
        return {**app.state.monitor, "open_positions": len(statuses), "max_price_age_s": max_age,
                "stale_positions": stale, "position_statuses": statuses}

    @app.get("/paper/monitor", dependencies=[Depends(require_api_key)])
    def monitor_view():
        return _monitor_summary(int(time.time() * 1000))

    # ---- desktop app: trade detail --------------------------------------
    def _trade_or_404(trade_id: str) -> dict:
        trade = ledger.trade(trade_id) if trade_id else None
        if trade is None:
            raise HTTPException(status_code=404, detail="TRADE_NOT_FOUND")
        return trade

    @app.get("/paper/trade", dependencies=[Depends(require_api_key)])
    def trade_detail(trade_id: str):
        now_ms = int(time.time() * 1000)
        return build_trade_detail(ledger, _trade_or_404(trade_id), now_ms, paper.monitor_max_price_age_s())

    @app.get("/paper/trade/candles", dependencies=[Depends(require_api_key)])
    def trade_chart_candles(trade_id: str, interval: str = "5m"):
        return trade_candles(_trade_or_404(trade_id), interval, int(time.time() * 1000), app.state.candle_fetcher)

    @app.post("/paper/hindsight", dependencies=[Depends(require_api_key)])
    def record_hindsight(payload: dict):
        """Research overlay input: post-outcome labels for a RESOLVED trade.
        Stored apart from the trade and never merged into it."""
        payload = payload or {}
        trade = _trade_or_404(payload.get("trade_id"))
        if trade["status"] != "CLOSED":
            raise HTTPException(status_code=409, detail="OUTCOME_NOT_RESOLVED: hindsight labels are accepted only for closed trades")
        labels = payload.get("labels") if isinstance(payload.get("labels"), dict) else {}
        clean = {k: labels[k] for k in HINDSIGHT_FIELDS if isinstance(labels.get(k), (int, float)) and not isinstance(labels.get(k), bool)}
        if not clean:
            raise HTTPException(status_code=422, detail=f"labels must include at least one of {list(HINDSIGHT_FIELDS)}")
        ledger.record_hindsight(trade["trade_id"], int(payload.get("resolved_at_ms") or time.time() * 1000),
                                str(payload.get("source") or "UNSPECIFIED"), clean)
        return {"recorded": True, "trade_id": trade["trade_id"], "labels": clean}

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
        now_ms, max_age = int(time.time() * 1000), paper.monitor_max_price_age_s()
        return {"positions": [position_view(t, now_ms, max_age) for t in ledger.trades("OPEN")]}

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
        payload = payload or {}
        changed = control.set_entries_paused(True, payload.get("reason") or "OPERATOR_PAUSE",
                                             only_if_unpaused=bool(payload.get("only_if_unpaused")))
        return {"entries_paused": True, "paused": changed, "entries_paused_reason": control.entries_paused_reason()}

    @app.post("/control/resume", dependencies=[Depends(require_api_key)])
    def resume_entries(payload: dict = None):
        only_if = (payload or {}).get("only_if_reason")
        changed = control.set_entries_paused(False, (payload or {}).get("reason"), only_if_reason=only_if)
        return {"entries_paused": control.entries_paused(), "entries_paused_reason": control.entries_paused_reason(),
                "resumed": changed, "halted": store.active_halt()}

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
            "entries_paused_reason": control.entries_paused_reason(),
            "nautilus": nautilus, "sqlite": sqlite, "hummingbot": hb,
            "last_reconcile": control.last_reconcile(), "latest_signal": signals[0] if signals else None,
            "open_positions": len(ledger.trades("OPEN")), "segments": ledger.runtime_segments()[-5:],
            "position_monitor": _monitor_summary(int(time.time() * 1000)),
            "control_audit": control.audit_log(20),
            "version": __version__, "build": build_info(), "migration": migration.to_dict(),
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
