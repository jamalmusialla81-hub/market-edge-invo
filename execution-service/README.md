# Market Edge Execution Service (Phase 2 — real Python service, paper-only)

Separate Python service. Nothing here is imported by, or imports, the
Node/Cloudflare production path (`quant-engine.js`, `replay-engine.js`,
`backend/`, `customer-beta/`, the customer UI, auth, RLS, or the journal).
Paper/sandbox only — there is no live-trading endpoint, no exchange
credential ever passes through this service, and `PAPER_ONLY = True` is
hard-coded in `market_edge_exec/api/app.py`, not env-configurable.

## Structure

```
execution-service/
  pyproject.toml
  market_edge_exec/
    domain/         AlphaSignal, RiskDecision, PortfolioDecision, ExecutionIntent,
                     ExecutionFill, PositionSnapshot — JS-parity dataclasses
                     with schema/version fields
    nautilus/        NautilusPortfolio: canonical position/PnL owner
    hummingbot/      HummingbotExecutionClient — see "Hummingbot" below
    risk/            hard risk gates, run before any routing
    routing/         ExecutionRouter (Python mirror of the JS router)
    reconciliation/  read-only canonical-vs-backend comparison
    persistence/     SQLite store; this is where idempotency actually lives
    api/             FastAPI app: /execution/intent, /execution/cancel,
                     /positions, /orders, /health, /reconcile
    telemetry/       structured JSON-lines event logging
  tests/             32 tests, pytest
```

## Install & run

```
cd execution-service
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
export MARKET_EDGE_EXEC_API_KEY=<pick one>
python -m pytest -q
uvicorn market_edge_exec.api.app:create_app --factory --reload
```

## NautilusTrader — installed for real, engine blocked by a native crash

`nautilus_trader==1.221.0` installs from a prebuilt wheel and is imported
for real: `nautilus/portfolio.py` round-trips every instrument id, side,
quantity, and price through Nautilus's own `InstrumentId`/`OrderSide`/
`Quantity`/`Price` types before this service's `NautilusPortfolio` class
records the position.

**Phase 3 attempted to replace this with Nautilus's own `BacktestEngine`
(real `SimulatedExchange`/`OrderMatchingEngine`/`Portfolio`/`Cache` matching
engine) and hit a reproducible native crash**: `engine.run()` aborts with
`double free or corruption (out)` -- a C-level memory error, not a Python
exception -- in this container. This was isolated to the engine itself, not
application code: it reproduces with the official
`TestInstrumentProvider.btcusdt_perp_binance()` stub instrument, with zero
strategies attached, with a market order, with a non-filling resting limit
order, and with both numpy>=2 and numpy<2. See
`diagnostics/backtest_engine_crash_repro.py` for the minimal repro (a
venue + one instrument + one bar + `run()`, no strategy at all). This
points at a build/ABI incompatibility between this prebuilt wheel and this
container (most likely glibc or another native library version), not
something fixable from Python-level code in this session.

Given that, canonical position/PnL bookkeeping in this pass remains
`NautilusPortfolio` (Phase 2's approach), backed by SQLite and using real
Nautilus value types for every field -- genuinely the "system of record"
role, just not yet running inside Nautilus's own matching engine. The
`live.node.TradingNode` + a real venue adapter (see `VENUE_DECISION.md`) is
the next attempt, in an environment where this crash can first be
root-caused or worked around (e.g. building nautilus_trader from source
against this container's actual system libraries, or running in a
container image closer to what the wheel was built for).

## Hummingbot — real bridge code written, MOCK still the default (Phase 3)

`pip install hummingbot` was attempted again in Phase 3 with the same
result: dependency resolution alone did not finish within a 180-second
budget. Per instruction, Hummingbot now runs as its own service
(`../hummingbot-service/`, Dockerfile + docker-compose.yml + a narrow FastAPI
bridge) instead of being pip-installed here. `hummingbot/real_client.py`
(`HummingbotExecutionClientReal`) makes real HTTP calls to that bridge and
reports backend `HUMMINGBOT` (only this class may use that name).
`hummingbot/mock_client.py` (`HummingbotExecutionClient`, backend name
`HUMMINGBOT_MOCK`) is unchanged and still available. `hummingbot/factory.py`
picks one explicitly by `mode` ("mock" or "real") and **never falls back
from real to mock** -- asking for "real" without a reachable bridge raises
immediately.

Honesty note: `../hummingbot-service/` has not been built or run in this
environment (no Docker daemon is reachable here -- `docker version` finds
only the CLI). Its bridge logic is tested against a fake Gateway server
(`hummingbot-service/tests/test_bridge_contract.py`), and
`HummingbotExecutionClientReal` is tested against a fake bridge
(`tests/test_hummingbot_real_client.py`) -- both prove the HTTP contracts
are internally consistent, neither proves a real Hummingbot instance fills
a real (paper) order yet.

## Idempotency

`signal_id` is the primary key of the `intents` SQLite table
(`persistence/store.py`). A duplicate route attempt hits a UNIQUE
constraint violation and is rejected before any backend is touched — and
because the check is a DB constraint rather than an in-memory set, it holds
across a process restart (see `tests/test_router_and_persistence.py::
test_duplicate_signal_is_still_blocked_after_a_simulated_restart`, which
opens a fresh `Store`/`ExecutionRouter` against the same file and confirms
the duplicate is still caught).

## Reconciliation

`reconciliation/reconcile.py` compares canonical (Nautilus-side) positions
against a backend's reported positions and expected vs. recorded fills. It
never resolves a divergence automatically — `POST /reconcile` in the API
engages the router's kill switch the moment `reconciled` comes back false,
so no new intent is accepted until a human clears it.

## JS ↔ Python contract parity

`tests/test_js_python_parity.py` loads `tests/fixtures/js_contracts.json`
(generated by calling the actual JS factory functions in
`../research/execution-architecture/domain-objects.js` — see that file's
comment block for the exact Node snippet) and asserts every field name and
value survives `Python.create(js_payload).to_dict()` unchanged, plus that
each Python contract carries `schema`/`version` fields the JS side can
check for drift. No field is renamed between the two languages.

## Test count

32 tests, all passing, covering (numbering matches the 15 requested):
1. JS/Python contract round-trip — `test_js_python_parity.py`
2. one signal -> one order — `test_router_and_persistence.py`
3. duplicate signal blocked — same file
4. duplicate still blocked after restart — same file
5. risk rejection prevents backend call — same file
6. leverage ceiling enforced — same file (router) + `test_risk_engine.py` (engine)
7. partial fill updates position correctly — `test_router_and_persistence.py`
8. cancel reconciles — `test_reconciliation.py`
9. reject reconciles — same file (via missing-fill detection)
10. orphan order detected — same file
11. unknown position detected — same file
12. quantity mismatch detected — same file
13. restart restores persisted positions — `test_router_and_persistence.py`
14. backend disconnect / divergence causes safe halt — `test_api.py`
15. kill switch blocks new intents — `test_router_and_persistence.py` + `test_risk_engine.py`

## Transport

FastAPI, `X-API-Key` header required on every non-health endpoint (checked
against `MARKET_EDGE_EXEC_API_KEY`; unset means every call is rejected, not
silently allowed). No exchange secrets pass through the API — this service
would hold them once a real backend exists, and the API only ever carries
the domain-contract JSON shapes.

## Next step

1. Wire a real `nautilus_trader.live.node.TradingNode` (or
   `backtest.engine.BacktestEngine` for a pure paper loop) behind
   `NautilusPortfolio`, replacing this pass's own fill/PnL bookkeeping with
   Nautilus's actual matching engine and message bus.
2. Replace `hummingbot/mock_client.py` with a real Hummingbot gateway
   process talking the same `HummingbotExecutionClient` interface — likely
   as its own containerized service given its dependency weight, called
   over HTTP rather than pip-installed alongside this package.
3. Run the "first prototype" side-by-side comparison (fill semantics,
   latency, fees, slippage) once both backends are real — two identical
   paper ledgers, which is what exists today, can't produce a meaningful
   comparison.
