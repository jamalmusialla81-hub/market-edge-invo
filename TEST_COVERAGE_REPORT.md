# Test coverage report

An inventory of what the test suites actually prove, built by reading the test
files on `main` at `9d9ac01` rather than PR descriptions. The most useful
section is the last one: **safety invariants with no direct test**.

Counts were measured locally on 2026-09-28 at `9d9ac01`, plus the two tests
this report adds.

| Suite | Where | Count | Run in CI by |
|---|---|---|---|
| execution-service pytest | `execution-service/tests/` | 204 (202 + 2 added here) | `execution-stack-ci.yml`, `desktop-app.yml` |
| signal-bridge node | `signal-bridge/*.test.mjs` | 52 | `execution-stack-ci.yml`, `desktop-app.yml` |
| desktop vitest | `desktop/src/__tests__/` | 44 | `desktop-app.yml` |
| desktop Rust unit | `desktop/src-tauri/src/*.rs` | 23 | `desktop-app.yml` |
| desktop Rust process integration | `desktop/src-tauri/tests/process_integration.rs` | 3 (real service, real loop, real backup) | `desktop-app.yml` with `MARKET_EDGE_INTEGRATION=1`, Linux and bundled Mac/Windows |
| root `npm test` | 44 script-style files (engines, `research/**`, `backend/**`) | pass/fail per file | `execution-stack-ci.yml` ("Node production test suite") |
| hummingbot bridge | `hummingbot-service/tests/` | contract tests | `execution-stack-ci.yml` Docker job |
| customer beta | `customer-beta/src/lib/*.test.js` | 18 | **none** (see gaps) |

`execution-service/README.md` still says "32 tests". That is stale: the suite
is about 200. Its 15 numbered invariants all still have passing tests; see the
cross-check below.

## By area

### Execution, routing and persistence
- **Tested:** one signal → one order; duplicate `signal_id` blocked in-process and after restart (`test_router_and_persistence.py`); duplicate or out-of-order fill callbacks; cancel after partial fill; restart mid-sequence (`test_failure_modes.py`); a backend timeout fails closed rather than inventing a fill (`test_failure_modes.py`, `test_hummingbot_real_client.py`, `test_paper_engine.py::test_backend_timeout_on_entry_fails_closed`); an exit-backend failure halts and keeps the trade open.
- **Hummingbot:** the factory never silently falls back from real to mock; a non-final order is never reported as a fill (`test_hummingbot_real_client.py`, `test_restart_failures.py`).
- **Kind:** unit tests plus in-process integration through the real FastAPI app (`TestClient`).

### Risk
- **Tested:** size = risk budget / stop distance; leverage never changes size or max loss; leverage walks down until the stop sits inside liquidation, and is never raised above the request (`test_risk_engine.py`, `test_risk_aggregate_and_leverage.py`).
- **Caps:** the 5% position cap binds before the 20% aggregate cap, and four 5% slots exactly fill 20%; racing signals can't both claim the same room; no pyramiding (`test_paper_engine.py`).
- **Loss limits and operators:** the daily loss limit and max concurrent positions hold; operators can tighten but never raise the exposure policy (`test_desktop_api.py`).
- **Kill switch and pause:** the kill switch blocks new intents but still lets a stop close, and survives restart (`test_paper_engine.py::test_kill_switch_survives_restart_blocks_entries_but_lets_stop_close`). Pause blocks entries while exits still process (`test_desktop_api.py`).
- Risk Sizing V2 is not on main (PR #11).

### Stale data and execution prices
- **Tested:** a price older than 120s fails closed with no fallback; stale signals and stale market data are rejected (`test_paper_engine.py`); the Python bridge freshness boundary (`test_signal_bridge.py`).
- **Monitor:** stale, missing or invalid prices fail closed; no contaminated fallback, so an old live price reads as stale, not live; a pre-entry price is never used (`test_position_monitor.py`).
- **Node:** an open position with unreadable market data blocks new risk (`forward_loop.test.mjs`); a monitor data failure flags `MARKET_DATA_OFFLINE` (`position_monitor.test.mjs`).
- **Desktop:** the market-data gate pauses entries (`process_integration.rs::supervisor_recovers_crashes_with_bounds_and_gates_on_market_data`), and the offline banner shows no invented prices (`screens.test.tsx`).

### Position lifecycle and fast monitor
- **Lifecycle:** stop-first on an ambiguous bar; TP1 at 50% then a breakeven stop; TP1 and TP2 in one bar; timeout; short mirror (`test_paper_lifecycle.py`).
- **Exactly once:** TP1, TP2 and stop each fire exactly once; a candle sweep after a tick doesn't repeat TP1; a late print can't fire after an exit; restart doesn't duplicate fills or reset excursions (`test_position_monitor.py`).
- **Node monitor:** it never scans or opens (only open, tick and heartbeat calls); sleeps with no positions; websocket crossing posted at once; poll-only fallback; reconnect backoff (`position_monitor.test.mjs`).

### Shadow learning and research leakage
- **Recording:** every candidate and market state is recorded, including rejected and no-trade ones; ingest is idempotent (`test_shadow.py`, `shadow_capture.test.mjs`).
- **Immutability:** decision snapshots are immutable and hash-verified.
- **Label timing and data:** future labels stay unavailable until the window closes; stop-first ambiguity is preserved; outcomes must share the decision's venue and interval; gaps are never filled.
- **Leakage guard:** hindsight fields are refused as features, both at ingest and in the JS guard, and every emitted label key is known to the guard.
- **Independence:** overlapping observations are clustered, not counted as independent.
- **Capital isolation:** shadow rows can't touch paper equity, exposure or orders; the shadow package can't import execution or the network (`test_shadow.py`, `test_integration_phase.py`).
- **Research universe:** supplement rows can never be submitted; the sealed-holdout definition is unchanged (`research_universe.test.mjs`); holdout and embargo rows never survive parsing, and the holdout is sealed and can be consumed at most once (`research/rank-research-v2.test.js`).
- **Research engine:** lookahead and future multi-timeframe candles are rejected (`research-engine.test.js`, `research/feature-research/*.test.js`).
- **Promotion:** the deterministic gates in `promotion-readiness.test.js` refuse promotion on too few forward days, too little asset or regime diversity, or a failed no-lookahead check.

### Trade Detail
- **Backend:** decision-context levels and entry marker; exit markers on a closed trade; hindsight unavailable before resolution and kept separate after; the candle window never fabricates bars; a candle source failure is reported, not substituted (`test_position_monitor.py`, `test_integration_phase.py`).
- **UI:** level lines, LONG/SHORT labels, live figures, stale banner, hindsight overlay off by default and apart from decision values (`trade-detail.test.tsx`).

### Backup and restore
- **Tested:** real-process export → validate → mutate → restore, plus legacy migration (`process_integration.rs::backup_export_validate_restore_and_legacy_migration`).
- **Shadow database:** the snapshot is consistent and validated, foreign or paper databases are rejected, and no service secret lands in a backup (`test_integration_phase.py`).
- **Migrations:** a database from a newer build is refused untouched; a failed migration rolls back and keeps the backup (`test_migrations.py`).
- **UI:** restore only after typing RESTORE (`screens.test.tsx`).

### Desktop shell and LIVE gating
- **LIVE:** can never be selected (`config.rs::live_can_never_be_selected`, `screens.test.tsx`).
- **Secrets:** API key created once and reused; only allow-listed operator secrets can be written; no keyring falls back to memory, never disk (`secrets.rs`).
- **Supervisor:** crash restarts are bounded (`process_integration.rs`); a conditional resume only lifts a pause with its own reason (`test_desktop_api.py`).

### Rate limiting
- Nothing on main beyond chart-candle 429 backoff (`test_chart_candles_are_cached_and_back_off_after_429`) and shadow resolution stopping on a 429 (`research_universe.test.mjs`). The shared request budget and its 13 tests are in PR #40.

## Cross-check: `execution-service/README.md` 15 invariants

| # | Invariant | Test still present and passing |
|---|---|---|
| 1 | JS/Python contract round-trip | `test_js_python_parity.py` (3) |
| 2 | one signal → one order | `test_one_signal_produces_exactly_one_order` |
| 3 | duplicate blocked | `test_duplicate_signal_is_blocked_within_the_same_process` |
| 4 | duplicate blocked after restart | `test_duplicate_signal_is_still_blocked_after_a_simulated_restart` |
| 5 | risk rejection prevents backend call | `test_risk_rejection_prevents_backend_call` (+ risk-engine variant) |
| 6 | leverage ceiling | `test_leverage_ceiling_enforced_at_router`, `test_leverage_ceiling_is_enforced_even_when_intent_requests_more` |
| 7 | partial fill updates position | `test_partial_fill_updates_position_correctly` |
| 8 | cancel reconciles | `test_cancel_reconciles_once_both_sides_show_zero_position` |
| 9 | reject reconciles | `test_reject_reconciles_and_is_visible_as_a_missing_fill_...` |
| 10 | orphan order | `test_orphan_order_detected` |
| 11 | unknown position | `test_unknown_position_detected` |
| 12 | quantity mismatch | `test_quantity_mismatch_detected` |
| 13 | restart restores positions | `test_restart_restores_persisted_positions` |
| 14 | divergence → safe halt | `test_reconcile_divergence_halts_new_intents` |
| 15 | kill switch blocks new intents | `test_kill_switch_blocks_new_intents_at_router`, `test_kill_switch_blocks_new_intents` |

## Safety invariants with no direct test

Findings, most important first:

1. **Every service endpoint requires the API key.** Before this report, only a hand-maintained list of 12 endpoints was checked (`test_desktop_api.py`), so `/shadow/*`, `/paper/tick` and newer routes had no auth test. **Added:** `tests/test_coverage_gaps.py::test_every_route_except_health_rejects_a_missing_api_key`. It walks the app's real route table (39 routes on main) and found **no unauthenticated route**.
2. **Immutability of shadow labels, hindsight and forward-paper-executed rows.** Only `shadow_observations` and `shadow_scans` were tampered with in tests, although the store installs triggers on all five `IMMUTABLE` tables. **Added:** `test_every_immutable_shadow_table_refuses_update_and_delete`, which covers all five with real rows. All refuse.
3. **Customer-beta tests are not run by CI.** 18 tests in `customer-beta/src/lib/*.test.js` pass locally (`node --test`), but `deploy-customer-beta.yml` only builds, and no workflow runs them. A regression there would ship unnoticed. This is a follow-up (a workflow change, outside this task's lock).
4. **The Worker's "no automatic champion promotion" has no test.** `backend/worker.mjs` records `PROMOTION_READY` reports with `autoChampionPromotion:false` and writes a lifecycle event of `CHALLENGER → PROMOTION_READY`, never `CHAMPION`. `backend/worker.test.mjs` never exercises the readiness endpoint. The engine gates are tested (`promotion-readiness.test.js`); the storage path that must never promote is not. This is a follow-up.
5. **No test pins "production candidate generation unchanged".** Shadow rows stamp a `generator_version` hash of `scan-core.mjs`, and `scan-core.test.mjs` tests behavior, but nothing fails when `scan-core.mjs` or `quant-engine.js` changes. The roadmap wants silent generator changes caught, but a byte pin would also block intended changes, so this is an owner decision rather than an obvious test. Flagged only.
6. **Stale README count.** `execution-service/README.md` "Test count: 32". Documentation only.

Items 3 and 4 are filed as follow-up SIDE tasks #47 and #48.
