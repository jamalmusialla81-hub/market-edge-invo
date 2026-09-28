# Dataset expansion v1 — pre-registration (2026-09-28)

Committed before any candidate asset's candles are fetched or any row is
generated. Amendments, if any, are appended below with a commit hash and a
reason, and only before the real-data run they affect.

**Question.** Can the research universe grow in a clean, natural way, without
changing the strategy or manufacturing samples, so that the ranking problem
gets more independent choice scans?

This is a sample-size / data-quality phase. It is not a model search.

## 1. Frozen (unchanged, verified by sha256 in the report)

| Frozen item | Where |
|---|---|
| Candidate generator, thresholds, Quant scoring | `quant-engine.js`, `replay-engine.js`, `research/historical-rank.js`, `research/historical-rank-v2-clean.js` (not edited) |
| Labels: strict resolver, STOP FIRST, 24h horizon, 0.16% round-trip cost, +0.03% entry slippage | `resolveStrict` in `historical-rank-v2-clean.js` |
| Native-HTF policy: 5m/15m/1h from Coinbase spot 5m; 4h from native 1h; 1d native daily; fail closed on any gap | same |
| Production bar counts 5m×500, 15m×320, 1h×420, 4h×500, 1d×260 | same |
| Scan grid: daily 00:00 UTC, first scan from the 2021-09-01 archive start | same as `run-v2-clean-dataset.mjs` |
| Model configs: repo histogram GBM regression (`GBM_FINAL_R`) and LambdaRank on TP1 (`LAMBDARANK_GBM_TP1`), frozen params and early-stopping rule | `research/rank-research-v2.js` (not edited) |
| Feature set for the learned baselines: BASE families only (`BASE, SETUP, STRUCTURE, VOLATILITY, MOMENTUM, LIQUIDITY, REGIME`) | as the feature-research BASE arm |
| Walk-forward protocol: 5 grouped chronological folds, initial 40%, purge 24h, embargo 256h, scan-grouped block bootstrap | same |
| Sealed holdout: `scan_timestamp >= 2025-12-01` is holdout; development `< 2025-11-19T08:00Z` | `V2.HOLDOUT` (not moved) |

Nothing in this list may change during the phase. Only the asset list grows.

## 2. Candidate universe screen (outcome-free)

Source: Coinbase Exchange public API only (`/products`, native daily candles).
No other venue, no synthetic or cross-venue history.

A product is screened in when **all** hold:

- **S1 Active spot market:** quote `USD`, `status = online`, not
  `trading_disabled`, `cancel_only`, `limit_only`, `post_only` or `auction_mode`.
- **S2 Not pegged or wrapped:** base not in the stable/wrapped/staked list
  (`USDT USDC DAI PYUSD GUSD EURC PAX PAXG XAUT TUSD BUSD USDS RLUSD FDUSD USD1
  WBTC CBBTC CBETH WETH STETH WSTETH LSETH RETH MSOL JITOSOL`, any base
  containing `USD`), and daily close coefficient of variation over the
  development window ≥ 5%.
- **S3 History:** first valid native daily candle (the first one Coinbase
  returns on or after 2021-09-01) leaves at least 365 days of development
  eligibility after the 260-day production lookback:
  `first_valid + 261 d + 365 d <= 2025-11-19`.
- **S4 Daily coverage:** native daily coverage ≥ 99% from first valid date to
  the development cutoff.
- **S5 Liquidity:** median daily USD notional (volume × close, native daily)
  over the asset's own development window ≥ $5M, and ≤ 5% of those days
  below $0.5M.
- **S6 No obvious structural break:** no native daily bar with |log return|
  > ln 3, and no day-to-day open vs previous close gap > 50%
  (redenomination / migration signature).

The 5m fetch is capped at the **40** screened-in products with the highest
median daily notional (the old six are always kept and are not refetched).

## 3. Archive rules for new assets (same as the old archive)

Window 2021-09-01 → 2026-09-27 (identical to the committed manifest). Coinbase
spot 5m plus native 1h and 1d; no fill, no forward-fill, no substitution;
monthly sha256 manifest; the build job re-hashes every file against it and
fails closed on any mismatch. Nothing before an asset's first candle is ever
created: it joins the universe only when the frozen generator's own history
check passes (≥ 260 native daily bars, etc.).

**Post-fetch usability (USABLE = YES only if all hold):**
- F1 5m coverage ≥ 99.0% from the first valid candle to the window end;
- F2 0 invalid, 0 conflicting-duplicate, 0 future candles;
- F3 native 1h coverage ≥ 99.0% over the same span.

## 4. Minimum-history / contribution rule

An USABLE asset is **included** if the frozen generator emits **≥ 30 rankable
development candidates** for it. This is decided from generated candidates
before any label of that asset is read. No asset is included or excluded on
outcomes, redundancy or model results. Redundancy (§7) is flagged, never
removed.

## 5. Dataset

`HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED`: a new version with its own
scan ids (`hrp-HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED-86400000-<ts>`).
The old `HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF` rows in D1 are read (SELECT
only) and never written. The expanded dataset is an immutable, hashed CI
artifact (no D1 writes). Development rows only carry labels; holdout scans are
generated for counts only and are **never resolved**.

**Reproduction gate:** the expanded rows of the six old assets must reproduce
the stored D1 development rows (same scan date, asset, strategy, direction,
entry, stop, Quant score, FINAL_R). Any mismatch stops the phase.

## 6. Measurements (descriptive; no selection)

- Phase 4 diversity value per new asset (outcome-free): candidate scans; scans
  where it adds a new choice (turns a 0–1 candidate scan into a choice, or
  adds a direction or strategy absent among the old assets' candidates);
  direction and strategy mix; activation overlap with the old six; daily
  return correlation to the old-six basket.
- Phase 7/8 OLD vs EXPANDED: development scans, choice scans, candidates,
  resolved, candidates per choice scan (median/p25/p75/max), assets /
  directions / strategies per choice scan, top-two (by Quant) same direction /
  asset / strategy, cross-asset same-direction outcome correlation,
  between-scan variance share, within-scan outcome dispersion.
- Phase 10 regimes, point-in-time from BTC native daily closes up to the scan:
  trend = BTC 60-day log return > +15% BULL, < −15% BEAR, else SIDEWAYS;
  volatility = BTC 30-day realised daily-return sd above / below its
  development-window median (HIGH / LOW).

## 7. Redundancy (Phase 9, flags only)

Per asset pair on development data: daily log-return correlation (native
daily), same-scan candidate FINAL_R correlation, same-scan same-direction
FINAL_R correlation (≥ 20 pairs), and candidate activation Jaccard.
Per asset, against its nearest neighbour:
- **HIGH:** daily-return correlation ≥ 0.85 and same-direction outcome
  correlation ≥ 0.5;
- **MEDIUM:** daily-return correlation ≥ 0.75 or same-direction outcome
  correlation ≥ 0.4;
- **LOW:** otherwise.

## 8. Baselines (Phase 11) and placebo gate (Phase 12)

On OLD (D1) and EXPANDED, identical code: Random same-scan (exact expected
value), Current Quant, frozen GBM regression, frozen GBM ranker (BASE
families). #1-pick mean R at 0.00 / 0.08 / 0.16 / 0.25%, paired deltas with
scan-block bootstrap CIs, rank monotonicity, fold stability. No tuning beyond
the frozen inner early-stopping rule.

**Placebo gate (mandatory):** each learned model is re-run K = 19 times with
all BASE feature columns permuted jointly across candidate rows. A model claim
passes the gate only if (a) placebo p = (1 + #placebo ≥ real) / 20 ≤ 0.05,
(b) the paired delta vs Random has CI low > 0, and (c) the paired delta vs
Quant has CI low > 0.

## 9. Power (Phase 13)

Scan-level only. σ = sd of the per-scan paired delta (GBM regression #1 − Quant
#1, 0.16%) on OOS choice scans, inflated by the lag-autocorrelation factor.
For δ ∈ {0.02, 0.04, 0.06, 0.08}R: scans for a 95% CI half-width below δ,
n = (1.96 σ / δ)²; scans for 80% power (two-sided 5%), n = ((1.96 + 0.8416)
σ / δ)²; achieved fraction = OOS choice scans / n.

## 10. Do not touch

Production Quant, ranking, execution-service, Nautilus, Hummingbot, desktop
app, risk limits, release workflow, live mode, mainnet, the sealed holdout,
and the daily forward collection (which stays on the old six assets).
