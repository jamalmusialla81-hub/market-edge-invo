# Market data foundation — HISTORICAL-RANK-V2-CLEAN (2026-09-27)

Research and data repair only. No production ranking, Quant weights, ML
weighting, execution, or live trading changed.

## Protective actions

- `phase5-v1-dataset.yml` is **disabled** in repository settings (state
  `disabled_manually`) until PR #2 merges. Re-enable it with
  `PUT /repos/{owner}/{repo}/actions/workflows/phase5-v1-dataset.yml/enable`.
- `HISTORICAL-RANK-V1` is **INVALID_CONTAMINATED** in `research/dataset-registry.js`
  and in the append-only experiment record
  `DATASET-INVALIDATION-HISTORICAL-RANK-V1` (`decision = DATASET_INVALIDATED`).
  Its D1 rows are untouched: not deleted, not repaired. Every trainer calls
  `Registry.assertTrainable()` and refuses it.
- `HISTORICAL-RANK-PILOT-V2` is **UNVERIFIED**. It was built by the same
  cached-snapshot path, so it is not trainable until re-audited.

## Candle archive (`research/data/v2-clean/candle-manifest.json`)

Venue and instrument: Coinbase Exchange **spot**, USD quote, 5m. This is the same
venue and products the signals used. No fill, no forward-fill, no substitution.
The window is 2023-06-01 → 2026-09-27, fetched with 7,614 requests and 0 retries.
Every asset-month is sha256-hashed; generation fails if the archive does not match.

| Asset | Present / expected 5m | Coverage | Internal gaps | Invalid / dup / future |
|---|---|---|---|---|
| BTC | 349,459 / 349,632 | 99.951% | 7 | 0 / 0 / 0 |
| ETH | 349,450 / 349,632 | 99.948% | 8 | 0 / 0 / 0 |
| SOL | 349,440 / 349,632 | 99.945% | 10 | 0 / 0 / 0 |
| XRP | 337,091 / 349,632 | 96.413% | 11 | 0 / 0 / 0 |
| DOGE | 349,439 / 349,632 | 99.945% | 16 | 0 / 0 / 0 |
| LTC | 349,443 / 349,632 | 99.946% | 12 | 0 / 0 / 0 |

Missing periods of 1h or more:
- venue-wide outages on 2024-05-31 22:15 (~1h; all assets except BTC),
  2024-10-26 16:10 (~1.1h), 2025-10-25 15:15 (~5.9h) and 2026-05-08 01:20 (~6.5h);
- XRP-USD is absent from 2023-06-01 until its relisting on 2023-07-13 (~1,029h).

Native Coinbase daily candles are complete (1,214 / 1,214 days); native 1h
candles are missing only the two ~6h outages.

## V2-CLEAN generation (strict policy, written to D1)

Quant receives exactly the production bar counts (5m×500, 15m×320, 1h×420,
4h×500, 1d×260, from `backend/scan-core.mjs`). Every timeframe must be
complete, consecutive, and close exactly at the scan, or that asset fails
closed. Labels come from the same venue's post-entry path. STOP FIRST applies,
and any missing candle before exit leaves the label unresolved.

Development period (scan < 2025-11-19):

| | Value |
|---|---|
| Daily scans attempted | 599 |
| Scans with >= 1 eligible asset | 166 |
| Rankable candidates | 69 (all resolved; all Coinbase spot) |
| **Choice scan groups (>= 2 candidates)** | **15** |
| Holdout scans usable | 0 |

Every row carries `scan_id`, `candidate_id`, `asset`, `direction`, `strategy`,
`scan_timestamp`, `entry_timestamp`, `entry_price`, entry source, venue and
instrument, `latest_feature_candle_timestamp`, outcome source, venue and
instrument, `label_version`, `dataset_version` and `freshness_status`, plus
history and outcome-window sha256 hashes.

**Why it is tiny:** under the strict rule, one missing 5m candle removes that
day's aggregated daily bar, and a missing daily bar blocks the next 260 days
of scans. The four venue-wide outages and a few single-candle gaps block
433 of 599 development scans. ETH was never eligible in development.

## Independent audit (development rows only; `audit-report.json`)

The audit source is Binance **spot** 1m (USDT quote), which is never used to
build entries or labels. All 69 rows were inspected.

| Check | Result |
|---|---|
| Decision-price error p50 / p95 / max | 3.1 / 7.9 / 9.8 bps |
| Entry-price error p50 / p95 / max | 3.3 / 7.9 / 10.1 bps |
| Label reproducibility from archive | 69 / 69 identical |
| Independent stop / TP1 agreement | 97.1% / 100% |
| Stale rows / non-Coinbase rows / missing provenance | 0 / 0 / 0 |
| **Label audit** | **PASS** |

The residual error is consistent with the USD vs USDT basis.

## Proposal: same-venue native context bars (dry run only, NOT written)

`HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF` keeps 5m/15m/1h strictly aggregated from
5m, but takes 4h from the venue's native 1h candles and 1d from its native
daily candles. Same venue, same instrument, separate dataset version, never
mixed. Dry-run result (`dryrun-native-htf-report.json`):

| | Strict (written) | Native-HTF (dry run) |
|---|---|---|
| Development scans with an eligible asset | 166 | 538 |
| Rankable / resolved | 69 / 69 | 697 / 695 (2 unresolved: missing candle) |
| **Choice scan groups** | **15** | **172** |
| Assets | BTC 27, XRP 17, DOGE 16, SOL 9 | BTC 97, ETH 113, SOL 106, XRP 111, DOGE 126, LTC 144 |
| Long / short | 40 / 29 | 364 / 333 |
| Holdout (counts only) | 0 scans | 150 scans, 188 candidates |

Approving this is a dataset-definition decision; it is not generated until
approved.

## Candidate diversity — root causes

V1's 95.6% BTC/ETH, 97.6% TREND CONTINUATION and 96.7% long came from the
**stale-snapshot bug**. The same late-November-2024 BTC/ETH uptrend was
re-evaluated every day. On genuine data (native-HTF dry run over 3,143
asset-evaluations):

- **Market conditions** are balanced: each asset spends about 30% of evaluations
  in an h1 uptrend, about 29% in a downtrend, and about 41% in neither.
  Candidates split 364 long / 333 short across all six assets.
- **Strategy implementation / filters** set the mix. TREND CONTINUATION is the
  most permissive gate (61% of candidates). BREAKOUT + RETEST needs a confirmed
  retest (sole blocker in about 950 evaluations each side). LIQUIDITY-SWEEP needs a
  sweep (about 560). MEAN REVERSION needs a range regime plus an RSI extreme.
- **Volume filter at the scan hour:** relative volume ≥ 0.8 on the latest h1
  bar passes only 45% of the time at 00:00 UTC. It is the most common sole
  blocker for TREND CONTINUATION (about 300 per side). The fixed 00:00 UTC cadence
  may depress this. That is a hypothesis to test with other scan hours, not a
  finding.
- **Asset-data availability** (strict policy only): fail-closed gap rules,
  not markets, decided which assets appeared (ETH 0, LTC 0).
- **Ranking thresholds**: none apply. Ranking mode emits every
  structurally valid candidate regardless of quality.

About 22% of asset-evaluations emit a candidate, which averages 1.3 per scan;
40% of scans have none. This is why choice scans stay limited.

## Model research

**DEFERRED.** The strict clean dataset has 15 choice scan groups. Even the
native-HTF proposal gives 172, below the ~300 needed before rank evidence
is meaningful. None of the earlier model, ablation, or walk-forward numbers
are evidence about alpha; the cross-market result is only a hypothesis to retest.

---

## Update — native-HTF generated (approved 2026-09-27, CI run 36309065656)

`research-outcome-recovery.yml` is now **disabled** (`disabled_manually`). The
workflow is preserved, and it no longer relabels legacy data or redeploys the
Worker.

`HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF` is a separate version with separate
scan IDs. It is never merged with strict `HISTORICAL-RANK-V2-CLEAN`.
- 5m, 15m and 1h are strict: aggregated from Coinbase spot 5m, no fill, fail closed on gaps.
- 4h is aggregated from native Coinbase spot 1h candles.
- 1d uses native Coinbase spot daily candles.
- Only bars that have closed at or before the scan are used.
- Each row records every frame's source and the sha256 of the exact bars fed.

| | Strict V2-CLEAN | Native-HTF |
|---|---|---|
| Dev scans with >= 1 eligible asset | 166 | 538 |
| **Choice scan groups** | **15** | **172** |
| Candidates (rankable) / resolved | 69 / 69 | 697 / 695 (2 missing-candle unresolved) |
| Assets | BTC 27, XRP 17, DOGE 16, SOL 9 | BTC 97, ETH 113, SOL 106, XRP 111, DOGE 126, LTC 144 |
| Strategy mix | TC 67%, SWEEP 13%, BRK 10%, MR 7%, MOM 3% | TC 61%, SWEEP 14%, BRK 13%, MOM 6%, MR 5% |
| Long / short | 40 / 29 | 364 / 333 |
| Entry error p50 / p95 / max | 3.3 / 7.9 / 10.1 bps | 2.8 / 9.1 / 27.2 bps |
| Label reproduction | 69/69 | 150/150 |
| Stop / TP1 agreement (Binance spot) | 97.1% / 100% | 90.7% / 98.7% |
| Stale / cross-venue / missing provenance / version mismatch | 0/0/0/– | 0/0/0/0 |
| Label audit | PASS | PASS |
| Holdout (counts only) | 0 | 150 scans, 188 candidates |

### Does native HTF change the feature definition? (`htf-policy-comparison.json`)

There are 379 development (scan, asset) pairs where **both** policies pass.
Across them, disagreement was **0%** on:
- 4h/1d structure trend and EMA bias
- 4h regime and daily macro regime
- the set of qualifying setups (63 pairs with setups)
- candidate scores (69 common candidates)
- the scan's top pick (15 scans)

The latest 4h and 1d closes are identical in every pair. Native bars fill
coverage: 2,764 native-only pairs against 0 strict-only pairs. On this
overlap they do not change the feature definition. Caveat: the overlap is
small (69 candidates, 15 multi-candidate scans), and 10% of 4h windows and
28% of 1d windows differ in some older bar without changing any output.

### Sanity baselines only (`sanity-baselines-native-htf.json`; development choice scans; no tuning or selection)

Covers 171 choice scans and 543 candidates. #1 pick, mean R at 0.08 / 0.16 / 0.25 / 0.40% cost:

| | 0.08% | 0.16% | 0.25% | 0.40% | 95% CI @0.16% |
|---|---|---|---|---|---|
| Random (exact expectation) | -0.133 | -0.197 | -0.270 | -0.391 | -0.318 … -0.074 |
| Current Quant | -0.153 | -0.216 | -0.287 | -0.405 | -0.386 … -0.048 |

- Quant minus Random at 0.16% is -0.019R (CI -0.136 … +0.090).
- Quant rank buckets: #1 -0.210R, #2-5 -0.069R, #6-10 -0.499R. There is no monotonicity; #1 is worse than #2-5.
- Weighted pair accuracy is 0.56; mean within-scan Spearman is 0.02.

These are sanity checks, not alpha claims. Current Quant does not beat a
random same-scan pick on clean development data, and the average candidate is
negative after costs.

### Forward collection

`phase5-v2-clean.yml` has a daily `forward` stage (cron 01:41 UTC). It
activates once the workflow is on the default branch.
- It fetches the trailing 280 complete UTC days from Coinbase spot.
- It verifies them against the manifest written in the same job.
- It appends only scans whose 24h outcome window has closed.
- It skips scans already frozen and never pushes to `main`.
- Its reports go to a workflow artifact.

Every forward scan is dated after 2025-12-01, so it lands in the sealed
holdout and does **not** grow the development choice-scan count.
