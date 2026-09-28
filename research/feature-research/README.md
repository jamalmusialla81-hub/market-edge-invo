# Feature research v1 — report (2026-09-28)

**Question:** can genuinely new, point-in-time information improve
out-of-sample ranking of HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF candidates?

**Answer: not on this dataset.** None of the five new feature families
(structure/BOS/CHOCH, FVG, candle geometry, clean cross-market, derivatives)
or the three approved combinations improved the frozen GBM. Every arm scored
at or below BASE, and none beat its own placebo (the same features shuffled
across candidates). All ten arms are **NO EVIDENCE**. No shadow candidate.

The diagnostics say why: the ranking problem itself is thin. Half of outcome
variance is the shared market move of the scan, 46% of out-of-sample choice
scans have only two candidates, 80% of Quant's top-two picks point the same
way (cross-asset outcome correlation 0.49), and detecting a +0.04R feature
effect at 95% would need roughly 1,800 out-of-sample scans; we have 396
(214 with a real choice).

- Pre-registration (committed before any code): [`PREREGISTRATION.md`](PREREGISTRATION.md)
  (commit e2ac62e; amendments A1/A2 in ec838c1 / da83a2a, all before the real-data run)
- CI run: [36372928751](https://github.com/jamalmusialla81-hub/market-edge-invo/actions/runs/36372928751),
  code at da83a2a, raw JSON: [`reports/feature-research-run-36372928751.json`](reports/feature-research-run-36372928751.json)
- Read-only: 6,845 D1 rows read (SELECT only), sealed holdout counted only
  (150 scans), no production file changed.

## 1. Frozen instruments reproduce the previous phase exactly

| @ 0.16% cost | this run | model-research phase |
|---|---|---|
| Random #1 | −0.159R | −0.159R |
| Current Quant #1 | −0.166R | −0.166R |
| GBM regression, prior full feature set (REFERENCE) | −0.126R | −0.126R |
| GBM ranker (LambdaRank on TP1), REFERENCE | −0.126R | −0.126R |

"LightGBM" in the previous report is the repo's own histogram GBM
(`rank-research-v2.js`), frozen here with identical params and early-stopping
rule. Same 5 grouped chronological folds, purge 24h, embargo 256h, same
scan-grouped block bootstrap.

**BASE** (the dataset's own candidate features, without the old Binance
cross-market/funding families) is the comparison point for every arm:
GBM regression −0.128R, GBM ranker −0.137R. Dropping the old cross-market
and funding families costs only 0.002R, so the previous ablation's "−0.04R
without DERIVATIVES" does not replicate; it sits inside the placebo noise
band below.

## 2. Feature families (Phase 11)

Cost sensitivity (0.00% is exact: FINAL_R is linear in cost per trade):

| #1 pick mean R | 0.00% | 0.08% | 0.16% | 0.25% |
|---|---|---|---|---|
| Random | -0.028 | -0.094 | -0.159 | -0.233 |
| Current Quant | -0.038 | -0.102 | -0.166 | -0.238 |
| GBM regression, BASE | -0.011 | -0.070 | -0.128 | -0.194 |
| GBM ranker, BASE | +0.008 | -0.065 | -0.137 | -0.218 |
| GBM regression, BASE+CANDLE | -0.017 | -0.074 | -0.132 | -0.196 |
| GBM ranker, BASE+CANDLE | +0.018 | -0.057 | -0.132 | -0.216 |
| GBM regression, BASE+DERIVATIVES | -0.024 | -0.083 | -0.143 | -0.210 |
| GBM ranker, BASE+DERIVATIVES | -0.005 | -0.080 | -0.154 | -0.238 |
| GBM regression, BASE+ALL | -0.033 | -0.094 | -0.155 | -0.224 |
| GBM ranker, BASE+ALL | -0.038 | -0.114 | -0.189 | -0.274 |

Delta = paired per-scan difference in #1-pick R @0.16% vs the BASE arm's same
model, same 396 OOS scans. Placebo p = share of 19 shuffled-feature runs that
did at least as well (amendment A1/A2).

| arm | GBM reg @0.16% | Δ reg | 95% CI | win % | Δ ranker | placebo p | class |
|---|---|---|---|---|---|---|---|
| BASE | −0.128 | — | — | — | — | — | — |
| + STRUCTURE | −0.160 | −0.031 | −0.101 … +0.037 | 19 | −0.041 | 0.80 | NO EVIDENCE |
| + FVG | −0.156 | −0.028 | −0.088 … +0.030 | 17 | −0.008 | 0.75 | NO EVIDENCE |
| + CANDLE | −0.132 | −0.003 | −0.068 … +0.060 | 45 | +0.005 | 0.50 | NO EVIDENCE |
| + CROSS_MARKET | −0.190 | −0.061 | −0.136 … +0.008 | 4 | −0.043 | 1.00 | NO EVIDENCE |
| + DERIVATIVES | −0.143 | −0.014 | −0.061 … +0.031 | 28 | −0.018 | 0.50 | NO EVIDENCE |
| + STRUCTURE + FVG | −0.198 | −0.070 | −0.138 … −0.005 | 2 | −0.025 | 1.00 | NO EVIDENCE |
| + STRUCTURE + CANDLE | −0.167 | −0.038 | −0.112 … +0.030 | 14 | −0.052 | 0.85 | NO EVIDENCE |
| + CROSS_MARKET + DERIVATIVES | −0.139 | −0.011 | −0.073 … +0.051 | 34 | −0.024 | 0.50 | NO EVIDENCE |
| + ALL | −0.155 | −0.027 | −0.098 … +0.044 | 22 | −0.053 | 0.70 | NO EVIDENCE |

Fold-by-fold Δ (GBM regression): no family is positive in more than 2 of 5
folds; fold 3 (Sep 2024 – Jan 2025) is the only fold where most families
help. Leave-one-asset-out Δ is at or below zero for nearly every asset in
every arm; only CANDLE (4/6 slightly positive) and CROSS_MARKET+DERIVATIVES
(2/6) have more than one positive asset. No feature
exceeded 15% of split count (no suspicious dominance). Full per-asset,
per-direction and per-strategy deltas are in the JSON.

**Placebo band.** Adding shuffled (information-free) columns of the same
size changes the #1-pick R by −0.012 to −0.042R on average (sd 0.015–0.030).
The real families land inside that band: they behave like extra noise
columns. The null calibration on three synthetic random-walk worlds gave
0/15 false placebo passes, but it also showed WEAK SIGNAL is reached by
chance in 1–5 of 9 arms per world, so that tier would not have meant much.

**Derivatives provenance.** Tardis.dev: `SKIPPED_NOT_CONFIGURED` (no
`TARDIS_API_KEY`). Fallback: Binance USD-M official archives — funding
(from 2022-04; XRP from 2024-02), 5-minute open interest (358–447 days per
asset, 0 missing), 1h premium index. Coverage 99.9% of rows; freshness ≤ 5
min median (funding ≤ 8h, by definition). Liquidations:
`UNAVAILABLE_NO_POINT_IN_TIME_SOURCE`; those four features were not built.

## 3. Rank monotonicity (Phase 12)

| predicted rank (OOS choice scans) | Quant | GBM reg BASE | GBM reg + CANDLE (best arm) |
|---|---|---|---|
| #1 (n 214) | −0.204 | −0.134 | −0.138 |
| #2 (n 214) | −0.127 | −0.224 | −0.179 |
| #3 (n 115) | −0.145 | −0.198 | −0.244 |
| #4 (n 57) | +0.200 | +0.034 | +0.244 |
| #5+ (n 60) | −0.371 | −0.015 | −0.271 |
| flag | NON-MONOTONIC | NON-MONOTONIC | NON-MONOTONIC |

Why (descriptive, no labels changed):

- **The scan, not the candidate, carries most of the outcome.** Between-scan
  variance is 58% of FINAL_R variance (48% within choice scans). A ranker can
  only use the within-scan half.
- **Alternatives are often economically equivalent.** In 33% of choice scans
  the best and second-best *realised* outcomes differ by < 0.10R (43% by
  < 0.25R). By Quant's own top two: 26% / 35%.
- **Many scans are barely a choice.** 46% of OOS choice scans have exactly 2
  candidates; 80% of Quant's top-two pairs share a direction and same-direction
  outcomes across assets correlate 0.49.
- **The regression target is almost unpredictable.** GBM regression MAE
  1.080R vs 1.082R for predicting the mean: it ranks, it barely predicts.
- **TP1 is not a different target.** TP1 correlates 0.85 with FINAL_R; half of
  all labels are a full −1R stop, which makes FINAL_R heavy-tailed but a TP1
  ranker (−0.137R) was no better.
- **Setup families do not rank better separately.** Quant pair accuracy
  within the same strategy is 0.52 vs 0.56 across strategies; GBM 0.54 vs 0.56.
- Quant's weighted pair accuracy (0.555) is *higher* than GBM's (0.527), yet
  its #1 pick is worse: Quant orders the middle of the list slightly right and
  the top wrong, i.e. its highest scores are systematically overconfident.

## 4. Holding horizon (Phase 13, diagnostic only)

Same strict label rules, same Coinbase archive; 24h reproduces all 1,362
stored labels exactly. No horizon is selected.

| horizon | resolved | natural exit | mean R | TP1 | stop | timeout | Quant pair acc | GBM Spearman | GBM #1 R | Random #1 R |
|---|---|---|---|---|---|---|---|---|---|---|
| 6h | 100% | 31% | −0.117 | 13% | 25% | 69% | 0.548 | 0.157 | −0.087 | −0.099 |
| 12h | 100% | 47% | −0.142 | 17% | 35% | 53% | 0.534 | 0.131 | −0.097 | −0.119 |
| 24h | 100% | 68% | −0.160 | 24% | 50% | 32% | 0.555 | 0.178 | −0.128 | −0.159 |
| 48h | 100% | 82% | −0.158 | 29% | 58% | 18% | 0.558 | 0.154 | −0.145 | −0.176 |
| 72h | 99.9% | 87% | −0.169 | 30% | 61% | 13% | 0.562 | 0.161 | −0.169 | −0.194 |

The ranking signal neither decays nor strengthens with horizon (GBM Spearman
0.13–0.18, Quant pair accuracy 0.53–0.56). Longer horizons resolve more
trades but the average candidate gets slightly worse, not better. Nothing
here justifies a horizon experiment ahead of the sample-size problem.

## 5. Effective sample size (Phase 14)

- Scans: 1,259 total (1,109 development, 150 sealed holdout, counts only);
  659 development scan groups with resolved candidates, 359 choice scans.
- OOS: 396 scans, 214 with a choice. Autocorrelation of pick outcomes is ~0
  (daily scans, 24h horizon, 0% overlap), so effective ≈ nominal; overlap
  would be 60% at 48h and 85% at 72h.
- By year: 2022 298 / 2023 276 / 2024 428 / 2025 360 candidates; choice
  scans 83 / 78 / 110 / 88.
- By strategy: TREND 836, SWEEP 199, BREAKOUT 199, MOMENTUM 72, MEAN REV 56.
  By asset: LTC 290, DOGE 260, SOL 246, ETH 236, BTC 218, XRP 112.
- Paired #1-pick delta sd ≈ 0.86R per OOS scan, so a +0.04R effect needs
  ~1,800 OOS scans for a 95% CI to exclude zero (+0.08R needs ~440).

**Uncertainty is dominated by too few choice scans and high outcome
variance**, compounded by weak within-scan diversity. Overlap is not the
problem at the 24h horizon.

## 6. Candidate generator (Phase 15, production generator untouched)

- Candidates per choice scan: median 3 (2: 174, 3: 99, 4: 44, 5+: 42).
- Assets per choice scan: 1: 39, 2: 173, 3: 102, 4+: 45.
- Both directions present: 35% of choice scans. One strategy only: 39%.
- Quant's top two: same asset and direction 16%, same direction 80%, same
  strategy and direction 49%. Outcomes differ by ≥ 0.5R in 53% of scans,
  ≥ 1R in 38%.

Legitimate future sources of diversity (none implemented): more supported
assets (the universe is six coins; XRP has only 63% archive coverage),
independent setup families that fire in different regimes, and more than one
scan per day (only once the sample-size maths above is understood, since
intraday scans overlap).

## 7. Microstructure prep and forward learning (Phases 16–17)

- `microstructure-interface.js`: field list, pure L2 feature computation,
  and an `assess()` that keeps ALPHA_VALID separate from
  EXECUTION_FAVOURABLE / EXECUTION_UNFAVOURABLE / WAIT, failing closed to WAIT
  on missing, stale or unprovenanced data and on the absence of a researched
  policy. No provider configured; no DeepLOB; not imported anywhere.
- `forward-observation.js`: the record each future decision must keep
  (model/feature version, feature values, decision time and price, path,
  observed execution cost or null, outcome), with tamper and ordering checks.
  Genuine forward scans already accumulate daily via `phase5-v2-clean.yml`
  (stage `forward`, from main). Nothing is trained on them.

## 8. Leakage audit — PASS

No development row at or after the cutoff; no archive candle at or after
the holdout start; every feature source timestamp ≤ scan time (derivatives
included); all feature names pre-entry; future-invariance on 41 real rows
(archive truncated at each scan) 0 mismatches; synthetic tests catch
deliberately injected lookahead; the 24h horizon resolver reproduces all
stored labels. Scans never split across folds (walk-forward over scan
groups).

## Trial accounting

22 learned OOS trials (10 arms + REFERENCE × GBM regression, GBM ranker),
5 folds each, every fold evaluated once per trial. 342 placebo fits (null
calibration, not selection). Plus 3 synthetic-only calibration worlds before
the real run. No hyper-parameter changed between arms.

## Files

`features.js` (families, versions `structure-v1`, `fvg-v1`, `candle-v1`,
`xmkt-v1`, `deriv-v1`), `derivatives-provider.mjs`, `diagnostics.js`,
`run-feature-research.mjs`, `microstructure-interface.js`,
`forward-observation.js`, tests for each, and
`.github/workflows/research-feature-research.yml` (triggered by editing
`RUN_REQUEST` on this branch). `rank-research-v2.js` only gained a split-count
diagnostic; its scores are unchanged (reference reproduced to 4 decimals).
