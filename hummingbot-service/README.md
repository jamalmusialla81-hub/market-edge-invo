# Hummingbot bridge service (paper/testnet only)

Status (2026-09-26): the compose stack and bridge now target the **real
Hummingbot API project** (hummingbot.org/hummingbot-api/), not Gateway --
see "Architecture correction" below for why the earlier version was wrong
and how this was found. CI (`hummingbot-docker` job in
`.github/workflows/execution-stack-ci.yml`) brings up the real
`postgres` + `emqx` + `hummingbot-api` containers plus this bridge with
real Docker (this sandboxed dev session still has no Docker daemon, so
this is validated in CI, not locally).

## Architecture correction: Gateway is DEX-only -- CEX control needs the Hummingbot API, not Gateway

This bridge's original client was written against an **unverified
assumption**, flagged as such in its own docstring at the time: that
Hummingbot exposes a REST "Gateway" API for order/position control that
this bridge could call directly. Research against hummingbot.org's own
docs (2026-09-26) confirmed that assumption was wrong for our use case:

- **Gateway** (`hummingbot/gateway`, port 15888) is middleware for **DEX/AMM
  connectors only** (on-chain swaps, LP positions). It has nothing to do
  with centralized exchanges like Binance.
- The officially documented way to control Hummingbot bots
  programmatically -- including CEX perpetuals like Binance Futures -- is
  the separate **Hummingbot API** project
  (https://hummingbot.org/hummingbot-api/): a FastAPI server (port 8000,
  HTTP Basic Auth) backed by PostgreSQL and an EMQX MQTT broker, with
  documented endpoints (hummingbot.org/hummingbot-api/routers/) including
  `POST /trading/orders`, `POST /trading/{account}/{connector}/orders/{id}/cancel`,
  `POST /trading/positions`, `POST /portfolio/state`, and `GET /` for
  liveness (the only endpoint needing no auth).

**Fixed this pass**: `docker-compose.yml` now brings up the real
`postgres` + `emqx` + `hummingbot-api` stack (official images, matching
the documented service/container names) instead of the bare
`hummingbot/hummingbot` image talking Gateway. `bridge/hummingbot_api_client.py`
(replaces `bridge/hummingbot_gateway.py`) calls the documented endpoints
above with HTTP Basic Auth.

**Still open**: the docs above publish endpoint *paths* but not exact
request/response *field names*, so this client's payload shape
(`account_name`/`connector_name`/`trading_pair`/`trade_type`/`order_type`/
`amount`/`client_order_id`) is a best-effort mapping from Hummingbot's own
bot-orchestration conventions, not yet diffed against a live schema. The
CI job now curls the running container's `GET /openapi.json` and saves it
as `hummingbot_api_openapi.json` in the `hummingbot-docker-report`
artifact specifically so that diff can be done and the client corrected if
any field names are wrong -- do not report this client's request bodies as
proven correct until that diff has actually happened.
`HummingbotExecutionClientReal`'s interface
(`execution-service/market_edge_exec/hummingbot/real_client.py`) did not
need to change -- only what this bridge calls on the other side of it.

## Why a separate service

Hummingbot's own dependency tree (a cython-built core, per-exchange
connectors, TA-Lib, etc.) did not finish `pip install` dependency
resolution within a 180-second budget when tried directly inside
`execution-service/`'s virtualenv. Per instruction, it runs as its own
container stack instead: `docker-compose.yml` here runs the official
`hummingbot-api` + `postgres` + `emqx` containers plus this bridge in a
small container that only depends on `fastapi`/`httpx`.

## What's here

```
hummingbot-service/
  Dockerfile           builds the bridge (NOT Hummingbot itself -- that
                        comes from the official hummingbot-api/postgres/emqx images)
  docker-compose.yml    four services: postgres + emqx + hummingbot-api
                        (official Hummingbot API stack, paper/testnet only)
                        + bridge (this package)
  config/
    conf_client.yml     legacy single-container config, kept for reference
    conf_paper_trade.yml  paper account starting balances
  bridge/
    app.py              FastAPI app implementing the narrow bridge API
    hummingbot_api_client.py   translates bridge calls to the real
                        Hummingbot API (https://hummingbot.org/hummingbot-api/),
                        not Gateway -- see docstring for verification status
  tests/
    test_bridge_contract.py  tests the bridge's request/response shapes
                        against a FAKE hummingbot-api server (not the real one)
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

No mainnet API key belongs in this directory or its config files -- venue
credentials (once a testnet is chosen and Jakob supplies them via project
settings, never pasted in chat) are testnet-only and passed as environment
variables to the `hummingbot-api` container, never committed.

## How to actually run this (on a machine with Docker)

```
cd hummingbot-service
cp .env.example .env   # fill in USERNAME/PASSWORD/CONFIG_PASSWORD/etc, keep out of git
docker compose up --build
curl localhost:8090/health   # the bridge
curl -u $HUMMINGBOT_API_USERNAME:$HUMMINGBOT_API_PASSWORD localhost:8000/   # hummingbot-api directly
```

## Honesty note

The containers now really run in CI (confirmed via `docker compose ps`
showing all four `Up`/`running`, and both `GET http://localhost:8000/` and
the bridge's own `/health` really answering over HTTP). What is now
targeting the correct real API surface, but NOT yet independently confirmed
field-for-field: `bridge/hummingbot_api_client.py`'s request/response
payload shapes are a best-effort mapping from documented endpoint paths,
not a verified schema -- see that file's docstring and the CI job's
`hummingbot_api_openapi.json` artifact, saved specifically so that
verification can happen next. What has NOT been proven at all yet:
Hummingbot itself placing or filling a real order through this path. The
bridge's own request/response logic (`bridge/app.py`,
`bridge/hummingbot_api_client.py`) is tested against a fake hummingbot-api
server in `tests/test_bridge_contract.py`, which proves the bridge's HTTP
contract is internally consistent -- it does not, and was never claimed
to, prove a real fill.
