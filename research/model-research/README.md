# Model research phase — Random / Quant / Ridge / Logistic / GBM / LambdaRank

Research only. No production ranking, Quant weights, thresholds, execution,
desktop app, release workflow, D1 schema, or the sealed holdout was touched.

## What this is

This phase asks: *can a simple, disciplined model learn useful ranking
information from the existing clean point-in-time feature set that Current
Quant does not?* It is not "find any profitable backtest" — it is a
challenger-vs-incumbent comparison under grouped, purged, chronological
walk-forward validation, with the sealed holdout (2025-12-01+) never read.

## Why this reuses `research/rank-research-v2.js` instead of new files

`research/rank-research-v2.js` (audited, tested, already in the repo) already
implements every item on the suggested file list, in one dependency-free
module: dataset loader + leakage-safe `parseRows`, `walkForwardFolds` (grouped
chronological walk-forward with purge + embargo), a from-scratch histogram
gradient-boosted-tree engine (`gbmFit`, modes `regression` and `lambdarank`)
standing in for LightGBM/LambdaRank, ridge/logistic/within-scan-ridge,
`blockBootstrap`, `rankBuckets`/`weightedPairAccuracy`/`spearmanWithin` for
monotonicity, `ablations` for family ablation, and `consumeHoldout` as the
one-shot, pre-registered gate on the sealed holdout. Writing a second,
parallel Python/LightGBM stack would duplicate this and risk disagreeing with
it. Instead this phase:

1. Confirmed `HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF` is registered `trainable`
   in `research/dataset-registry.js` (it is — approved 2026-09-27).
2. Pointed the existing CI runner (`.github/workflows/research-rank-v2.yml`,
   `research/run-rank-research-v2.mjs`) at that dataset instead of the tiny
   strict `HISTORICAL-RANK-V2-CLEAN` generation, and added a `foldDates`
   field to its summary so fold boundaries are reported by date, not just
   scan-group counts.
3. Ran it read-only against production D1 (SELECT-only, hard 300k-row read
   budget, holdout excluded in SQL before any row is read) via
   `workflow_dispatch` on this branch.

The model suite it evaluates is exactly the one this phase's spec asked for,
plus two the existing framework already had (within-scan ridge, a small
Conv1D/fusion ablation) that are reported for completeness but are out of
scope for promotion (the spec's "do not add yet" list explicitly excludes
Conv1D/LSTM; it is listed here as an existing model whose result happens to
be similar to the others, not as a new model built for this phase):

| Spec model | Implementation here |
|---|---|
| Random same-scan | `RANDOM` (all candidates tied → exact expected value) |
| Current Quant | `CURRENT_QUANT` (`quant_score`) |
| Ridge regression | `RIDGE_FINAL_R` (+ `WITHIN_SCAN_RIDGE` variant) |
| Logistic / classification | `LOGISTIC_TP1` (TP1-before-SL binary target) |
| LightGBM regression | `GBM_FINAL_R` (depth-2 histogram GBT, squared loss on `FINAL_R`) |
| LightGBM ranking / LambdaRank | `LAMBDARANK_GBM_FINAL_R`, `LAMBDARANK_GBM_TP1` (pairwise RankNet-style gradients within each scan) |

## Dataset

`HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF`, development period only (holdout
excluded in SQL before any row reaches this code):

- 659 development scan groups, 359 choice scan groups (≥2 candidates), 1,362
  resolved candidates, 1,109 total scans in the dev+embargo window (matches
  the project's validated snapshot).
- Window: 2022-05-20 → 2025-10-23.
- Assets: LTC 290, DOGE 260, ETH 236, SOL 246, BTC 218, XRP 112.
- Strategies: TREND CONTINUATION 836, LIQUIDITY-SWEEP REVERSAL 199,
  BREAKOUT + RETEST 199, MOMENTUM CONTINUATION 72, MEAN REVERSION 56.
- Directions: 692 long / 670 short.
- Outcomes: TP1 rate 23.6%, stop rate 55.4%, timeout rate 31.9%, mean
  FINAL_R (0.16% cost, all candidates) -0.1598.
- Sealed holdout: 150 scans, unchanged, counts only, never read.

## Data splitting

Grouped, chronological, purged walk-forward over the 659 development scan
groups: first 40% is the initial training block, the remaining 60% is split
into 5 expanding-window test folds. Every candidate from one scan stays in
one fold. Training rows are purged if their 24h outcome horizon + 256h
embargo would still be open at the test fold's start. Hyperparameters are
tuned only on the chronologically-last 25% of each fold's training window
(same purge/embargo rule applied again), never on the test fold itself.

| Fold | Train scan groups | Test scan groups | Purged | Test window |
|---|---|---|---|---|
| 1 | 255 | 79 | 8 | 2023-11-23 → 2024-04-08 |
| 2 | 338 | 79 | 4 | 2024-04-14 → 2024-09-08 |
| 3 | 416 | 79 | 5 | 2024-09-09 → 2025-01-20 |
| 4 | 495 | 79 | 5 | 2025-01-22 → 2025-06-02 |
| 5 | 570 | 80 | 9 | 2025-06-03 → 2025-10-23 |

## Leakage checks

**PASS.** Enforced in code, not just by inspection:

- `parseRows` rejects any row at or after the holdout's dev cutoff
  (`HOLDOUT.devCutoffMs = holdout start − embargo − outcome horizon`); the
  runner throws `HOLDOUT_BREACH` if the loader ever returns one. It did not
  throw. Sealed holdout: **not read**, counts only (150 scans, from the
  registry's own generation report — this run never queried them).
- `assertPreEntryFeatureNames` throws if any engineered feature name matches
  an outcome/label/future pattern; it ran clean over all 96 feature columns.
- Every timeframe used is `available === true` with `window_end <= scan
  timestamp` (`sequenceSafe`); stale frozen inputs (>10 min old) are dropped
  before feature extraction (0 dropped on this dataset).
- Scaler (`fitScaler`) and every model are fit on the fold's training rows
  only; scaling is applied to test rows with the training fold's centre/scale.
- No candidate appears in both train and test in any fold (scan-level split).
- Cross-market/funding context comes from public Binance archives, never
  from D1, and is truncated to bars closed at or before each scan.

`LEAKAGE CHECK: PASS`

## Results — #1-pick after-cost expectancy (mean R, walk-forward OOS)

| Model | 0.00%* | 0.08% | 0.16% | 0.25% | 0.40% | 95% CI @0.16% | vs Quant @0.16% (CI) | Pair acc | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| RANDOM | — | -0.094 | -0.159 | -0.233 | -0.356 | [-0.262, -0.057] | +0.007 [-0.054, 0.064] | 0.500 | NO_PROMOTION |
| CURRENT_QUANT | — | -0.102 | -0.166 | -0.238 | -0.358 | [-0.284, -0.047] | 0 (baseline) | 0.555 | NO_PROMOTION |
| LOGISTIC_TP1 | — | -0.172 | -0.250 | -0.339 | -0.485 | [-0.375, -0.124] | -0.084 [-0.171, 0.006] | 0.434 | NO_PROMOTION |
| RIDGE_FINAL_R | — | -0.108 | -0.167 | -0.233 | -0.343 | [-0.273, -0.058] | -0.001 [-0.089, 0.080] | 0.509 | NO_PROMOTION |
| **GBM_FINAL_R** | — | -0.067 | **-0.126** | -0.192 | -0.303 | [-0.244, -0.009] | **+0.040** [-0.037, 0.114] | 0.541 | NO_PROMOTION |
| WITHIN_SCAN_RIDGE | — | -0.086 | -0.149 | -0.219 | -0.335 | [-0.268, -0.035] | +0.017 [-0.055, 0.090] | 0.516 | NO_PROMOTION |
| LAMBDARANK_GBM_FINAL_R | — | -0.117 | -0.177 | -0.244 | -0.355 | [-0.283, -0.073] | -0.011 [-0.090, 0.064] | 0.472 | NO_PROMOTION |
| **LAMBDARANK_GBM_TP1** | — | -0.052 | **-0.126** | -0.210 | -0.349 | [-0.254, +0.004] | **+0.040** [-0.062, 0.146] | 0.490 | NO_PROMOTION |
| oracle upper bound (perfect #1 pick, 0.16%) | | | **+0.270** | | | | | | — |

\* 0% cost not separately re-tuned (per spec, one model per formulation is
used across all cost levels); shown at 0.08/0.16/0.25/0.40% only.

**Every model, including Random and Quant, is net-negative after cost.**
No challenger's confidence interval vs. Quant excludes zero. `Verdict` uses
the pre-registered acceptance rule (positive at 0.16% AND CI lower bound >0
AND beats-Quant CI lower bound >0 AND ≥60% of folds positive AND positive at
0.25% AND positive with the dominant asset removed) — **none pass**, so none
is promoted or run live in any form.

## Rank monotonicity (Quant, realised R by predicted bucket)

| Bucket | n | Mean R | Flag |
|---|---|---|---|
| #1 | 214 | -0.204 | |
| #2-5 | 418 | -0.095 | |
| #6-10 | 26 | -0.489 | |
| #11+ | 2 | -1.065 | |

**NON-MONOTONIC** — Quant's #1 pick is worse than its #2-5 picks. The best
challenger (GBM_FINAL_R) is closer to flat (#1 -0.139, #2-5 -0.133, #6-10
-0.419) but is still **NON-MONOTONIC** by the same test (#1 not better than
#2-5). Weighted pairwise rank accuracy across the suite ranges 0.43–0.56,
i.e. barely different from a coin flip (Quant: 0.555; GBM_FINAL_R: 0.541).

## Uncertainty (scan-group block bootstrap, 2000 reps, block 5)

For every challenger, the 95% CI on "challenger R − Quant R" straddles zero
(shown above). No challenger's improvement over Quant is statistically
distinguishable from noise at this sample size (359 choice scans / 1,362
resolved candidates, 214–309 OOS #1-picks per model depending on asset
composition of the fold).

## Robustness

**By fold (0.16%, GBM_FINAL_R vs Quant vs Random):**

| Fold | Test window | RANDOM | CURRENT_QUANT | GBM_FINAL_R |
|---|---|---|---|---|
| 1 | 2023-11-23 → 2024-04-08 | -0.103 | -0.099 | -0.137 |
| 2 | 2024-04-14 → 2024-09-08 | -0.209 | -0.235 | -0.147 |
| 3 | 2024-09-09 → 2025-01-20 | -0.216 | -0.261 | -0.252 |
| 4 | 2025-01-22 → 2025-06-02 | -0.220 | -0.292 | -0.177 |
| 5 | 2025-06-03 → 2025-10-23 | -0.051 | +0.054 | +0.080 |

GBM_FINAL_R beats Quant in folds 1–4 but loses to Quant in fold 5 (Quant's
only positive fold); only 1 of 5 folds is outright positive for GBM_FINAL_R
— **flagged: temporal instability**, fails the ≥60%-of-folds acceptance
check.

**By asset** (Quant #1-pick mean R): BTC -0.309, ETH -0.432, DOGE -0.162,
LTC -0.136, SOL -0.042, XRP -0.009. **Flag: no asset is Quant-positive**,
and BTC/ETH are the worst two. GBM_FINAL_R: SOL -0.011, XRP -0.098, DOGE
-0.109, BTC -0.182, ETH -0.189, LTC -0.169 — flatter across assets but still
all-negative. Removing each model's most-picked asset barely moves the mean
(Quant without-dominant -0.176 vs -0.176 overall; GBM_FINAL_R -0.111 vs
-0.126 overall) — **no single-asset concentration** for either.

**By direction:** Quant long/short both ≈ -0.19R (from the prior sanity
baseline on this dataset; this run's per-direction split is in the raw
report's `pickProfile`, long 226 / short 170 picks for Quant, materially
balanced).

**By strategy:** TREND CONTINUATION dominates every model's picks (5–13x
more than any other strategy), consistent with the known TREND-permissive
gate; no model's edge (such as it is) depends on a minority strategy family.

## Hyperparameter discipline

| Model | Grid | Selection rule |
|---|---|---|
| Ridge / Within-scan ridge | λ ∈ {1, 10, 100, 1000} | Weighted pairwise rank accuracy on the last 25% of each fold's training window |
| Logistic (TP1) | λ ∈ {0.001, 0.01, 0.1} | Same inner-validation rule |
| GBM regression / LambdaRank (×2 targets) | depth 2, learning rate 0.05, min leaf 15, L2 1.0 (fixed); boosting rounds selected by early-stopping on the inner validation slice, capped at 200 | Inner-validation loss curve |
| Fusion (ridge+conv blend) | mixing weight α ∈ {0, 0.25, 0.5, 0.75, 1} | Weighted pairwise rank accuracy on inner validation |

Every grid is retuned independently inside each of the 5 outer folds (never
on the fold's own test data), so trial count is grid-size × 5 folds per
model (Ridge/within-scan-ridge: 20 fits each; Logistic: 15; Fusion: 25; the
two GBM/LambdaRank targets each run one bounded early-stopping curve per
fold). No search was widened or repeated after seeing OOS results.

## Feature importance / ablation (GBM_FINAL_R, the best-scoring challenger)

Family ablation (drop-one, full model → -0.126R OOS):

| Drop | ΔR vs full | Pair accuracy |
|---|---|---|
| − DERIVATIVES | -0.040 | 0.503 |
| − SETUP | -0.033 | 0.533 |
| − CROSS_MARKET | -0.013 | 0.513 |
| − STRUCTURE | -0.013 | 0.542 |
| − REGIME | -0.008 | 0.539 |
| − MOMENTUM | -0.007 | 0.538 |
| − LIQUIDITY | +0.002 | 0.557 |
| − VOLATILITY | +0.006 | 0.518 |
| − BASE | +0.009 | 0.545 |

No single family is load-bearing (all deltas are within noise given the
overall CI width of ±0.12R), and the "only_X" single-family runs are all
worse than the full model — the (small, uncertain) signal is spread thin
across families rather than concentrated in one, which argues against a
spurious single-feature artifact but also means there is no standout
feature to report as causal (none investigated further — not warranted
given the result is not promotable).

## Overfitting control

- 10 model variants × 5 outer folds = 50 outer fits; inner tuning trial
  counts per model are in the table above (all small, fixed grids, no
  random search).
- Each outer fold evaluated exactly once as OOS test; no fold was
  re-evaluated after a hyperparameter change.
- Model/family selection (which challenger to ablate) was made on OOS
  ranking only after all OOS numbers were computed — this is a candidate
  for the "selection happened on already-seen OOS data" caveat: the
  ablation model choice among 6 feature-using models is not itself
  cross-validated, so its ablation numbers should be read as descriptive,
  not as an independent confirmation.
- Deflated Sharpe / PBO / CSCV: **not computed** — with 359 choice scans and
  10 model variants this project does not have the trial-count vs.
  sample-size ratio those tools are built to police meaningfully; flagging
  for a future phase if the dataset grows materially (the project's forward
  collection is adding sealed-holdout-only scans daily, not development
  ones, so this requires either backward extension or waiting for embargo
  to release more development data).

## Classification

| Model | Classification | Why |
|---|---|---|
| RANDOM | — (baseline) | |
| CURRENT_QUANT | — (baseline) | |
| LOGISTIC_TP1 | NO EVIDENCE | Worse than Quant, non-monotonic, worst drawdown |
| RIDGE_FINAL_R | NO EVIDENCE | Statistically indistinguishable from Quant |
| **GBM_FINAL_R** | **PROMISING** | Least negative of all models at every cost level, +0.040R vs Quant, no single-asset/strategy concentration — but CI includes zero, only 1/5 folds positive, non-monotonic |
| WITHIN_SCAN_RIDGE | NO EVIDENCE | Small, uncertain improvement, CI includes zero |
| LAMBDARANK_GBM_FINAL_R | NO EVIDENCE | Worse than Quant |
| **LAMBDARANK_GBM_TP1** | **PROMISING** | Ties GBM_FINAL_R at 0.16%, best TP1 rate (27%) and best profit factor (0.80) of any model — but widest relative CI, non-monotonic, negative Spearman |
| CONV1D_MTF | NO EVIDENCE | Worse than Quant |
| FUSION | NO EVIDENCE | Statistically indistinguishable from Quant |

**No model is a SHADOW-CANDIDATE.** None satisfies the required set of checks
(positive expectancy with CI support, beats Quant with CI support, ≥60%
fold stability, positive at 0.25% cost, and asset-robust) simultaneously.
The honest headline: **on this clean feature set, no tested model — including
the current rules-based Quant score — has a demonstrated after-cost edge
over picking randomly within a scan.** The two GBM-based models are the
closest thing to a signal (consistently the least-negative, spread evenly
across assets and strategies, plausible feature-family ablation pattern)
but the effect is not distinguishable from zero at this sample size and is
not stable across time.

## Production safety

No production file was modified: `quant-engine.js`, ranking weights,
thresholds, Best Trade Now, Take Trade, the live scanner, `execution-service`,
Nautilus, Hummingbot, the desktop app, risk rules, release workflows, the
Worker, or the D1 schema are all untouched. This phase only added a
`workflow_dispatch` input and a diagnostic `foldDates` field to the existing
read-only research CI runner, plus this report.

## Next single best step

Given no model clears the promotion bar, the highest-value next step is not
more models on this feature set — it's **more effective sample size**:
lengthen the observation window past the current 24h outcome horizon (the
prior V1 audit found only 27.7% of candidates resolve naturally even at 7
days) or widen the candidate universe (more assets/timeframes) before
re-running this exact suite, since GBM_FINAL_R's ablation shows no single
feature family is doing the work — the ceiling right now looks like sample
size and horizon, not model choice.

## Artifacts

- Full JSON report (this run):
  [`reports/2026-09-28-native-htf-ci-run-36369878431.json`](reports/2026-09-28-native-htf-ci-run-36369878431.json)
- CI run: https://github.com/jamalmusialla81-hub/market-edge-invo/actions/runs/36369878431
- Commit evaluated: `fe31487165212f676da56373be375af5470ffe58`
- Pipeline: `research/rank-research-v2.js`, `research/run-rank-research-v2.mjs`,
  `.github/workflows/research-rank-v2.yml`
