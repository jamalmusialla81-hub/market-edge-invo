# TradingView integration

Market Edge uses TradingView only through official user-facing charts, Pine scripts and alert webhooks. It does not scrape TradingView, call private endpoints or claim that TradingView supplies the application's raw historical data.

## Visual charts

The app builds official chart links using the documented `EXCHANGE:SYMBOL` format. The exchange selector matters: `BINANCE:ETHUSDT` and `COINBASE:ETHUSD` are different markets and can print different prices. Chart links are for visual confirmation; Market Edge's numeric execution card continues to use its named public data feeds.

Official reference: <https://www.tradingview.com/widget-docs/tutorials/build-page/dynamic-symbols/>

## Pine companion

`tradingview/market-edge-companion.pine` reproduces a limited deterministic subset: custom EMA initialization, simple-window RSI, simple ATR, MACD, relative volume and trend-candidate rules. It deliberately emits `CANDIDATE`, not `LONG` or `SHORT`. The full five-timeframe engine, source reconciliation, account risk rules and historical gates remain in Market Edge.

`tradingview-compat.test.js` compares the companion-compatible formulas with the browser quant engine on a fixed candle fixture. A passing fixture proves formula equivalence for that subset only—not strategy profitability or whole-engine equivalence.

TradingView alerts are created by the user from the chart UI and trigger only on realtime executions after creation. Pine code creates alert events; it does not create the running alert for the user. Official reference: <https://www.tradingview.com/pine-script-docs/concepts/alerts/>

## Authorized webhook

Endpoint: `POST /v1/tradingview-alert`

The endpoint is disabled unless the Cloudflare Worker secret `TV_WEBHOOK_TOKEN` is configured. Because TradingView's webhook form cannot attach arbitrary authorization headers, use a long random token in the webhook URL query, keep the URL private and rotate it if exposed:

`https://market-edge-ai.jakob-market-edge.workers.dev/v1/tradingview-alert?token=REDACTED`

Do not put exchange/API credentials in the alert body. The Worker accepts JSON only, authenticates before accepting evidence, validates exchange/symbol/timeframe/numbers/state, rejects future or stale timestamps, and deduplicates event IDs. Its response always states `execution: disabled`. Duplicate storage is isolate-local in this version, so durable cross-isolate deduplication is still required before this can be called production-grade ingestion.

TradingView requires webhook targets on port 80 or 443, cancels requests that take too long, requires 2FA for webhook alerts and publishes its delivery IPs. Official reference: <https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/>

## Alert JSON

```json
{
  "event_id": "BINANCE-ETHUSDT-15-1788000000000",
  "symbol": "ETHUSDT",
  "exchange": "BINANCE",
  "timeframe": "15m",
  "timestamp": 1788000000000,
  "close": 2500.25,
  "volume": 1200,
  "condition": "deterministic_long_subset",
  "state": "CANDIDATE"
}
```

Accepted states are `CANDIDATE`, `WAIT` and `NO TRADE`. Webhook evidence cannot override a quantitative `WAIT`, `NO TRADE` or `ANALYSIS UNAVAILABLE` result and cannot execute money.
