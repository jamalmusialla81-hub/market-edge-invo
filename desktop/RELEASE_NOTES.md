# Market Edge desktop 0.3.0 (paper trading only)

Unsigned pre-release. Everything below is research or display only: it never
changes a paper trade and no model or exit policy has evidence yet.

## What's new since 0.2.0

- **Research screen.** Read-only status of what is production, what is running
  in shadow and what is post-outcome research, kept in three separate sections.
  No controls.
- **Forward-shadow research pipeline (backend).** Data quality gate, versioned
  training snapshots, experiment registry, drift and strategy-health monitors,
  walk-forward evaluation, a mandatory placebo gate, shadow challenger
  deployment, forward validation with explicit evidence floors, an
  evidence-gated policy lifecycle (no LIVE state; forward moves need a logged
  human authorization), replay report, counterfactual portfolio analysis and a
  learning-loop orchestrator that stops at the authorization boundary.
  Shadow database schema is now v7.
- **Trade chart and Trade Detail.** MFE/MAE markers with the time reached,
  intermediate time ticks, an exit-policy counterfactual overlay (off by
  default, labelled research only), Trade Detail shows when MFE/MAE was reached.
- **System screen.** Rate-limit diagnostic panel and a backup summary.
- **Decision semantics.** Candidates now carry the decision-semantics fields
  next to the strict verdict, with a legacy mapping. Display and research only;
  no trade decision changed.
- **Trade Detail: "Why did this trade exit?"** Each exit is explained, and the
  exit reasons that cannot be told apart from the recorded data are said so.
- **Evidence and audit tooling (backend, read-only).** Forward evidence
  sufficiency engine, paper/shadow/execution linkage audit, execution friction
  (expected vs actual), stop-overshoot record and report, a shared liquidity
  walk with an execution-feasibility stage, dynamic correlation-cluster
  candidates (never looser than the static clusters), and a drawdown recovery
  state machine that runs in shadow only.
- **Adaptive exit research, extended (still shadow only).** Fixed-structure
  lifecycle variants (split take-profit, timeouts) join the candidate exit
  policies. New exit-replay completeness check: every paper trade is labelled
  complete, legacy (opened before the exit shadow existed), incomplete or
  missing replays, and only complete-path trades can count toward the exit
  evidence bar. The bar itself is unchanged and no exit policy has evidence.
  New read-only endpoint `/research/exit-policies/integrity`.

## Honest status

- None of the research pipeline has run on real forward data yet; it is tested
  on synthetic fixtures. No challenger model is deployed.
- The Risk panel, Trade Detail and Research screen were not manually validated
  in a running app before this release.
- Unsigned: macOS may warn on first open.

---

# Previous release: Market Edge desktop 0.2.0 (paper trading only)

Second release of the standalone Market Edge desktop app.

## What's new since 0.1.0

- **Shadow learning.** Every scan candidate and market state is recorded as an
  immutable, hashed observation next to your paper trades (own database file,
  included in backup v2). Shadow rows never use paper capital and never place
  orders. New Shadow screen with filters (asset, direction, strategy, rank,
  resolution, dates, episode/cluster).
- **Fast open-position monitor and Trade Detail.** Open positions are watched
  live (websocket prints plus a 10-second reconciliation). Click a trade for a
  candlestick chart with entry, stop, TP1 and TP2, live figures, and an
  optional research overlay that is off by default and labelled as hindsight.
- **Profit giveback.** Trade Detail now shows how much of the peak unrealized
  profit a trade has given back.
- **Rate-limit resilience.** One shared request budget with backoff, request
  de-duplication and priorities (open-position monitoring first, chart history
  last), so a temporary Hyperliquid rate limit defers discovery instead of
  looking like an outage. Stale data still fails closed.
- **Research export.** System > Research export writes a read-only CSV or Parquet
  folder of the shadow and paper data, with decision-time, outcome and
  hindsight columns kept in separate files.
- **Versions panel.** About shows the app and service build, shadow schema,
  label and classification versions, with a copy button for support.
- Dashboard "Leverage" is now "Gross exposure".

- **Risk Sizing V2 (shadow mode).** Position size can follow a planned-loss
  budget per trade (stop distance plus execution costs, hard caps that can only
  cut size). In this release it runs in **SHADOW mode**: the existing 5% sizing
  still decides every paper trade, and V2 is recorded next to it as an immutable
  counterfactual. The Risk screen shows the V2 panel and Trade Detail shows a
  Risk sizing section, labelled research only. A 15% drawdown pauses new entries.
- **Adaptive exit research (shadow only).** For every new paper trade the app
  records the prices it watched and replays 17 candidate exit policies
  (breakeven, giveback trails, volatility trail, post-TP1 protection, momentum
  and time decay) beside the real trade. These are counterfactual research
  records: they never change a real exit, use no capital and are not shown as
  fills. No policy has evidence yet.


## Supported

- **macOS on Apple Silicon (M1 or newer).** Intel Macs and Linux are not supported.
- Windows x64 installers are attached only when the release says so below.

## What it is (unchanged from 0.1.0)

- A standalone desktop app: no Python, Node or repository checkout needed. The
  execution service (with the full NautilusTrader package bundled and self-tested at build time) and
  the forward paper loop ship inside the app.
- **Paper trading only.** LIVE mode is disabled in this build and there is no
  slot for mainnet credentials. TESTNET mode is also disabled: the app can store
  Binance USDT-M Futures testnet keys in the Keychain for later, but no testnet
  backend is wired into the app yet.
- Architecture: Market Edge signals → NautilusTrader (canonical portfolio, risk,
  positions, PnL) → execution router → paper backend. The Hummingbot bridge is
  execution transport only and is not bundled in the app (disabled in this build).
- Persistent local state in your user app-data folder, with schema migrations
  (backup taken before every migration), backup and restore, crash restart with
  reconciliation, and in-place updates that keep your data.
- Offline safety: if market data is unreachable the app pauses new entries and
  never invents prices.
- The execution-service API key is kept in the macOS Keychain.

## Research foundation

- The contaminated HISTORICAL-RANK-V1 dataset is invalidated and its workflows
  are retired.
- The clean HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF dataset (genuine venue candles,
  full provenance, freshness guards, sealed holdout) is the research base.
- No model has been promoted to production. On the clean data the current Quant
  ranking shows no measurable edge over random selection. Nothing in this
  release claims profitability or validated alpha.
