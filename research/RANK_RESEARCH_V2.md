# Rank research V2 — audit and findings (2026-09-27)

Research only. No production ranking, Quant scoring, ML weighting, Best Trade
Now, Take Trade, journal, auth, RLS or execution path was changed.

## Question

Which candidate should Market Edge rank #1 inside a scan, judged by
out-of-sample #1 after-cost expectancy?

## 1. Inventory before this work

| Item | State found |
|---|---|
| Dataset | `HISTORICAL-RANK-V1`, daily cadence, 292 scans (2024-10-30 → 2025-08-17), 573 rankable, 572 resolved |
| Generator | `run-historical-rank-pilot.mjs` via `phase5-v1-dataset.yml`, 16 new scans/day, stops at 1000 resolved |
| Outcome | 288 × 5m bars (24h), next-bar open + 0.03% slippage, stop-first, 50% TP1 / 50% TP2, breakeven after TP1, FINAL_R net of 0.16% |
| Label recovery | `recover-historical-rank-outcomes.mjs` relabels data gaps with Binance USD-M 5m (proxy) |
| Trainer | `v0-epoch-training.mjs` (`RANK_TRAINING_LABEL=V1`), 60/20/20 chronological by scan, 256h embargo |
| Models | random, Quant, logistic TP1, ridge, stumps, linear pairwise ranker, Conv1D, MTF ridge, fusion |
| Walk-forward | none; one fixed split |
| Bootstrap / CIs | none |
| Holdout | none sealed; test = last 20% of a growing dataset |

## 2. Scientific defects found

1. **Stale frozen inputs (critical).** The historical Coinbase backfill ends
   in late November 2024, but the live monitor keeps appending recent candles,
   so `MAX(open_time)` looks current and the generator kept scanning.
   `cachedSnapshot()` returns the last *available* candles, which passes the
   no-lookahead check but freezes an old market. Of 277 BTC candidates, only
   6 distinct entries exist and 271 share one stop geometry. BTC entry
   92,091.94 repeats from 2024-11-21 onward while BTC traded 94k–99k.
   501/572 frozen entries are >2% away from the independent Binance price at
   scan time, and all of them are proxy-labelled rows.
2. **Invalid labels (critical, consequence of 1).** Those scans had no
   Coinbase outcome window, so recovery labelled them with real Binance prices
   against stale stops. Distance to stop is inflated, so labels collapse
   toward 0R: median MFE 0.10R over 24h, 88.8% timeouts, TP1 hit 4.5%.
   The stored MFE is inconsistent with the realised 24h path for 518/530
   proxy rows. (The 19 Coinbase-labelled flags are audit artefacts: the check
   is close-based and ignores that an outcome stops at the stop.)
3. **Test contamination.** The daily V1 job re-evaluated every model on the
   last 20% and chose `bestModel` *by test expectancy*, every day, on a test
   window that moved as data grew. That test set is not pristine.
4. **Direction-blind sequence models.** V0/V1 Conv1D and MTF ridge never saw
   the trade direction, so they could not separate a long from a short on the
   same asset.
5. **Mixed-venue labels.** 93% of labels are Binance USD-M perpetual, while
   the signals come from Coinbase spot.
6. **Generator is extremely narrow.** 97.6% TREND CONTINUATION, 96.7% long,
   95.6% BTC/ETH; a typical scan is "BTC TC long vs ETH TC long" (label
   correlation 0.30). SOL/XRP/DOGE/LTC appear in fewer than 3% of scans.
   Part of this is caused by defect 1 (the same stale market is re-evaluated
   every day).

Non-defects checked: no duplicated candidates, contiguous Quant ranks, no
Quant ties at #1, outcome horizon (24h) equals the cadence (no overlapping
label windows), and regime labels are computed from completed pre-entry candles.

## 3. Fixes in this branch

- `historical-rank.js` `assertFresh()`: generation fails closed when the
  latest completed 5m candle closes more than two bars before the scan clock.
  The daily Phase 5 job will now **stop** rather than write more invalid
  immutable rows, until fresh canonical history exists for the scan dates.
- `v0-epoch-training.mjs`: excludes stale rows and the sealed holdout, and
  selects `bestModel` on validation only; test is reported as
  `CONTAMINATED_REPEATED_EVALUATION`.
- `rank-research-v2.js` and `run-rank-research-v2.mjs`: new read-only suite
  (see below).

## 4. Sealed holdout

`PHASE5-V1-HOLDOUT-2025-12-01`: every scan with `scan_timestamp >=
2025-12-01T00:00Z` is holdout. Development uses only scans ending 24h + 256h
before that. No such scan existed when this was fixed, so it is pristine.
The SQL loader filters it out before any row is read.
`consumeHoldout()` is the only way in: it is one-shot and needs a
pre-registered model spec.

## 5. V2 suite

- Expanding walk-forward (5 folds), purge (24h outcome) + 256h embargo before
  every test block; tuning on an inner, later slice of each training window.
- Moving-block bootstrap (block 5 scans) for the #1-pick mean and for paired
  differences vs Quant and vs random.
- Random is the exact expectation (all candidates tied), not one hash draw.
- Costs 0.08 / 0.16 / 0.25 / 0.40% applied in each trade's own risk unit.
- Feature families (all pre-entry, direction-signed): BASE (V0/V1 vector),
  SETUP, STRUCTURE, VOLATILITY, MOMENTUM, LIQUIDITY, REGIME, CROSS_MARKET
  (Binance 1h BTC/ETH returns, relative strength, breadth, dispersion,
  realised volatility; bars used only once closed), DERIVATIVES (Binance
  funding, used only once settled). Open interest, basis and liquidations
  were not added because no reliable point-in-time history is wired in.
- Models: random, Quant, logistic TP1, ridge FINAL_R, GBM FINAL_R,
  within-scan ridge, LambdaRank GBM (FINAL_R and TP1 objectives),
  direction-signed multi-timeframe Conv1D, and fusion. GRU and multi-task
  were not run: there is no audited tensor backend, and there are too few
  choice scans.
- Acceptance: positive at 0.16% with the CI lower bound above 0, beats Quant
  with the CI lower bound above 0, at least 60% of folds positive, positive
  at 0.25%, and positive after removing the dominant asset.
- Shadow promotion only if every check passes.

## 6. Results

See `RESULTS` below, filled from the read-only CI runs.
