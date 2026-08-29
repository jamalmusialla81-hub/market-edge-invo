# Research architecture

## Canonical candle boundary

`research-engine.js` is the research data boundary. It normalizes timestamps, rejects invalid OHLC/negative volume/duplicates/future rows, removes incomplete candles, measures gaps and coverage, and produces a deterministic dataset hash. Higher timeframes are aggregated only from exact, contiguous lower-timeframe buckets. `alignTimeframes()` exposes only candles whose close time is at or before the signal clock.

This boundary is independently tested with duplicates, reversed time, invalid OHLC, missing bars, partial candles, future rows and an explicit future-data injection. It does not yet replace every live fetch call in the monolithic page; that UI migration remains partial.

## Historical isolation

`chronologicalPartition()` creates strict 60/20/20 train, validation and untouched-test ranges with a generation ID. `consumeUntouched()` permits one consumption per generation in a supplied registry and rejects reuse. A durable shared registry is not yet deployed, so research runs made on different browsers cannot enforce global one-time consumption.

## Execution model

Quant engine 2.1 enters at the next bar open with directional slippage, checks stops before targets on ambiguous candles, exits 50% at TP1 and 50% at TP2, moves the remaining stop to entry after TP1, and times out after 30 bars. Each trade stores gross R, modeled cost R, MFE, MAE and duration. Results include median R, percentage drawdown at the configured risk fraction, sample tiers and cost sensitivity at 0.08%, 0.16%, 0.25% and 0.40% round trip.

Funding is not modeled because a complete synchronized funding-history dataset is not present. Browser backtests still use roughly 900 four-hour candles and do not exactly reproduce the live five-timeframe decision. Those limitations block a live-readiness verdict.

## Forward evidence

`forward-engine.js` stores immutable signal snapshots separately from outcome records. It records deterministic IDs, dataset/engine references when supplied, and the conservative execution model. Outcomes are appended to the separate `outcomes` map; original signal fields are never mutated. The browser UI migrates its older ledger on read.

## Background monitor and manual-live boundary

The Cloudflare Worker now has a five-minute Cron Trigger and D1 schema for canonical 5m candles, latest market states, immutable monitor events, TradingView evidence, paper snapshots/outcomes and a model registry. The server monitor stores only completed candles, derives deterministic completed buckets in memory, marks source/data health and keeps `executionDisabled: true`. Its 13 supported spot markets use Coinbase public 5m candles first, with Hyperliquid as a recorded fallback; BNB and HYPE remain Hyperliquid-first. Every canonical row and latest state records the actual source exchange and symbol, so USD and USDT prices are never silently mixed. It currently records `ACTIVE`, `WAIT`, `INSUFFICIENT DATA` or `BAD DATA`; it does not yet call the complete browser quant engine because a deep server-side canonical history is still being built.

`MANUAL LIVE` is a decision-support mode, not exchange automation. It uses the account balance the user enters locally for risk sizing and lets the user journal a manually placed trade. No exchange API, credentials, order submission, stop modification or balance lookup exists anywhere in the application. Manual-trade recommendations and actual entries are stored separately and never overwrite each other.

## ML research foundation

`ml-engine.js` provides own regularized logistic and ridge-regression baselines, strict feature/target separation, chronological ML splits, one-time untouched-test consumption, Platt calibration, Brier/ECE metrics and feature-coefficient importance. It rejects feature names that indicate labels, outcomes, exits, P&L or future values. There is **no trained or deployed ML champion yet**: the required deep, validated historical dataset and sufficient forward sample do not exist. Any future model begins in `RESEARCH`, can move to `SHADOW` only after meaningful unseen improvement, and cannot auto-promote or alter risk.

## Current evidence verdict

Historical samples remain tiny and inconsistent. No asset meets the requested robust bar across multi-year regimes, 184+ untouched/walk-forward trades, reasonable parameter neighborhoods, 0.25% costs and consistent forward evidence. Deployment remains **PAPER TRADE ONLY**.
