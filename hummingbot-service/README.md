# Hummingbot bridge service (paper/testnet only)

Status: **code written, NOT built or run in this environment.** `docker
version` finds the Docker CLI here but there is no daemon socket
(`/var/run/docker.sock` does not exist) -- this sandbox has no
docker-in-docker, so `docker compose up` cannot be executed from this
session. This directory is real, complete code for someone with Docker
access (Jakob's own machine, or a CI runner with Docker) to actually run.

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

Nothing in this directory has been executed end-to-end. The bridge's own
logic (`bridge/app.py`, `bridge/hummingbot_gateway.py`) is tested against a
fake Gateway server in `tests/test_bridge_contract.py`, which proves the
bridge's HTTP contract is internally consistent -- it does NOT prove
Hummingbot itself starts, connects to a venue, or fills an order. That
proof requires Docker access this session does not have.
