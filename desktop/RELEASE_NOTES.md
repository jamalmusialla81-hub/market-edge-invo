# Market Edge desktop 0.2.0 (paper trading only)

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
