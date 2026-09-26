# Hummingbot bridge service (paper/testnet only)

Status (Phase 4, 2026-09-26, CI run 36235564843): **actually brought up
with real Docker** in a clean GitHub Actions runner (`hummingbot-docker`
job in `.github/workflows/execution-stack-ci.yml`) -- this sandboxed dev
session still has no Docker daemon, but CI does. `docker compose up -d`
starts the real `hummingbot/hummingbot:latest` image and this bridge for
real. The bridge container itself comes up healthy and answers
`GET /health`. It correctly reports `{"status": "hummingbot_unreachable"}`
though -- see "Architecture correction" below for why that is expected
with the current bridge code, not a Docker/CI problem.

## Architecture correction: Gateway is DEX-only -- CEX control needs the Hummingbot API, not Gateway

This bridge's `bridge/hummingbot_gateway.py` was written against an
**unverified assumption**, flagged as such in its own docstring at the
time: that Hummingbot exposes a REST "Gateway" API for order/position
control that this bridge could call directly. Phase 4 research
(hummingbot.org docs, 2026-09-26) confirms that assumption was wrong for
our use case:

- **Gateway** (`hummingbot/gateway`, port 15888) is middleware for **DEX/AMM
  connectors only** (on-chain swaps, LP positions). It has nothing to do
  with centralized exchanges like Binance.
- The officially documented way to control Hummingbot bots
  programmatically -- including CEX perpetuals like Binance Futures -- is
  the separate **Hummingbot API** project
  (https://hummingbot.org/hummingbot-api/): a FastAPI server (port 8000)
  backed by PostgreSQL (orders/balances/performance) and an EMQX MQTT
  broker (bot orchestration), deployed via
  `hummingbot/deploy`'s official docker-compose stack
  (`hummingbot-api` + `hummingbot-postgres` + `hummingbot-broker`
  containers). It documents CEX support (Binance named explicitly) and
  REST routers for trading operations, portfolio/position management, and
  bot deploy/start/stop, with interactive docs at `/docs`.

This explains the CI result precisely: our bridge dialed a Gateway URL
(`http://hummingbot:15888`) that the official `hummingbot/hummingbot`
image never listens on for CEX use, so `hummingbot_unreachable` is the
bridge correctly detecting a wrong target, not a flaky container.

**Next concrete step** (unblocked, no credentials needed): replace this
directory's compose stack with the official `hummingbot/deploy
--hummingbot-api` stack (postgres + EMQX + hummingbot-api containers),
bring it up for real in CI, read its live `/openapi.json` to get the exact
verified request/response contract (not guessed), and rewrite
`bridge/hummingbot_gateway.py` against that real contract instead of the
assumed Gateway shape. `HummingbotExecutionClientReal`'s interface
(`execution-service/market_edge_exec/hummingbot/real_client.py`) does not
need to change -- only what this bridge calls on the other side of it.

## Why a separate service

Hummingbot's own dependency tree (a cython-built core, per-exchange
connectors, TA-Lib, etc.) did not finish `pip install` dependency
resolution within a 180-second budget when tried directly inside
`execution-service/`'s virtualenv. Per instruction, it runs as its own
container instead: `docker-compose.yml` here runs Hummingbot in one
container (using Hummingbot's own official Docker image,
`hummingbot/hummingbot`) and this bridge in a second, small container that
only depends on `fastapi`/`httpx`.

## What's here

```
hummingbot-service/
  Dockerfile           builds the bridge (NOT Hummingbot itself -- that
                        comes from the official hummingbot/hummingbot image)
  docker-compose.yml    two services: hummingbot (official image, paper
                        trading mode) + bridge (this package)
  config/
    conf_client.yml     Hummingbot client config: paper_trade_enabled: true
    conf_paper_trade.yml  paper account starting balances
  bridge/
    app.py              FastAPI app implementing the narrow bridge API
    hummingbot_gateway.py   translates bridge calls to Hummingbot's own
                        Gateway/REST API (https://hummingbot.org/gateway/)
  tests/
    test_bridge_contract.py  tests the bridge's request/response shapes
                        against a FAKE Hummingbot Gateway (not the real one)
```

## Bridge API (as required)

`POST /orders`, `DELETE /orders/{id}`, `PATCH /orders/{id}` (where
supported -- Hummingbot's perpetual connectors generally do not support
amend, so this returns 501 unless the underlying connector does),
`GET /orders`, `GET /positions`, `GET /balances`, `GET /health`. Every
response includes `signal_id` (as `client_order_id`), `instrument`,
`backend_order_id`, and `timestamp`, matching
`execution-service/market_edge_exec/hummingbot/real_client.py`'s
expectations exactly -- that client and this bridge were written against
the same contract, so no translation layer sits between them.

## Paper only

`config/conf_client.yml` hard-codes `paper_trade_enabled: true`. No mainnet
API key belongs in this directory or its config files -- venue credentials
(once a testnet is chosen and Jakob supplies them via project settings,
never pasted in chat) are testnet-only and passed as environment variables
to the `hummingbot` container, never committed.

## How to actually run this (on a machine with Docker)

```
cd hummingbot-service
cp config/conf_client.yml.example config/conf_client.yml   # if you keep secrets out of git
docker compose up --build
curl localhost:8090/health   # the bridge
```

## Honesty note

The containers now really run in CI (confirmed via `docker compose ps`
showing both `Up`/`running`, and the bridge's own `/health` endpoint really
answering over HTTP). What has NOT been proven: Hummingbot itself placing
or filling an order, because the bridge is currently wired to the wrong
API surface (see "Architecture correction" above) -- `hummingbot_unreachable`
is the bridge honestly reporting that, not a fabricated pass. The bridge's
own request/response logic (`bridge/app.py`, `bridge/hummingbot_gateway.py`)
is tested against a fake Gateway server in `tests/test_bridge_contract.py`,
which proves the bridge's HTTP contract is internally consistent -- it does
not, and was never claimed to, prove a real fill.
