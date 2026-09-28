# Market Edge architecture (end to end)

This page connects the pieces. It follows one scan from market data to a paper
trade, its management, its shadow research record, backup and the research
pipeline, and links to the source and to the per-area docs for detail. It
describes `main` at `9d9ac01`. Everything is **PAPER only**: no code path
places a real-money order, and LIVE cannot be selected
(`desktop/src-tauri/src/config.rs`, `PAPER_ONLY = True` in
`execution-service/market_edge_exec/api/app.py`).

> **Keep this current.** Update this page when Risk Sizing V2 (MAJOR 2, #15 /
> PR #11), rate-limit resilience (MAJOR 1, #14 / PR #40) or adaptive exits
> (MAJOR 3/4) merge. The "Not on main yet" section below lists what will change.

## The flow

```
                    public market data (Hyperliquid info API; Binance, Coinbase candles)
                                   │
 ┌─ signal-bridge/forward_loop.mjs  (DISCOVERY, every 5 min) ───────────────────────────────┐
 │  1. /paper/mark: advance open trades through completed 5m candles (backstop)             │
 │  2. fetch_signal.runOnce ─▶ backend/scan-core.mjs runLiveScan  (unmodified production)   │
 │                              └─▶ quant-engine.js evaluateRankedSetup / evaluateSetupCandidates
 │  3. shadowObserve ─▶ shadow_capture.buildShadowPayload ─▶ POST /shadow/scan  (research)   │
 │                     + research_universe supplement scan (OUTSIDE_PRODUCTION_UNIVERSE)     │
 │                     + GET /shadow/pending ─▶ candles ─▶ POST /shadow/resolve             │
 │  4. no rank-1 candidate ─▶ POST /paper/no-trade      rank-1 ─▶ POST /paper/signal         │
 │  5. reconcile                                                                              │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ HTTP, X-API-Key, 127.0.0.1
 ┌─ execution-service (Python, FastAPI) ─────────────────────────────────────────────────────┐
 │  /paper/signal ─▶ paper/engine.py PaperEngine.open_from_signal                             │
 │      freshness + duplicate checks ─▶ risk/engine.py approve()  (size = budget / stop)      │
 │      ─▶ routing/router.py ExecutionRouter.route  (idempotent by signal_id, kill switch)    │
 │      ─▶ PaperBackendAdapter ─▶ nautilus/portfolio.py NautilusPortfolio  (canonical state)  │
 │      ─▶ paper/ledger.py PaperLedger  (SQLite: trades, events, signals, hindsight)          │
 │  /paper/tick, /paper/mark ─▶ paper/lifecycle.py  (stop / TP1 50% + breakeven / TP2 / timeout)
 │  /shadow/* ─▶ shadow/store.py ShadowStore  (own SQLite file) + shadow/resolve.py labels     │
 │  reconciliation/reconcile.py  (halts on divergence, never auto-fixes)                      │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
                                   ▲
 ┌─ signal-bridge/position_monitor.mjs  (OPEN POSITIONS, ~10s, only while ≥1 is open) ────────┐
 │  Hyperliquid trades websocket + one batched allMids heartbeat ─▶ POST /paper/tick          │
 └────────────────────────────────────────────────────────────────────────────────────────────┘

 ┌─ desktop (Tauri + React) ─────────────────────────────────────────────────────────────────┐
 │  Rust controller spawns + supervises execution-service and forward loop (supervisor.rs),  │
 │  market-data probe pauses entries when offline, backup/restore (backup.rs), UI screens    │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Components

**Scanner.** [`backend/scan-core.mjs`](../backend/scan-core.mjs) `runLiveScan` is the
production scan used by the web product. It reads Hyperliquid, Binance and
Coinbase candles, scores five timeframes and applies the feed-agreement and
price-disagreement downgrades. The paper stack imports it **unmodified and
read-only** through [`signal-bridge/fetch_signal.mjs`](../signal-bridge/fetch_signal.mjs)
(`runOnce`, `bestTradeNowToAlphaSignal`).

**Quant.** [`quant-engine.js`](../quant-engine.js) is the hand-written rule engine:
regime, strategy candidates, levels and risk plan (`evaluateRankedSetup`,
`evaluateSetupCandidates`). It is not a trained model. An optional ML weight in
`scan-core.mjs` `withMl` applies only when a registered model is active. The
optional GPT chart review in the web app can only downgrade a verdict. See
[`AI_ARCHITECTURE.md`](../AI_ARCHITECTURE.md).

**Discovery loop.** [`signal-bridge/forward_loop.mjs`](../signal-bridge/forward_loop.mjs)
runs every 5 minutes (`CYCLE_INTERVAL_MS`). It is the only component that scans,
ranks and opens trades. At most one production selection per scan is submitted.
If live data for an open trade can't be read, no new risk is opened that cycle.
Market data reads live in [`signal-bridge/market_data.mjs`](../signal-bridge/market_data.mjs).

**Shadow learning (research only).** [`signal-bridge/shadow_capture.mjs`](../signal-bridge/shadow_capture.mjs)
turns each scan into observations for every candidate and market state,
whatever execution decided. [`signal-bridge/research_universe.mjs`](../signal-bridge/research_universe.mjs)
adds a rotating supplement of approved research assets that is never
submittable. The service stores them in
[`shadow/store.py`](../execution-service/market_edge_exec/shadow/store.py), a separate SQLite file
whose decision rows are immutable and hash-checked. The same module labels
them only after each window closes, using the pure functions in
[`shadow/resolve.py`](../execution-service/market_edge_exec/shadow/resolve.py). Decision-time data,
future labels and post-outcome hindsight stay in separate tables, and hindsight
names are refused as features. Shadow data uses no paper capital. See
[`research/SHADOW_LEARNING.md`](../research/SHADOW_LEARNING.md).

**Risk sizing (legacy, authoritative on main).** [`risk/engine.py`](../execution-service/market_edge_exec/risk/engine.py)
`approve()` enforces size = risk budget / stop distance. Leverage changes margin,
never the allowed loss. Exposure and position caps come from `RiskLimits`, and
operators can tighten or loosen them inside the bounds in
[`control/settings.py`](../execution-service/market_edge_exec/control/settings.py).

**Execution service.** [`execution-service/`](../execution-service/README.md) is a FastAPI app
([`api/app.py`](../execution-service/market_edge_exec/api/app.py)):
- **Paper engine.** [`paper/engine.py`](../execution-service/market_edge_exec/paper/engine.py)
  `PaperEngine` runs validate → risk → route → fill → persist for entries and exits.
- **Router.** [`routing/router.py`](../execution-service/market_edge_exec/routing/router.py)
  `ExecutionRouter` is idempotent through the `intents` primary key in
  [`persistence/store.py`](../execution-service/market_edge_exec/persistence/store.py).
- **Canonical positions.** Positions and PnL live in
  [`nautilus/portfolio.py`](../execution-service/market_edge_exec/nautilus/portfolio.py)
  `NautilusPortfolio`, built on real Nautilus value types. The paper fill adapter is
  `PaperBackendAdapter` in `api/app.py`.
- **Hummingbot.** It is execution transport only, selected explicitly in
  [`hummingbot/factory.py`](../execution-service/market_edge_exec/hummingbot/factory.py), and is
  mocked on main.
- **Ledger.** The paper ledger and hindsight live in
  [`paper/ledger.py`](../execution-service/market_edge_exec/paper/ledger.py).
- **Migrations.** [`persistence/migrations.py`](../execution-service/market_edge_exec/persistence/migrations.py).

The JS contract layer these modules mirror is
[`research/execution-architecture/`](../research/execution-architecture/README.md).

**Position lifecycle.** [`paper/lifecycle.py`](../execution-service/market_edge_exec/paper/lifecycle.py)
has pure functions that mirror production's forward-paper model:
- stop-first when a bar is ambiguous
- 50% exits at TP1, and the stop moves to breakeven
- the remaining 50% exits at TP2
- a max-hold timeout

Signal geometry is never altered.

**Fast open-position monitor.** [`signal-bridge/position_monitor.mjs`](../signal-bridge/position_monitor.mjs)
runs about every 10s and only while a position is open. Price comes from:
- the Hyperliquid trades websocket
- one batched `allMids` heartbeat
- the discovery loop's candle sweep as the last backstop

It never scans or opens trades. Trade Detail renders its figures through
[`paper/trade_detail.py`](../execution-service/market_edge_exec/paper/trade_detail.py).

**Reconciliation.** [`reconciliation/reconcile.py`](../execution-service/market_edge_exec/reconciliation/reconcile.py)
compares ledger and canonical state after each cycle. A divergence halts new
execution until a human resolves it.

**Desktop app.** [`desktop/`](../desktop/README.md) is a Tauri shell with a React UI in
`desktop/src/screens/`. The Rust controller
([`src-tauri/src/lib.rs`](../desktop/src-tauri/src/lib.rs)) holds the API key in the OS keychain
([`secrets.rs`](../desktop/src-tauri/src/secrets.rs)). [`supervisor.rs`](../desktop/src-tauri/src/supervisor.rs)
restarts crashed services within bounds and pauses entries on recovery or when
market data is offline. It only lifts pauses it set itself.

**Backup.** [`desktop/src-tauri/src/backup.rs`](../desktop/src-tauri/src/backup.rs)
writes a local `.mebackup` zip containing:
- a consistent snapshot of the paper database
- the shadow research database
- non-secret settings
- a manifest with versions, checksums and counts

Restore validates everything first and keeps the previous databases. No secrets,
no cloud. See [`desktop/DATA_AND_BACKUP.md`](../desktop/DATA_AND_BACKUP.md).

**Research pipeline.** [`research/`](../research) holds the offline work: dataset
generation and registry (`dataset-registry.js`, `historical-rank-v2-clean.js`),
rank and model research (`rank-research-v2.js`, `research/model-research/`), feature
research (`research/feature-research/`) and dataset expansion
(`research/dataset-expansion/`). A sealed holdout is never resolved, and no model
is promoted while the placebo gate fails. See
[`RESEARCH_ARCHITECTURE.md`](../RESEARCH_ARCHITECTURE.md) and
[`research/RANK_RESEARCH_V2.md`](../research/RANK_RESEARCH_V2.md).

**Web product (context).** The GitHub Pages frontend
([`market-edge.html`](../market-edge.html)), the Cloudflare Worker
([`backend/worker.mjs`](../backend/worker.mjs), D1 candle store) and the customer beta
([`customer-beta/`](../customer-beta)) share `scan-core.mjs` and `quant-engine.js` but
are separate from the paper execution stack above.

## Not on main yet

| Area | Status | Where |
|---|---|---|
| Risk Sizing V2 (planned-loss sizing, SHADOW first) | open PR, not merged | PR #11, MAJOR 2 #15, `research/RISK_SIZING_V2.md` on that branch |
| Shared Hyperliquid request budget + 429 backoff | open PR, not merged | PR #40, MAJOR 1 #14 |
| Adaptive exit layer (breakeven, MFE giveback trails, vol-aware trailing…) | **planned, not built**; shadow/counterfactual first | MAJOR 3/4 (#16–#24) |
