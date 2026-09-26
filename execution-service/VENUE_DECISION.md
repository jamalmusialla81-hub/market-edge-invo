# First real paper/testnet venue: Binance USDT-M Futures Testnet

## Candidates considered

`nautilus_trader==1.221.0` ships adapters for: `binance`, `bybit`,
`hyperliquid`, `dydx`, `okx`, `bitmex`, `coinbase_intx`, `interactive_brokers`,
`betfair`, `polymarket`, plus `sandbox` (Nautilus's own paper-only shim, not
a venue). Of these, the perpetual-capable, well-documented testnet options
are Binance USDT-M Futures Testnet, Bybit Testnet, Hyperliquid's public
testnet, and dYdX's testnet.

## Why Binance USDT-M Futures Testnet

- **Nautilus's own config has a literal `testnet: bool` flag** on
  `BinanceExecClientConfig` (verified by inspection: `testnet=False` default,
  `account_type` supports `USDT_FUTURE`), plus `use_reduce_only=True` and
  `futures_leverages`/`futures_margin_types` as first-class config fields --
  this is the adapter with the most direct, documented testnet support of
  the options checked, not an inference from a changelog.
- Long and short perpetuals, reduce-only, and per-symbol leverage/margin
  type are all native config, matching this phase's "reduce-only, leverage
  controls" requirement directly.
- Binance Futures Testnet (testnet.binancefuture.com) is free, needs no KYC,
  and issues API keys immediately -- lower friction than Bybit's testnet
  (which gates some endpoints behind additional verification) or dYdX's
  (chain-based, adds wallet/gas complexity irrelevant to a pure paper test).
- Nautilus's execution client for Binance handles order-lifecycle events
  (ack, partial fill, fill, cancel, reject) and position/balance queries
  over the same websocket/REST pattern used for live trading, so nothing
  about the paper integration differs qualitatively from a future live one
  -- exactly the property this phase's "first real paper venue" step needs
  to prove.

## What's actually needed to connect it (not yet done)

1. A Binance Futures **Testnet** account (testnet.binancefuture.com) and an
   API key/secret from it.
2. Those two values added as environment variables in this project's own
   settings (Project settings > Environment > API credentials, or as env
   vars) -- **never pasted into chat**, per this environment's own rule
   about secrets. Suggested variable names: `BINANCE_TESTNET_API_KEY`,
   `BINANCE_TESTNET_API_SECRET`.
3. A `BinanceExecClientConfig(testnet=True, account_type=BinanceAccountType.USDT_FUTURE, api_key=..., api_secret=...)`
   wired into a live `TradingNode` (not the `BacktestEngine` -- see
   `README.md`'s "Nautilus integration depth" section for why the
   `BacktestEngine` path is currently blocked by a native crash in this
   environment).

This decision is venue selection only -- no credentials exist yet, no
connection has been attempted, and nothing here talks to Binance's testnet
or any other live endpoint.
