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

## Current evidence verdict

Historical samples remain tiny and inconsistent. No asset meets the requested robust bar across multi-year regimes, 184+ untouched/walk-forward trades, reasonable parameter neighborhoods, 0.25% costs and consistent forward evidence. Deployment remains **PAPER TRADE ONLY**.
