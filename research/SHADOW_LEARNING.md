# Universal shadow learning (research only)

**EXECUTION != OBSERVATION.** Paper execution still submits at most one
production selection per scan, under the unchanged 5% / 20% / 4-position risk
policy. Shadow learning observes the same scan and records everything it saw,
whatever paper execution decided.

## What is recorded, every scan

- **Every candidate.** Every candidate the unchanged generator produced for every
  evaluated market (`evaluateSetupCandidates`) is recorded. That covers long and
  short, every strategy, picks and non-picks, and ranks #1..#N, plus the
  production pick itself. Each candidate is recorded with:
  - its proposal: entry, stop, TP1, TP2 and RR
  - its scores: Quant, model and combined
  - its rank: production rank, rank within the asset, and a research-only
    scan-wide rank.
- **One market-state snapshot per evaluated market.** This includes markets where
  production had `NO_TRADE`, so the data is not limited to setups the generator
  already recognises.
- **Execution fields, stored separately from research validity:**
  - `execution_status`: `EXECUTED`, `REJECTED`, `NOT_SUBMITTED`, `NO_SIGNAL` or
    `NOT_APPLICABLE`.
  - `execution_rejection_reason`: for example `ENTRIES_PAUSED`,
    `PORTFOLIO_EXPOSURE_CAP` or `STALE_MARKET_DATA`.
  - `research_candidate_valid` (with its own `invalid_reason`): whether the
    market snapshot itself is usable. A stale snapshot or a missing price makes it
    invalid, and invalid rows are never resolved.
- **Point-in-time features:**
  - 5m, 15m, 1h, 4h and 1d returns, ATR, RSI, volatility, range position, EMA
    distance and relative volume
  - cross-market breadth and BTC context
  - Hyperliquid funding, open interest and premium
  - regime and source provenance.
- **Versions on every row:** `generator_version` (a hash of the exact scan-core
  and quant-engine bytes), `feature_version`, `model_version` and
  `dataset_version`.

The scan runs with the research-only `includeResearch` flag. The default scan
output is byte-for-byte unchanged, which `backend/scan-core.test.mjs` asserts.
No extra scans are run and the paper cadence is unchanged. Setting
`SHADOW_EVERY_N_CYCLES` records only every Nth scan, and the resulting interval is
stored on each scan row.

## Labels (same venue, strict, never repaired)

The venue is Hyperliquid, using completed 5m bars. Labels are anchored on the
first bar that opens at or after the scan: that bar's open price is the reference
entry, and the rest of the scan's bar is the minimum reaction delay.

**Horizons** are 15m, 30m, 1h, 2h, 4h, 6h, 12h, 24h, 48h and 72h, written in four
immutable batches. A batch is written only after its window has closed.

**Missing data:**
- A missing bar inside the covered data is recorded as
  `UNRESOLVED_MISSING_CANDLE`. It is never filled, and data from another venue or
  a cache is never used.
- A window that the available candles don't cover stays pending. After 7 days it
  is closed as `UNRESOLVED_DATA_UNAVAILABLE`.

**Per horizon**, each label records:
- MFE and MAE, both as percentages and in R, with the time to each
- whether the stop, TP1 and TP2 were hit, and in what order. A bar that spans both
  the stop and a target is recorded as `STOP_TP1_SAME_BAR_AMBIGUOUS`. The outcome
  is resolved stop-first, and the ambiguity flag is kept.
- path volatility
- the current-policy result in R, after fees and slippage, computed with
  `paper/lifecycle.py` — the same exit rules paper execution uses
- the hourly excursion path, on the 72h label.

**Post-outcome labels (research only)**, written after the 72h window closes:
- `OPTIMAL_THEORETICAL`: the absolute upper bound — the lowest and highest bar
  extremes, with no costs. This is not tradable.
- `OPTIMAL_EXECUTABLE`: entries and exits only at bar opens after the reaction
  delay, with slippage and fees on both sides. It still assumes perfect exit
  timing, so it is an upper bound.
- Candidate-specific labels:
  - the best exit before the proposed stop (`optimal_tp1`)
  - the best exit ignoring the stop (`optimal_tp2`)
  - `strategy_efficiency` = current-policy R / executable-within-stop R.
- A diagnostic classification (`SHADOW-CLASS-V1-DIAGNOSTIC`, unvalidated, never
  a training target yet):
  - candidates: `GOOD_TRADE_TAKEN`, `GOOD_TRADE_MISSED`, `BAD_TRADE_TAKEN`,
    `BAD_TRADE_AVOIDED` or `AMBIGUOUS`
  - no-trade states: `NO_TRADE_CORRECT` or `MISSED_OPPORTUNITY`, based on whether
    +2 units came before −1 unit within 24h, where 1 unit = 1.5 × the
    decision-time 1h ATR.

## Integrity

- **Immutability.** `DECISION_TIME_DATA` and every label row are protected by
  SQLite triggers that refuse UPDATE and DELETE. Each decision snapshot is hashed,
  and the hash is checked on every read.
- **Leakage guard.**
  - `contracts.assert_decision_features` and `research/shadow-leakage-guard.js`
    reject any hindsight or future field used as a feature.
  - Ingest refuses a decision payload that contains one.
  - The only training export, `ShadowStore.training_rows`, runs the guard on
    its feature paths before reading anything.
- **Correlation.** Every row carries an `observation_cluster_id` (same asset,
  kind, direction and strategy within 30 minutes), a `market_episode_id` (asset
  plus UTC day) and an `overlap_fraction` (overlap on a 4h window).
  `shadow/stats.py` resamples whole clusters or episodes, never single rows.
- **Isolation.**
  - The shadow store lives in its own SQLite file
    (`market_edge_shadow_research.sqlite3`), next to the paper database but
    separate from it.
  - The shadow package cannot import routing, risk, the paper engine or ledger,
    Nautilus, Hummingbot or any network library.
  - The capture module only talks to `/shadow/*`.
  - Tests check that paper equity, exposure, positions and intents are unchanged
    after shadow ingest and resolution.
  - A shadow failure never affects the paper cycle.

## Datasets

The three stores are registered in `research/dataset-registry.js` as
`COLLECTING` and **not trainable**:
- `FORWARD-SHADOW-RAW-V1`
- `FORWARD-SHADOW-RESOLVED-V1`
- `FORWARD-PAPER-EXECUTED-V1`

## Learning loop (not started)

observe → resolve → accumulate → periodic research batch → challenger → grouped
(cluster/episode) out-of-sample validation → placebo gate → shadow challenger →
forward comparison → promotion only with evidence.

Single trades never change production weights. Production Quant, its
thresholds, the paper risk limits and the sealed historical holdout are
untouched.

## Known limits

- **Storage.** A compressed decision snapshot is roughly 0.8 KB. With about 40
  markets and a handful of candidates per scan, every-5-minute capture adds tens
  of MB per day. `/shadow/summary` reports `db_bytes`, and
  `SHADOW_EVERY_N_CYCLES` throttles collection.
- **48h and 72h windows.** These need 5m history beyond the scan's own
  500 bars, so up to `SHADOW_EXTRA_FETCH_PER_CYCLE` (default 2) extra Hyperliquid
  candle requests are made per cycle. The 24h-and-shorter windows reuse the
  scan's candles, which costs no extra requests.
- **Backups.** The shadow store is not included in the desktop backup
  export.
