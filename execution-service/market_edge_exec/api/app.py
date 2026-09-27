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

from fastapi import Depends, FastAPI, Header, HTTPException

from market_edge_exec.domain.contracts import ContractError, ExecutionIntent
from market_edge_exec.hummingbot.factory import build_hummingbot_client
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.paper.engine import PaperEngine
from market_edge_exec.paper.ledger import PaperLedger
from market_edge_exec.paper.report import build_report
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
               risk_limits: RiskLimits = None) -> FastAPI:
    """hummingbot_mode: 'disabled' (default: no Hummingbot backend at all),
    'real' (bridge must be reachable at startup) or 'mock' (tests only).
    There is no runtime fallback between them.
    risk_limits: defaults to RiskLimits() (the production policy: 1% risk,
    5% per-position notional ceiling, 20% aggregate, 4 concurrent). Tests
    pass a wider RiskLimits() to isolate lifecycle mechanics from sizing."""
    app = FastAPI(title="Market Edge Execution Service (paper-only)")
    store = Store(db_path)
    portfolio = NautilusPortfolio(store)
    mode = hummingbot_mode or os.environ.get("HUMMINGBOT_MODE", "disabled")
    hummingbot = None if mode == "disabled" else build_hummingbot_client(mode)
    ledger = PaperLedger(db_path)
    limits = risk_limits or RiskLimits()

    # Account state is re-derived from the persistent ledger on every call.
    # It used to be one AccountState built at startup and never updated, so
    # risk limits never saw open trades.
    def current_account():
        return ledger.account_state(killed=router.killed)

    def risk_gate(intent: ExecutionIntent):
        return approve(intent, current_account(), limits).decision

    router = ExecutionRouter(
        store=store, risk_gate=risk_gate,
        backends={BACKEND_NAUTILUS_NATIVE: PaperBackendAdapter(portfolio, BACKEND_NAUTILUS_NATIVE),
                  **({BACKEND_HUMMINGBOT: hummingbot} if hummingbot else {})},
    )
    paper = PaperEngine(ledger, router, store, limits=limits, portfolio=portfolio)
    app.state.store, app.state.portfolio, app.state.hummingbot, app.state.router = store, portfolio, hummingbot, router
    app.state.ledger, app.state.paper = ledger, paper

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

    return app
