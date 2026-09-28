# Feature research — pre-registration (feature-research-v1)

Written and committed **before** any feature family below was implemented or
evaluated out of sample. The commit that adds this file is the registration
timestamp; later edits are appended as dated amendments, never rewritten.

Research question: *can genuinely new, point-in-time information improve
out-of-sample ranking of HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF candidates?*

Nothing here is evidence of edge, and no source cited below is treated as
proof of edge. Sources only motivate *which* hypotheses are worth one test.

---

## 0. Frozen measuring instruments (Phase 1 / Phase 10)

Frozen from the model-research phase (`research/rank-research-v2.js`,
PR #6, CI run 36369878431). Not retuned per family.

| instrument | frozen definition |
|---|---|
| Random | same-scan random pick, exact expected value (all scores tied) |
| Current Quant | stored `quant_score` |
| GBM regression | `GBM_FINAL_R`: in-repo histogram GBM, squared loss on FINAL_R, depth 2, lr 0.05, min leaf 15, λ 1, 16 quantile bins, rounds early-stopped (≤200) on the inner chronological validation slice of each training window |
| GBM ranker | `LAMBDARANK_GBM_TP1`: same GBM, RankNet/LambdaRank pairwise gradients within scan on TP1, same fixed params and early-stopping rule |

Note on naming: the prior phase reported these as "LightGBM regression" and
"LightGBM LambdaRank". They are the repo's own histogram GBM implementation,
not the LightGBM library. Nothing changes here; the names are just accurate.

Frozen protocol: development rows only (`scan_timestamp < devCutoff`, holdout
filtered in SQL and again in `parseRows`), 5-fold expanding chronological
walk-forward over scan groups (initial 40%), purge = 24h outcome horizon,
embargo = 256h, inner split = last 25% of each training window (purged),
scan-grouped moving-block bootstrap (block 5, 2000 reps), primary metric = #1
pick after-cost R at 0.16%, also 0.00/0.08/0.25%.

## 1. Feature sets and trial budget (Phase 9)

**BASE** = the candidate-intrinsic families already in the clean dataset:
`BASE, SETUP, STRUCTURE, VOLATILITY, MOMENTUM, LIQUIDITY, REGIME` from
`rank-research-v2.js`.

The old `CROSS_MARKET` (Binance USD-M 1h closes) and old `DERIVATIVES`
(Binance funding only) families are **excluded from BASE** because this phase
retests those ideas from scratch with clean, provenanced sources. The prior
phase's all-family feature set is re-run once as `REFERENCE` purely to prove
the frozen pipeline reproduces −0.126R; it is not an experiment arm.

New families (names prefixed `FR_` to keep them separate from the old ones):
`FR_STRUCTURE, FR_FVG, FR_CANDLE, FR_CROSS_MARKET, FR_DERIVATIVES`.

Exactly these 10 arms, no others:

1. BASE
2. BASE + FR_STRUCTURE
3. BASE + FR_FVG
4. BASE + FR_CANDLE
5. BASE + FR_CROSS_MARKET
6. BASE + FR_DERIVATIVES
7. BASE + FR_STRUCTURE + FR_FVG
8. BASE + FR_STRUCTURE + FR_CANDLE
9. BASE + FR_CROSS_MARKET + FR_DERIVATIVES
10. BASE + ALL FR families

× 2 learned models (GBM regression, GBM ranker) = **20 learned OOS trials**,
plus the one REFERENCE reproduction (2 trials) = **22**. Random and Quant are
deterministic and do not count as trials. Each OOS fold is evaluated exactly
once per trial. No arm is added after results are seen; a second pass, if
ever needed, is a new pre-registration.

## 2. Classification rule (Phase 11) — fixed now

Delta = paired per-scan difference in #1-pick R @0.16% between an arm's model
and the BASE arm's same model, on identical OOS scans.

- **RETAIN**: delta > 0 for BOTH frozen models; bootstrap win % ≥ 90 (GBM
  regression); ≥ 4/5 folds with positive delta; leave-one-asset-out delta > 0
  for every asset; within-scan pair accuracy not below BASE by > 0.01; no
  single feature > 40% of the model's split count; leakage PASS.
- **PROMISING**: delta > 0 for both models, win % ≥ 75, ≥ 3/5 folds positive.
- **WEAK SIGNAL**: delta > 0 for at least one model and win % ≥ 60 for it.
- **NO EVIDENCE**: anything else.

Shadow candidate requires RETAIN *and* the prior phase's promotion checks
(positive expectancy with CI support, beats Quant with CI support). It is not
expected in this phase.

## 3. Point-in-time contract shared by every family (Phase 8)

- Source bars: the exact audited Coinbase spot archive the dataset was built
  from (CI artifact of run 36313185824, verified byte-for-byte against
  `research/data/v2-clean/candle-manifest.json` before use). 5m native;
  15m and 1h aggregated from complete 5m buckets; 4h aggregated from native
  1h (the NATIVE-HTF policy).
- A bar is usable at scan time `T` only if `bar_open + interval <= T`.
- Any family whose required window has a missing bar yields `null` for that
  row (no fill, no forward-fill, no substitute venue). Nulls are counted and
  reported per family. The GBM's scaler maps null to the training mean (0 in
  z-space), the frozen behaviour.
- No candle at or after the holdout start (2025-12-01) is ever loaded; the
  loader truncates and asserts.
- Every family attaches provenance: provider, venue, instrument,
  instrument_type, source_timestamp (latest source datum used),
  retrieval (CI run id + archive run id), feature_window_end,
  dataset_version, source_version, normalization_version (definition
  version), freshness_ms. Freshness above the family's limit → fail closed
  (null), never a stale value.
- Directional features are signed by candidate direction (+ = favourable for
  the candidate), matching the existing V2 convention.
- A future-invariance test is mandatory for every family: features computed
  with the full series must equal features computed with the series
  truncated at `T` (random future bars appended must change nothing).

---

## 4. FR_STRUCTURE — swings, BOS, CHOCH (version `structure-v1`)

- **Hypothesis**: candidates aligned with confirmed higher-timeframe market
  structure (recent BOS in trade direction, no fresh opposing CHOCH, entry
  not far from the broken level) rank better within a scan than
  counter-structure candidates.
- **Rationale**: trend persistence / time-series momentum at multi-day
  horizons in crypto (Liu & Tsyvinski 2021; Moskowitz, Ooi & Pedersen 2012
  for the general effect); structure breaks as an explicit, less smoothed
  trend-state than EMAs.
- **Source**: smart-money-concepts (joshyattridge/smart-money-concepts) used
  as a reference for definitions only; its `swing_highs_lows` uses a centred
  window that needs future bars, so it is NOT imported. Own implementation.
- **Definitions** (per timeframe 15m, 1h, 4h; ATR = Wilder ATR14 on that TF):
  - Swing high at bar *i*: `high[i]` strictly greater than the highs of the
    `k` bars before and the `k` bars after (k = 3 on 15m/1h, 2 on 4h).
    **Known only at the close of bar i+k.** Swing low symmetric.
  - Bullish BOS: first bar whose **close** exceeds the most recent swing high
    that was already known at that bar; confirmed at that bar's close.
    Bearish symmetric. Each swing level can be broken once.
  - trend_state: direction of the latest confirmed BOS (+1/−1/0).
  - CHOCH: a confirmed BOS whose direction is opposite to the trend_state
    immediately before it.
  - Features (direction-signed where marked *): `trend_state`*,
    `swing_high_distance_atr`, `swing_low_distance_atr` (from price to latest
    known swing, ATR units), `bos_direction`*, `bars_since_bos`,
    `bos_strength_atr` (close − level at break / ATR), `choch_direction`*,
    `bars_since_choch`, `choch_strength_atr`, `break_retest_state`* (after
    the latest BOS: +1 price returned to within 0.25 ATR of the broken level
    and closed back on the break side, −1 closed back through the level,
    0 not revisited), `distance_to_structure_atr` (to nearest known swing),
    `structure_alignment_15m_1h`, `structure_alignment_1h_4h` (product of
    trend states, then signed by direction when both agree).
  - Lookback: 300 bars per TF.
- **Timeframes**: 15m, 1h, 4h.
- **Point-in-time proof**: swing known at i+k; BOS at the breaking bar's
  close; all bars close ≤ T; future-invariance test.
- **Missing data**: any gap in the TF window → family null for that TF.
- **Expected failure mode**: overlaps the existing STRUCTURE/trend-alignment
  and MOMENTUM families (EMA trend, quant structure flags), so gains may be
  ~0; BOS on daily scans may be stale noise.
- **Ablation plan**: arms 2, 7, 8, 10.

## 5. FR_FVG — fair value gaps (version `fvg-v1`)

- **Hypothesis**: an unfilled gap in the trade direction near price (acting as
  support for longs / resistance for shorts), especially one created right
  after a BOS, improves the candidate's relative outcome; an opposing gap
  ahead of price hurts it.
- **Rationale**: discretionary SMC folklore (the uploaded-transcript style
  claim) that imbalance zones act as support/resistance. Treated as an
  untested claim; weakest prior of the five families.
- **Source**: smart-money-concepts `fvg` as reference (it can mark mitigation
  with future bars — not used); own implementation.
- **Definitions** (1h and 15m): bullish FVG at bar *i* if `low[i] >
  high[i−2]`, zone `[high[i−2], low[i]]`; bearish if `high[i] < low[i−2]`.
  **Known at the close of bar i.** fill_fraction = deepest penetration into
  the zone by bars after i and ≤ T, / width; a gap with fill ≥ 1 is dead.
  Features on the nearest live gap to price within 100 bars:
  `fvg_direction`*, `fvg_width_atr`, `fvg_age_bars`, `fvg_fill_fraction`,
  `distance_to_nearest_fvg_atr` (signed: + = gap is on the supportive side),
  `fvg_midpoint_distance_atr`, `fvg_with_trend` (gap direction ==
  structure-v1 trend state), `fvg_after_bos`, `fvg_after_choch` (gap created
  within 3 bars after a same-direction BOS/CHOCH), `fvg_retest_state`
  (price currently inside the zone = 1, touched and left = 0.5, untouched =
  0), plus counts of live aligned vs opposing gaps.
- **Point-in-time proof**: gap known at close of its third bar; fill uses
  only bars ≤ T; future-invariance test.
- **Missing data**: gap in window → null.
- **Expected failure mode**: gaps are frequent and mostly noise on crypto
  1h bars; features may be near-constant in effect.
- **Ablation plan**: arms 3, 7, 10.

## 6. FR_CANDLE — continuous candle geometry (version `candle-v1`)

- **Hypothesis**: the geometry of the last completed candles (rejection wicks
  against the trade, strong confirming bodies, compression before
  expansion, relative volume) carries short-horizon information about which
  candidate in a scan follows through.
- **Rationale**: measurement-based version of candlestick patterns; the
  literature is mixed (Marshall, Young & Rose 2006 find little value for
  US equities), so the prior is weak. TA-Lib CDL functions are only a
  reference; no binary pattern flags.
- **Definitions** on the last completed 15m and 1h bar (ATR14 of that TF):
  `body_atr`*, `upper_wick_atr`, `lower_wick_atr`, `range_atr`,
  `body_fraction`, `close_location_value`* ((close−low)/(high−low), signed
  so + = closes toward the favourable extreme), `range_percentile` (in the
  last 100 ranges), `engulfing_strength`* (current body minus previous body
  in ATR when colours differ, else 0, signed by the current body's
  direction), `pinbar_strength`* ((lower wick − upper wick)/range),
  `compression_score` (ATR5/ATR50), `expansion_score` (range / ATR14),
  `relative_volume` (vol / mean vol 20), `volume_zscore` (50 bars),
  `distance_to_support_atr` / `distance_to_resistance_atr` (to the 50-bar
  low/high, room behind / ahead for the candidate), `candle_trend_alignment`*
  (sign of body × sign of 20-bar slope), `confirmation_strength`* (sum of the
  last 3 bodies / ATR).
- **Point-in-time**: last bar must close ≤ T and must close exactly at T for
  15m (the NATIVE-HTF freshness rule) — otherwise null.
- **Expected failure mode**: overlaps the existing sequence-derived wick /
  range / relative-volume features; likely little incremental value.
- **Ablation plan**: arms 4, 8, 10.

## 7. FR_CROSS_MARKET — clean cross-asset context (version `xmkt-v1`)

- **Hypothesis**: market-wide state (BTC trend and volatility, breadth,
  dispersion) and the asset's residual strength vs BTC help pick the
  candidate that is aligned with the market (or least exposed to it).
- **Rationale**: a strong common factor in crypto returns (Liu, Tsyvinski &
  Wu 2022 "Common Risk Factors in Cryptocurrency"); BTC leads alts at short
  lags. The old V1 cross-market result was on contaminated data and is not
  evidence; the old Binance-1h family is excluded from BASE.
- **Source**: the same Coinbase spot 5m archive (same venue as the labels) —
  no cross-venue mixing. Universe = BTC, ETH, SOL, XRP, DOGE, LTC.
- **Definitions** (windows end at T): `btc_return_5m/1h/4h/24h`* (log %),
  `btc_volatility_1h` (std of 5m log returns, 12 bars), `btc_volatility_24h`
  (288 bars), `eth_btc_relative_strength` (24h, signed by direction when the
  candidate is ETH, else raw), `asset_vs_btc_relative_strength`* (24h),
  `asset_vs_market_residual_momentum`* (24h return minus β×BTC 24h return,
  β from 7 days of 1h returns), `market_breadth`* (share of assets up over
  24h − 0.5), `cross_asset_dispersion` (std of 24h returns),
  `rolling_corr_btc`, `rolling_corr_eth` (7d of 1h returns),
  `btc_lead_lag_5m` (corr of asset r_t with BTC r_{t−1}, last 288 5m bars),
  `btc_lead_lag_15m` (same on 15m, last 288 bars).
- **Missing data**: any missing bar in a window → that feature null; a
  missing asset does not change the breadth denominator silently: breadth
  and dispersion require ≥ 4 assets and record how many were present.
- **Expected failure mode**: context features are identical for all
  candidates in a scan except through direction signing and asset residuals,
  so within-scan ranking value can only come through those interactions.
- **Ablation plan**: arms 5, 9, 10.

## 8. FR_DERIVATIVES — perpetual futures context (version `deriv-v1`)

- **Hypothesis**: crowded positioning (extreme funding, fast OI build-up,
  large premium) is context that changes which candidate follows through;
  the prior ablation showed removing the funding-only family cost ~0.04R.
  No hard-coded rule such as "positive funding ⇒ short".
- **Rationale**: futures basis / funding predicts crash risk and future
  returns in crypto (Schmeling, Schrimpf & Todorov 2023, "Crypto carry");
  leverage and OI dynamics around liquidation cascades.
- **Provider order**: 1) Tardis.dev — used only if a `TARDIS_API_KEY` is
  configured; otherwise reported `SKIPPED_NOT_CONFIGURED`. 2) Fallback:
  official Binance USD-M public archives (data.binance.vision, documented
  at github.com/binance/binance-public-data): `fundingRate` (monthly),
  `metrics` (daily; 5-minute `sum_open_interest`), `premiumIndexKlines`
  (1h). Instrument `{ASSET}USDT` perpetual, venue BINANCE_USDM, declared as
  a different instrument from the Coinbase spot candidates on purpose
  (context, not a substitute).
- **Definitions**: `funding_rate`* (last settled, bps), `funding_zscore`*
  (last vs 30-day mean/std of settlements), `funding_change`* (last − prior
  settlement), `oi_change_5m/1h/4h` (% change of sum_open_interest),
  `price_oi_divergence`* (direction-signed 4h Coinbase return × sign of 4h
  OI change), `mark_spot_basis_bps`* (last closed 1h premium index close ×
  1e4), `basis_change`* (vs 24h earlier), `funding_extreme_flag`
  (|funding_zscore| > 2), `oi_expansion_state` (4h OI change > +2%),
  `oi_contraction_state` (< −2%). Liquidation features
  (`liquidation_buy/sell_intensity`, `liquidation_imbalance`,
  `distance_to_recent_liquidation_cluster`) require a point-in-time
  liquidation history; Binance's public archive has none for this window, so
  they are `UNAVAILABLE_NO_POINT_IN_TIME_SOURCE` unless Tardis is configured.
- **Point-in-time**: funding known at its settlement time; a metrics
  snapshot is used only if `create_time <= T − 5m` and freshness ≤ 30m; a
  premium-index bar only once closed. Stale → null.
- **Missing data**: per-feature null; per-asset coverage reported. Start
  with BTC/ETH coverage reported first; other assets included where the
  archive exists, never filled.
- **Expected failure mode**: context is shared by all same-asset candidates;
  funding regimes are slow, so the effective number of independent
  observations is small and results may be driven by a few months.
- **Ablation plan**: arms 6, 9, 10.

## 9. Diagnostics (no model selection, no label changes)

- Phase 12 rank-monotonicity: realised R and TP1 by predicted rank; MAE and
  pairwise ranking loss; within-scan dispersion; share of choice scans whose
  #1 and #2 outcomes differ by < 0.10R and < 0.25R (thresholds fixed here);
  share of scans with exactly 2 candidates; candidate-count distribution;
  pair accuracy for same-strategy vs cross-strategy pairs; between-scan vs
  within-scan variance of FINAL_R.
- Phase 13 horizon: re-resolve every development candidate with the frozen
  strict label rules at 6/12/24/48/72h from the same Coinbase archive; 24h
  must reproduce the stored labels. Report only; no horizon is selected.
- Phase 14/15: effective sample size and candidate diversity as specified.

## Amendments

### A1 — 2026-09-28, before any real-data OOS run: placebo calibration

Reason: a dry run of the full pipeline on synthetic random-walk data (no
possible signal) produced single-arm deltas of ±0.05–0.09R with bootstrap
win % anywhere from 1% to 96%. Bootstrap win % therefore overstates evidence
for a feature family on this sample size, and a family-level null is needed.

Added (stricter only; nothing above is relaxed):

- For each of the five single-family arms, K = 19 placebo runs in which that
  family's feature block is randomly permuted across candidate rows (fixed
  seeds 1..19), breaking any link to outcomes while keeping the marginal
  distribution. Same frozen models, folds and pairing.
- Placebo p = (1 + #placebo deltas ≥ real delta) / 20, per model.
- **RETAIN additionally requires placebo p ≤ 0.05 for the GBM regression
  model.** PROMISING additionally requires placebo p ≤ 0.20. Families that
  pass the original rule but fail the placebo check are downgraded one level
  and reported as such.
- Placebo runs are null calibration, not selection trials; they are counted
  and reported separately (5 × 19 × 2 = 190 placebo model fits).

### A2 — 2026-09-28, before any real-data OOS run: placebo for combinations

Reason: the same null calibration (3 synthetic random-walk worlds, K = 19)
gave 0 of 15 single-family placebo p-values ≤ 0.05 (minimum 0.20), so the
A1 gate is not anti-conservative; but in one world the un-gated
`BASE + ALL` combination reached RETAIN under the original rule on pure
noise. Combinations therefore get the same placebo gate: all of the arm's
new family blocks are permuted jointly with one permutation per seed
(K = 19), and the A1 thresholds apply. Placebo fits become 9 × 19 × 2 = 342.
Also recorded from the calibration: WEAK SIGNAL was assigned to 1–5 of 9
arms per pure-noise world, so WEAK SIGNAL is not distinguishable from noise
at this sample size and will be reported that way.
Clarification of A1 wording: a family is stepped down until its level's own
placebo requirement holds (RETAIN ≤ 0.05, PROMISING ≤ 0.20), so a RETAIN with
placebo p = 0.3 ends at WEAK SIGNAL, not PROMISING.
