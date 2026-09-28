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

## NautilusTrader — RESOLVED for real in CI: Python 3.12 runs the real BacktestEngine

**Phase 4 finding (2026-09-26, GitHub Actions run 36235564843, clean
`ubuntu-latest` runner, not this sandbox):** the native crash
(`double free or corruption (out)`) is specific to the `nautilus_trader`
build that installs on **Python 3.11** (resolves to `1.221.0`). On
**Python 3.12**, pip resolves a newer `nautilus_trader==1.231.0` with
`numpy==2.5.3`, and the crash **does not occur**. The real `BacktestEngine`
(genuine `SimulatedExchange`/`OrderMatchingEngine`/`Portfolio`/`Cache`, not
a substitute) ran a full BTC/ETH scenario for real:
BTC perpetual long entry (market, filled), ETH perpetual short entry
(market, filled), a resting limit order (submitted then cancelled --
`CANCELED` status confirmed from `engine.cache`), and reduce-only exits on
both instruments, ending with net position `0.0` on both BTC and ETH and
the account's PnL reflected in `account_balances`
(`1000001.63108200 USDT` off the `1,000,000` starting balance). 5 orders
total, 4 filled, 2 positions closed. Full report:
`diagnostics/real_backtest_scenarios.py`, output artifact
`nautilus-report-py3.12/real_backtest_scenarios.json`.

**Frozen environment for this stack going forward:**
`ubuntu-latest` (GitHub Actions), **Python 3.12.14**,
**nautilus_trader 1.231.0**, **numpy 2.5.3**. Python 3.11 is NOT used for
this stack -- it still reproduces the native crash in the same clean
runner (see `diagnostics/backtest_engine_crash_repro.py`, run via
`.github/workflows/execution-stack-ci.yml`'s `nautilus-matrix` job, which
keeps both versions in the matrix specifically so this doesn't silently
regress).

The original sandboxed dev session (this repo's earlier Phase 3 work) ran
an older `nautilus_trader==1.221.0` and could not get past the crash
locally -- that observation stands for that specific container, but is now
superseded operationally: **the frozen, working environment is Python
3.12 in a clean container**, validated by real CI runs, not the sandbox.

Given the crash is Python-3.11-specific rather than universal, the
Phase-2 `NautilusPortfolio` bookkeeping backend (SQLite-backed, using real
Nautilus value types) remains available as a fallback/comparison path, but
is no longer the only working route -- the real `BacktestEngine` is now
the primary paper-execution engine on the frozen environment. Next: wire
`nautilus_trader.live.node.TradingNode` (or keep using `BacktestEngine`
fed live/replayed bars) behind the same `ExecutionIntent` contract for the
forward paper loop (see Part E/F of the overnight work order in project
memory).

## Hummingbot — real bridge code written, MOCK still the default (Phase 3); see hummingbot-service/README.md for a Phase 4 architecture correction

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
