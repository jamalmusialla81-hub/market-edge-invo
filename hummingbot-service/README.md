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

**Verified against the live API (CI, hummingbot-api 1.0.1).**
`verify_openapi.py` drives the client through a recording transport and
checks every request it sends against the running container's
`/openapi.json` (path, method, fields, required fields, enums); CI fails if
anything does not match. Response fields the schema leaves undeclared were
read from the source running in that container (CI saves `routers/` and
`services/` as `hummingbot_api_upstream_src.tgz`). What that showed:

- `POST /trading/orders` takes account_name, connector_name, trading_pair,
  trade_type (BUY/SELL), amount, order_type (LIMIT/MARKET/LIMIT_MAKER), price,
  position_action (OPEN/CLOSE). There is no client id and no leverage field;
  the first version of this client sent both.
- Leverage is set separately: `POST /trading/{account}/{connector}/leverage`
  with an integer 1-125.
- Placing an order returns 201 `{order_id, ..., status: "submitted"}`, an
  acknowledgement only. The bridge polls `/trading/orders/active` and
  `/trading/orders/search` for the real state and never reports a fill it
  did not observe.
- Positions and active orders come back as `{data, pagination}`, and the API
  logs and skips per-connector errors, so an empty list can mean the
  connector failed. `positions()` refuses to answer unless the connector is
  configured for the account.
- Account lifecycle (add, list, credentials, portfolio state, positions,
  active orders, delete) works end to end on the live API.
- `binance_perpetual_testnet` is an available connector.

## Bridge API

`POST /orders` (sets leverage, places, polls to a real state), `DELETE
/orders/{signal_id}`, `PATCH /orders/{signal_id}` (501: not supported),
`GET /orders/active`, `GET /positions`, `GET /balances`, `GET /health`.
The bridge keeps a persistent `signal_id -> order_id` map (SQLite on the
`bridge-data` volume) because the Hummingbot API assigns its own ids. That
keeps cancels working across bridge restarts and refuses a `signal_id`
it has already sent.

## Paper only

No mainnet API key belongs in this directory or its config files -- venue
credentials (once a testnet is chosen and Jakob supplies them via project
settings, never pasted in chat) are testnet-only and passed as environment
variables to the `hummingbot-api` container, never committed.

## How to actually run this (on a machine with Docker)

```
cd hummingbot-service
cp .env.example .env   # fill in USERNAME/PASSWORD/CONFIG_PASSWORD/etc, keep out of git
./setup_bots.sh        # the API will not start without bots/credentials/master_account/
docker compose up --build
curl localhost:8090/health   # the bridge
curl -u $HUMMINGBOT_API_USERNAME:$HUMMINGBOT_API_PASSWORD localhost:8000/   # hummingbot-api directly
```

## Honesty note

Proven in CI: the real stack (postgres, EMQX, hummingbot-api 1.0.1, bridge)
starts and answers; authenticated reads work; the account lifecycle works;
every request this client sends matches the live schema. Not proven yet: a
real order placed and filled through this path. That needs Binance
testnet keys added as the `BINANCE_TESTNET_API_KEY`/`SECRET` repository
secrets. Until then, the order-state handling is tested against a fake API
whose responses copy the running source (`tests/test_bridge_contract.py`).
