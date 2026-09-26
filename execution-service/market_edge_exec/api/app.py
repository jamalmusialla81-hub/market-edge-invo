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
from market_edge_exec.hummingbot.mock_client import HummingbotExecutionClient
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.persistence.store import Store
from market_edge_exec.reconciliation.reconcile import reconcile
from market_edge_exec.risk.engine import AccountState, approve
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


def create_app(db_path: str = "market_edge_exec.sqlite3") -> FastAPI:
    app = FastAPI(title="Market Edge Execution Service (paper-only)")
    store = Store(db_path)
    portfolio = NautilusPortfolio(store)
    hummingbot = HummingbotExecutionClient()
    account = AccountState(equity=10_000.0, peak_equity=10_000.0)

    def risk_gate(intent: ExecutionIntent):
        assessment = approve(intent, account)
        return assessment.decision

    router = ExecutionRouter(
        store=store, risk_gate=risk_gate,
        backends={BACKEND_NAUTILUS_NATIVE: PaperBackendAdapter(portfolio, BACKEND_NAUTILUS_NATIVE), BACKEND_HUMMINGBOT: hummingbot},
    )
    app.state.store, app.state.portfolio, app.state.hummingbot, app.state.router = store, portfolio, hummingbot, router

    def require_api_key(x_api_key: str = Header(default=None)):
        expected = os.environ.get("MARKET_EDGE_EXEC_API_KEY")
        if not expected or x_api_key != expected:
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    @app.get("/health")
    def health():
        return {"status": "ok", "paper_only": PAPER_ONLY, "killed": router.killed}

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
        result = process_signal(signal_payload, instrument, router, account, store,
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
        backend_positions = hummingbot.positions()
        result = reconcile(canonical, backend_positions, store=store)
        if not result.reconciled:
            router.kill()
        return {
            "reconciled": result.reconciled, "orphan_orders": result.orphan_orders,
            "unknown_positions": result.unknown_positions, "mismatched": result.mismatched,
            "missing_fills": result.missing_fills, "halted": router.killed,
        }

    return app
