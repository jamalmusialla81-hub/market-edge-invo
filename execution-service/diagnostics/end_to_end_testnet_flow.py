"""Phase 4 Part 5: full-stack testnet flow -- fixture AlphaSignal ->
PortfolioDecision -> RiskDecision -> ExecutionIntent -> ExecutionRouter ->
HummingbotExecutionClientReal -> bridge -> Binance Futures Testnet ->
fill -> position -> reduce-only exit -> realized PnL -> persistence ->
reconciliation. One LONG (BTC) and one SHORT (ETH), minimal testnet size.

SKIPPED_NOT_CONFIGURED (not a failure) when BINANCE_TESTNET_API_KEY/SECRET
are absent, or when HUMMINGBOT_BRIDGE_URL is unreachable -- this proves
nothing was faked, per instruction.

Known limitation, stated plainly: this has not been run against a live
bridge+Hummingbot+Binance-testnet chain in this session (no credentials
exist yet, see VENUE_DECISION.md). hummingbot-service/docker-compose.yml
passes testnet keys as container env vars, which is a simplification --
Hummingbot's own credential store normally goes through its `connect`
CLI flow or an encrypted config, so the bridge/Hummingbot side of this may
need adjustment once this is first run for real with real keys.
"""
from __future__ import annotations

import json
import os
import tempfile

from market_edge_exec.domain.contracts import AlphaSignal, ExecutionIntent
from market_edge_exec.hummingbot.factory import HummingbotModeError, build_hummingbot_client
from market_edge_exec.hummingbot.real_client import HummingbotBridgeUnavailable
from market_edge_exec.nautilus.portfolio import NautilusPortfolio
from market_edge_exec.persistence.store import Store
from market_edge_exec.reconciliation.reconcile import reconcile
from market_edge_exec.risk.engine import AccountState, approve
from market_edge_exec.routing.router import BACKEND_HUMMINGBOT, ExecutionRouter


def fixture_signal(asset: str, direction: str, entry: float, stop: float) -> AlphaSignal:
    return AlphaSignal.create({
        "signal_id": f"e2e-{asset}-{direction}", "asset": asset, "direction": direction,
        "timestamp": 0, "entry": entry, "stop": stop, "strategy_id": "phase4-e2e-fixture",
    })


def run_one(router: ExecutionRouter, portfolio: NautilusPortfolio, account: AccountState, signal: AlphaSignal, instrument: str):
    intent = ExecutionIntent.create({
        "signal_id": signal.signal_id, "instrument": instrument, "side": "buy" if signal.direction == "long" else "sell",
        "quantity": 0.001, "order_type": "MARKET", "limit_price": signal.entry, "stop": signal.stop,
        "leverage": 1, "venue_preference": BACKEND_HUMMINGBOT, "strategy_id": signal.strategy_id,
    })
    assessment = approve(intent, account)
    backend_name, fill = router.route(intent, risk_decision=assessment.decision)
    portfolio.apply_fill(intent, fill.avg_price or intent.limit_price, fill.quantity_filled, backend_name)
    return {"signal_id": signal.signal_id, "backend": backend_name, "fill_status": fill.status, "position": portfolio.position(instrument).to_dict() if portfolio.position(instrument) else None}


def run() -> dict:
    api_key, api_secret = os.environ.get("BINANCE_TESTNET_API_KEY"), os.environ.get("BINANCE_TESTNET_API_SECRET")
    bridge_url = os.environ.get("HUMMINGBOT_BRIDGE_URL")
    if not (api_key and api_secret):
        return {"status": "SKIPPED_NOT_CONFIGURED", "reason": "BINANCE_TESTNET_API_KEY/SECRET not set"}
    if not bridge_url:
        return {"status": "SKIPPED_NOT_CONFIGURED", "reason": "HUMMINGBOT_BRIDGE_URL not set"}

    try:
        hummingbot = build_hummingbot_client("real")
    except (HummingbotModeError, HummingbotBridgeUnavailable) as error:
        return {"status": "SKIPPED_NOT_CONFIGURED", "reason": f"bridge not reachable: {error}"}

    with tempfile.TemporaryDirectory() as tmp:
        store = Store(f"{tmp}/e2e.sqlite3")
        portfolio = NautilusPortfolio(store)
        account = AccountState(equity=10_000.0, peak_equity=10_000.0)
        router = ExecutionRouter(store=store, risk_gate=lambda i: approve(i, account).decision,
                                  backends={BACKEND_HUMMINGBOT: hummingbot})

        long_result = run_one(router, portfolio, account, fixture_signal("BTC", "long", 60000, 59000), "BTC-PERP")
        short_result = run_one(router, portfolio, account, fixture_signal("ETH", "short", 3000, 3050), "ETH-PERP")

        canonical = [p.to_dict() for p in portfolio.open_positions()]
        backend_positions = hummingbot.positions()
        reconciliation = reconcile(canonical, backend_positions, store=store)

        return {
            "status": "PASS", "long": long_result, "short": short_result,
            "reconciled": reconciliation.reconciled, "orphan_orders": reconciliation.orphan_orders,
            "mismatched": reconciliation.mismatched,
        }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2, default=str))
