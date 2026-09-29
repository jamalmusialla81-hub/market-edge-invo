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
- **Backups.** Since the final integration phase the shadow store IS in the
  desktop backup (format v2, consistent online snapshot, validated on
  restore); see desktop/DATA_AND_BACKUP.md. There is no cloud copy.
- **Research universe.** Shadow capture observes every market the production
  scan evaluates. Approved research assets it did not evaluate (the 16-asset
  `HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED` universe,
  signal-bridge/research_universe.mjs) are observed research-only on a
  deterministic rotation, at most `SHADOW_SUPPLEMENT_PER_CYCLE` (default 1,
  max 3) per cycle, only if the venue lists them, and never in a cycle whose
  production scan saw data failures. Those rows are stamped
  `OUTSIDE_PRODUCTION_UNIVERSE`, can never be submitted, and do not change
  the production trading universe.
- **Trade Detail link.** An executed paper trade links to its observation by
  `signal_id` (`forward_paper_executed`); Trade Detail shows the observation
  id and resolved/pending horizons, and its hindsight overlay uses the
  observation's post-outcome record only after the trade closed and the 72h
  window resolved.

## DATA 1 gap closure (schema v2)

Most of the field list was already captured; this closes the specific gaps. Additive only, no new trades, no change to candidate generation, ranking or the sealed holdout.

| Gap | Where it lives now |
| --- | --- |
| Git SHA of the running build (distinct from the `generator_version` content hash) | `source_commit` on `shadow_scans`, `shadow_observations`, `forward_execution_quality` (shadow DB) and `risk_sizing_decisions` (paper DB). `dev` in a source checkout. Rows written before this change keep NULL; nothing is backfilled. |
| Fees, slippage, latency to fill, stop overshoot | `forward_execution_quality` (shadow DB, immutable, one row per closed paper trade, first write wins). Copied from the paper ledger's own figures when the trade closes, never recomputed. `field_class = OUTCOME_EVENT`: it is only knowable after the fill, so the leakage guard refuses `execution_quality`, `latency_to_fill_ms`, `stop_overshoot`, `entry_slippage_cost`, `exit_fills` and `fees` as features. |
| Time MFE / MAE were reached | `best_price_at_ms` / `worst_price_at_ms` and a precision label (`TICK`, `STREAM_EXTREME_BY_HEARTBEAT`, `CANDLE_CLOSE_BOUND`), carried in `forward_execution_quality.record` (from #41). |
| Adaptive-exit counterfactuals | Already written by MAJOR 3 to `exit_policy_counterfactuals` (paper DB), keyed by trade id. No extra column was needed. |
| One join key | `signal_id` (= paper `trade_id`) joins `forward_paper_executed`, `forward_execution_quality`, `risk_sizing_decisions`, `risk_sizing_outcomes`, `exit_policy_counterfactuals` and the paper trade. `forward_paper_executed.observation_id` / `scan_id` link back to the shadow observation and scan. `tests/test_data_ingestion.py` proves the join for one real trade and that a missing side is absent (NULL), not mismatched. |

Two databases, one key: the shadow store and the paper ledger are separate SQLite files by design (the shadow store cannot reach the ledger), so the join is by value on `signal_id`, not a foreign key.

A v1 shadow database upgrades in place (`ALTER TABLE ... ADD COLUMN`, nullable). A v1 backup is still a valid restore source; a newer-than-supported database is still refused.

## DATA 2: the data quality gate (schema v3)

`execution-service/market_edge_exec/quality/` gives every forward-data row one verdict: **VALID**, **INVALID**, **UNRESOLVED** or **QUARANTINED**, with machine-readable reasons (`STATUS:REASON`). It classifies; it never edits, repairs or deletes a row.

- **QUARANTINED**: the row itself is damaged. Undecodable blob, decision hash mismatch, NaN/Inf, schema drift (missing column, missing `market` or `candidate`), bad timestamp type, sizing-record hash mismatch.
- **INVALID**: well-formed but breaks a rule. Future timestamp, timestamp order, duplicate observation (same kind/asset/direction/strategy/decision time under different scans; the earliest stays), missing version metadata, cross-venue label substitution (outcome venue differs from the decision venue or from `HYPERLIQUID`), pre-listing history (only when a listing date is supplied; none is available today, so no claim is made), impossible OHLC, the existing snapshot reasons (`STALE_SNAPSHOT`, `NO_MARKET_PRICE`, bad geometry), bad joins (executed row without its observation or paper trade).
- **UNRESOLVED**: fine so far, outcome not final. `resolve.py`'s `PENDING`, `PARTIAL`, `RESOLVED_WITH_GAPS`, `UNRESOLVED_MISSING_CANDLE`, `UNRESOLVED_DATA_UNAVAILABLE` map here; an open paper trade is here too.
- **VALID**: nothing found.

Verdicts go to `data_quality_verdicts` (shadow DB, append-only, immutable triggers). A re-run writes only changes, so a row changes bucket only through a new dated check. `POST /research/data-quality/run` runs it, `GET /research/data-quality` reports counts. Existing checks are reused (snapshot validity, resolution and label statuses); the paper database is opened read-only. DATA 3 should freeze only rows whose latest verdict is VALID. Node-side dataset statuses (`research/dataset-registry.js`) are unchanged.

## DATA 4: the feature registry

`research/feature-registry.js` (`FEATURE-SET-V1`) is a data file documenting every decision-time feature that exists today: the 17-value legacy ML vector from `backend/scan-core.mjs features()`, the shadow point-in-time frame features (13 per timeframe x 5), derivatives (7) and cross-market context (11), each with its calculation reference, source fields, timeframe, lookback, missing-data behaviour, expected range, provenance and allowed use. It computes nothing and is not imported by the scan, Quant engine or paper engine. `research/feature-registry.test.mjs` (in `npm test`) fails if the registry drifts from what the code really produces, if a registered feature is flagged by the hindsight guard, if a listed hindsight or outcome field is not, or if the registry is edited without a `FEATURE_SET_VERSION` bump (pinned content hash). It also checks that the JS and Python guards use the same vocabulary.

Findings while building it: the legacy vector **zero-fills** missing inputs (`?? 0`), so a 0 can mean "unknown"; trainers must treat it that way (recorded as `ZERO_FILLED`). The guard did not flag `giveback_*` or exit-policy counterfactual outcome fields; it now does (`counterfactual_sizing`, which is computed from decision-time inputs, stays allowed).

## DATA 5: the experiment registry (schema v4)

`experiment_events` (shadow DB, append-only) records every research experiment: a `CREATED` event carrying the whole configuration (question, dataset version, feature-set version, model type, hyperparameters, seed, folds, cost assumptions, horizon, cluster resampling, baseline, placebo, source commit), then `STATUS` events with results, confidence intervals and the promotion status. API: `POST /research/experiments`, `POST /research/experiments/{id}/status`, `GET /research/experiments[/{id}]`. Code: `execution-service/market_edge_exec/experiments/registry.py`.

- Lifecycle statuses are the registry's own and the only ones accepted: `PLANNED`, `RUNNING`, `FAILED`, `NO_EVIDENCE`, `PROMISING`, `SHADOW_CANDIDATE`, `REJECTED`, `SUPERSEDED`. Illegal moves are refused (`PLANNED` cannot jump to `PROMISING`; `SUPERSEDED` is final). Nothing changes status by itself.
- `promotion-readiness.js`'s `INSUFFICIENT_EVIDENCE` / `REJECTED` / `KEEP_CHALLENGER` / `PROMOTION_READY` stays its own vocabulary and is recorded whole, unchanged, as the experiment's `promotion_status` (gate `PROMOTION_READINESS_V1`, plus the integrity input it was given). `research/experiment-registry.js` is the first writer; it writes only `RUNNING` and the outcome an evaluation supports and never `SHADOW_CANDIDATE`.
- `SHADOW_CANDIDATE` is refused unless a recorded, known gate output shows it passed (`PROMOTION_READY` or `KEEP_CHALLENGER`, no failed hard integrity gate). Unknown gates and unknown decisions are refused; the registry re-reads the recorded output instead of trusting a flag.
- Repeats are visible: an identical configuration (everything except the free-text question, seed included) is recorded with `repeat_of` and an attempt count, so a favourable re-run cannot hide the earlier ones.

## Drift monitor (DATA 12, DRIFT-V1) — alert-only

`execution-service/market_edge_exec/monitoring/drift.py`. Compares a recent window against a **named, versioned baseline** (stored immutably in `drift_baselines`, schema v5) on: every numeric decision-time feature (top 60 by coverage), volatility features, quant score, realised R, execution cost (fees, entry slippage, stop overshoot, latency), asset mix, strategy mix, rejection reasons, win/loss mix, exit reasons, and per-day activity.

- Statistic: PSI over baseline-decile bins (categories for categorical). Level is judged on PSI minus the expected sampling-noise floor `(k-1)(1/n_base+1/n_cur)`, so unchanged data does not alert on small windows. FLAG above 0.10, ALERT above 0.25 (conventional cut-offs, not tuned). Activity rate: FLAG at 2x, ALERT at 4x, either direction.
- Under 30 samples on either side: `INSUFFICIENT_DATA`, never an alert.
- Output: `NONE / FLAG / ALERT / RECOMMEND_REVIEW` (an execution-cost dimension in ALERT, or 3+ dimensions in ALERT). It never edits a policy, threshold, model or trade. Its only write is the append-only `drift_alerts` row, written when a dimension's level changes.
- Endpoints: `POST/GET /research/drift/baselines`, `GET /research/drift?baseline=NAME&window_days=7`, `GET /research/drift/alerts`.
- Limit: there is no forward trade history yet, so nothing has a real baseline; the tests use synthetic data.

## Dataset expansion scheduler (DATA 13, EXPANSION-SCHEDULER-V1) — proposal only

`research/dataset-expansion/scheduler.mjs`, run monthly by `.github/workflows/research-expansion-rescreen.yml` (or by hand). It reuses `screen-universe.mjs` and `expansion.js` unchanged and only turns the screen report into a proposal for a human: additions (passed every screen rule, ranked by the existing liquidity order, at most 5 per proposal), removals (an approved asset that is no longer an active spot market), and every excluded asset with its failed rules.

- The screen criteria are pinned in `scheduler.mjs`; changing them makes the scheduler refuse to run, so more assets can never be bought by loosening a rule.
- A proposal is not applied. Additions still have to pass the fetch and usability checks (F1-F3, minimum development candidates). Approval is a human commit that adds a **new** dataset version (`proposeDatasetVersion`, status `PROPOSED`, not trainable); an existing version is never edited and a version name is never reused.
- It does not change `signal-bridge/research_universe.mjs`; the forward shadow rotation list only changes by a human editing it, which its own test ties to the dataset manifest.
- Not yet run against the live market list from this environment (no Coinbase access here); the first scheduled run is the manual-validation step.

## Derivatives enrichment (DATA 14, shadow-features-v2 / FEATURE-SET-V2)

Funding, open interest, premium, mark and oracle price were already captured. Added to the same decision-time `derivatives` block: `basis_mark_oracle` (`markPx / oraclePx - 1`) and `basis_mid_oracle` (`midPx / oraclePx - 1`), both against the venue's own oracle in the same snapshot. Each is `null` when an input is missing, empty, zero or non-numeric (a missing mid price is never read as 0). A new `derivatives_provenance` block beside it names the source and formula of every populated value and gives a reason for every missing one. The shadow feature version moved to `shadow-features-v2` and the registry to `FEATURE-SET-V2` (pinned hash updated); nothing was removed, and old rows keep their v1 stamp.

Deliberately not built:
- **Perp/spot divergence** as its own field. The scan data has no spot price for the asset, so it would be the same number as the basis; a proxy from another venue would break the same-venue rule.
- **Liquidation context.** Nothing in the data the scan already fetches is a verified public liquidation feed, so it is recorded as `UNAVAILABLE` in the provenance block. It was not checked against the live Hyperliquid API from this environment (no access); if a trustworthy source is confirmed later it needs its own provenanced field.

No claim that any of this adds edge. It is data for later experiments. Not yet checked on a real live observation from this environment.
