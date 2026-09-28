# Dataset expansion v1 — report (2026-09-28)

**Question:** can the research universe grow in a clean, natural way, without
changing the strategy or manufacturing samples, so ranking has more
independent choice scans?

**Answer: yes, and it does not fix the ranking problem by itself.** The
frozen generator, labels, holdout and models are untouched; only the asset
list grew. Development choice scans went **359 → 609** (+70%) and candidates
per choice scan **2.96 → 4.12**. Growth is proportional across years and
market regimes, not concentrated in one period, and no added asset is a
near-duplicate of an existing one. Random, Quant and the frozen GBM baselines
move in the same direction as before; the frozen GBM regression edges closer
to beating its own placebo (p 0.05 → 0.10, win% vs Quant 80.5% → 94.5%) but
still fails the pre-registered gate on both datasets. Detecting a real
+0.04R effect still needs roughly 3,300 independent OOS choice-scan groups;
expansion gets from 214 to 358 achieved (effective, autocorrelation-adjusted)
— about 6% → 11% of the way there.

- Pre-registration (committed before any candidate asset's candles were
  fetched): [`PREREGISTRATION.md`](PREREGISTRATION.md) (commit f014498)
- CI run: [36377309789](https://github.com/jamalmusialla81-hub/market-edge-invo/actions/runs/36377309789),
  code at 2b03707, full JSON: [`reports/expansion-run-36377309789.json`](reports/expansion-run-36377309789.json)
- Read-only: 6 old assets replayed from the audited archive (run 36313185824);
  1,362 D1 development rows read (SELECT only) for the reproduction gate;
  sealed holdout counted only (never resolved). No production file changed.
- Dataset artifact (not written to D1): `historical-rank-v2-clean-native-htf-expanded`
  on the CI run, plus [`reports/dataset-manifest.json`](reports/dataset-manifest.json).

## 1. Universe screen (Phase 2)

488 Coinbase USD spot products screened on native daily candles only
(outcome-free). 15 passed every rule (S1–S6) and were fetched at 5m/1h/1d
resolution; 5 failed after the fetch and are excluded, never fabricated:

| asset | reason |
|---|---|
| AAVE, BONK, ICP, JASMY | 5m coverage < 99% from first candle (F1) |
| TIA | 18 rankable development candidates < the pre-registered minimum of 30 |

**10 assets added:** ADA, AERO, AVAX, BCH, DOT, HBAR, LINK, ONDO, UNI, XLM.
Screen failure counts across all 488 products: liquidity 354, too-short
history 199, not-pegged/active 191 combined, daily coverage 77,
structural break 4 (full detail in
[`reports/screen-report.json`](reports/screen-report.json)).

## 2. Reproduction and leakage

The 6 old assets were regenerated from the same audited archive with the
same frozen generator (`historical-rank-v2-clean.js`, unmodified — sha256
recorded in the report's `meta.frozenFiles`). All **1,362/1,362** stored
D1 development rows reproduced exactly (scan, asset, strategy, direction,
entry, stop, Quant score, FINAL_R) — **PASS**. Point-in-time regeneration
(archive truncated at each sampled scan timestamp) matched for every
included asset, old and new — **PASS**. Feature and label windows close at
or before the scan, the label window for every development row ends before
the holdout start, and no row at or after the development cutoff was ever
produced — **leakage PASS**.

## 3. Diversity value and redundancy (Phases 4, 9) — outcome-free / structural

Before any label was read, each new asset had to add genuinely new choices,
not just correlated duplicates. All 10 do: 29–46% of a new asset's own
candidate scans create a new choice (turn a single-candidate scan into a
choice, or add a direction/strategy absent among the old six), and 10–42 of
its scans per asset have **no** old-asset candidate at all — a scan that
without it produces zero candidates, not extra rows on the same call.

Redundancy clustering (daily-return correlation, cut at 0.8) found **no
merges**: every one of the 16 assets is its own cluster. No asset scored
**HIGH** redundancy; all fall in **MEDIUM** except AERO (**LOW**). The
tightest pair is still the pre-existing BTC/ETH (0.84 daily-return
correlation), not any new asset.

## 4. OLD vs EXPANDED (Phases 7–8)

| | OLD | EXPANDED |
|---|---|---|
| Development scan groups | 659 | 852 |
| **Choice scan groups** | **359** | **609** |
| Candidates (rankable) | 1,362 | 2,754 |
| Candidates per choice scan (median / p25 / p75 / max) | 3 / 2 / 3 / 12 | 3 / 2 / 5 / 20 |
| Share of choice scans with exactly 2 candidates | 48.5% | 33.8% |
| Assets per choice scan (mean) | 2.47 | 3.54 |
| Directions per choice scan (mean); both directions | 1.35; 34.8% | 1.40; 39.9% |
| Strategies per choice scan (mean); one strategy only | 1.75; 38.7% | 1.84; 37.1% |
| Top-2 (Quant) same direction / same asset / same strategy | 80.5% / 18.7% / 55.7% | 81.4% / 12.0% / 59.6% |
| Cross-asset same-direction outcome correlation | 0.489 (862 pairs) | 0.473 (4,305 pairs) |
| Between-scan variance share of FINAL_R | 49.7% | 43.6% |
| Within-scan outcome dispersion (median sd) | 0.656R | 0.762R |

More independent alternatives, not just more rows: candidates-per-scan grew,
the exactly-2 share shrank, assets-per-scan grew, and the share of outcome
variance that is shared by the whole scan (rather than distinguishing
between candidates) fell 6 points. Same-direction correlation did not rise.

### Temporal diversity (Phase 10)

Choice scans by year, OLD → EXPANDED: 2022 83→140, 2023 78→127, 2024
110→171, 2025 88→171 — roughly +50-70% every year, not concentrated in one
period. By BTC-derived regime (point-in-time 60-day trend / 30-day
volatility): BEAR/HIGH_VOL 63→107, SIDEWAYS/HIGH_VOL 64→112, SIDEWAYS/LOW_VOL
110→182, BULL/LOW_VOL 54→90, BULL/HIGH_VOL 54→96, BEAR/LOW_VOL 14→22 — every
regime cell grew, none newly created or emptied.

## 5. Sanity baselines, same instruments, no tuning (Phase 11)

#1-pick mean R, cost-swept:

| model | 0.00% | 0.08% | 0.16% | 0.25% | vs Quant @0.16% [95% CI] | monotonicity |
|---|---|---|---|---|---|---|
| OLD Random | -0.028 | -0.094 | -0.159 | -0.233 | +0.007 [-0.054, 0.064] | NON-MONOTONIC |
| OLD Current Quant | -0.038 | -0.102 | -0.166 | -0.238 | — | NON-MONOTONIC |
| OLD GBM regression (BASE) | -0.011 | -0.070 | -0.128 | -0.194 | +0.038 [-0.044, 0.121] | NON-MONOTONIC |
| OLD GBM ranker (BASE) | +0.008 | -0.065 | -0.137 | -0.218 | +0.029 [-0.063, 0.122] | NON-MONOTONIC |
| EXPANDED Random | -0.021 | -0.078 | -0.134 | -0.198 | +0.010 [-0.059, 0.076] | WEAKLY MONOTONIC |
| EXPANDED Current Quant | -0.036 | -0.090 | -0.144 | -0.205 | — | NON-MONOTONIC |
| EXPANDED GBM regression (BASE) | +0.016 | -0.029 | -0.074 | -0.124 | +0.070 [-0.013, 0.158] | WEAKLY MONOTONIC |
| EXPANDED GBM ranker (BASE) | -0.044 | -0.110 | -0.176 | -0.251 | -0.032 [-0.132, 0.070] | NON-MONOTONIC |

Same reproduction as the earlier phases: OLD Random −0.159R, OLD Quant
−0.166R at 0.16% match exactly. Everything is less negative on EXPANDED
(more assets means the average candidate is a little better, not that
ranking improved) — the number to read is the model vs Quant delta and its
CI, not the absolute level. GBM regression's CI still crosses zero on both
datasets; its win rate vs Quant rose 80.5% → 94.5% and monotonicity moved
from NON-MONOTONIC to WEAKLY MONOTONIC, but the ranker's edge disappeared on
EXPANDED (94.5% → 26.2% win rate) — inconsistent across the two frozen
instruments, so this is not yet a claim of skill.

## 6. Placebo gate — mandatory (Phase 12)

Each learned model re-run 19 times with its BASE feature columns permuted
jointly across candidate rows (same procedure as feature-research v1):

| dataset / model | real R@0.16% | placebo p | beats Random CI | beats Quant CI | verdict |
|---|---|---|---|---|---|
| OLD GBM regression | -0.128 | 0.05 | NO | NO | **FAIL** |
| OLD GBM ranker | -0.137 | 0.30 | NO | NO | **FAIL** |
| EXPANDED GBM regression | -0.074 | 0.10 | **YES** | NO | **FAIL** |
| EXPANDED GBM ranker | -0.176 | 0.95 | NO | NO | **FAIL** |

No model passes the gate on either dataset. EXPANDED's GBM regression is the
closest it has been (placebo p 0.05 → 0.10 sounds worse in isolation, but its
real score also moved further from the placebo band's mean, and it now
clears the Random-CI bar it missed before) — still short of the Quant-CI bar
the gate requires. The gate stays mandatory; this is not a promotion.

## 7. Power / precision (Phase 13)

Scan-level, autocorrelation-adjusted (σ inflated by the lag-1 factor;
EXPANDED's lag-1 autocorrelation is 0.035 vs OLD's -0.053):

| effect | OLD: scans for CI excl. 0 / for 80% power | achieved (OLD, 214 scans) | EXPANDED: scans for CI / 80% power | achieved (EXPANDED, 358 scans) |
|---|---|---|---|---|
| +0.02R | 13,109 / 26,783 | 1.6% / 0.8% | 13,431 / 27,441 | 2.7% / 1.3% |
| +0.04R | 3,278 / 6,696 | 6.5% / 3.2% | 3,358 / 6,861 | 10.7% / 5.2% |
| +0.06R | 1,457 / 2,976 | 14.7% / 7.2% | 1,493 / 3,049 | 24.0% / 11.7% |
| +0.08R | 820 / 1,674 | 26.1% / 12.8% | 840 / 1,716 | 42.6% / 20.9% |

The achieved fraction of the sample needed roughly doubles at every effect
size. Required N barely moved (σ per scan is almost unchanged, 1.168R →
1.142R) — expansion helps by growing achieved N, not by shrinking the
variance a single choice scan carries.

## 8. Forward collection (Phase 14)

Unchanged: the daily `forward` stage in `phase5-v2-clean.yml` keeps
collecting the old six assets on the native-HTF policy into the sealed
holdout period; this phase does not touch it and adds no forward collection
for the new assets (a future phase, not pre-registered here).

## 9. Do-not-touch

Production Quant, ranking, execution-service, Nautilus, Hummingbot, desktop
app, risk limits, release workflow, live/mainnet mode, and the sealed
holdout (2025-12-01, unchanged) were not read for outcomes and not modified.

## Next single best step

Keep growing N the same way (a second screen pass after more history
accrues, and starting daily forward collection on the 10 added assets) while
holding the model search frozen — the placebo gate is the thing to watch,
not the raw R numbers, which move for reasons unrelated to skill (more
assets shifts the average candidate).
