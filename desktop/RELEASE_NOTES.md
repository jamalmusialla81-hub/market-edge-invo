# Market Edge desktop 0.1.0 (paper trading only)

First standalone release of the Market Edge desktop app.

## Supported

- **macOS on Apple Silicon (M1 or newer).** Intel Macs and Linux are not supported.
- Windows x64 installers are attached only when the release says so below.

## What it is

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
