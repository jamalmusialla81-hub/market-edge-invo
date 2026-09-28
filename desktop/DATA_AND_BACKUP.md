# Market Edge desktop: persistent data, backup and API budget

Audit written during the final integration phase (2026-09-28). Everything here
is paper/research data. LIVE and mainnet stay disabled.

## Persistent data

All mutable state lives in the OS app-data directory
(`~/Library/Application Support/Market Edge/` on macOS,
`%APPDATA%\Market Edge\` on Windows, `~/.local/share/Market Edge/` on Linux).
The installed app bundle is never written to.

| File / store | Purpose | In backup | Restorable | Sensitive |
|---|---|---|---|---|
| `market_edge_paper.sqlite3` | Paper ledger and execution record: paper account, positions and trades (entry, original stop/TP1/TP2, `tp1_hit`, TP1 fill time and price, remaining quantity, stop/TP2 status, MFE/MAE, monitor state), accepted/rejected signals with their decision-time meta (scan_id, scores, model/feature versions, price provenance), no-trade records, equity history, risk settings, reconciliation log, execution intents and fills | Yes | Yes | No secrets |
| `market_edge_shadow_research.sqlite3` | Shadow learning research store: `FORWARD-SHADOW-RAW-V1` (every scan, candidate and market state, immutable decision snapshots with hashes), `FORWARD-SHADOW-RESOLVED-V1` (per-horizon labels, post-outcome hindsight), `FORWARD-PAPER-EXECUTED-V1` (signal_id to observation link), resolution progress, generator/feature/model versions and market provenance on every row | **Yes (new in backup format v2)** | Yes | No secrets |
| `config.json` | Non-secret desktop settings (auto-start paper, versions seen) | Yes (`settings.json`) | Settings are informational | No |
| `logs/*.log` | Rotated desktop, execution-service, forward-loop and reconciliation logs | No (diagnostics, rebuilt continuously) | n/a | No secrets are logged |
| `backups/` | Automatic pre-migration and pre-restore copies of both databases | No (they are backups) | Manually | No |
| OS keychain (service `Market Edge`) | Execution-service API key and any operator keys | **Never** | n/a | Yes |

Research datasets used for model research (`HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF`,
`...-EXPANDED`, the sealed holdout) live in the repository, CI artifacts and D1,
not on the desktop, so they are neither part of nor affected by a desktop backup.

## Backup (format v2)

EXPORT BACKUP writes one local `.mebackup` zip:

- `market_edge_paper.sqlite3` and `market_edge_shadow_research.sqlite3`, each a
  consistent snapshot taken with the SQLite online backup API by the bundled
  execution-service (`backup-db`, `backup-shadow-db`), which is safe while the
  service is writing;
- `settings.json` (non-secret);
- `manifest.json`: format version, app version, source commit, creation time,
  paper schema version, shadow schema version, dataset versions, sha256 and
  row counts of each database, `secrets_included: false`, `cloud_backup: false`.

IMPORT BACKUP validates everything before touching live state (zip, manifest,
sha256 of each database, SQLite `integrity_check`, required tables, schemas not
newer than this build, shadow immutability triggers present). Restore then
stops the loop and service, keeps the current databases as
`backups/pre-restore-*`, installs both, restarts, reconciles and leaves new
entries paused. A v1 backup (made before this change, no shadow database)
restores the paper ledger and leaves the current shadow database untouched.

Tested end to end: backup, add paper and shadow state, restore, and the
original state (risk settings, shadow observation count) comes back
(`desktop/src-tauri/tests/process_integration.rs`, clean-machine checks
`BACKUP_HAS_SHADOW_DB`, `BACKUP_VERIFY_SHADOW`, `BACKUP_RESTORE_SHADOW`).

## Cloud backup: none

Nothing leaves the machine automatically. There is no cloud backup, sync or
upload of any kind; a backup is a file you export and store yourself. The UI
says so on the Backup & restore panel.

## Public API budget (Hyperliquid 429s)

Priority, highest first: open-position safety, reconciliation, discovery,
shadow capture, delayed shadow resolution, chart convenience.

| Source | Requests | Rate-limit behaviour |
|---|---|---|
| Open-position monitor | One websocket (`trades`, one subscription per open coin, reused, 30s ping, backoff reconnect) plus ONE batched `allMids` per 10s heartbeat for all open positions; idle with no positions | On failure the position is flagged MARKET_DATA_OFFLINE / POLL_ONLY; no crossing is ever inferred |
| Reconciliation | Local only (execution-service) | n/a |
| Discovery (5 min, unchanged) | Production scan: 1 `metaAndAssetCtxs` + ~5 Hyperliquid candle reads per market (about 40 markets) plus Binance/Coinbase 4h, 2 at a time; one `allMids` for the signal | Unchanged; retries 429 as before. Freshness gates unchanged |
| Shadow capture | Zero extra requests for markets the scan already evaluated. Research-only supplement for approved research assets the scan missed: at most 1 asset per cycle by default (max 3), deterministic rotation, only venue-listed assets | Skipped entirely in any cycle whose production scan saw data failures |
| Shadow resolution | Reuses the scan's own 5m candles; at most 2 extra candle reads per cycle for 48h/72h windows | Stops for the cycle on the first 429; windows stay pending, never filled from another venue |
| Trade Detail chart | One candle read per trade and timeframe per 15s at most (in-memory cache); closed trades read once | 60s back-off after a 429, reported as RATE_LIMITED_DEFERRED; nothing is drawn in place of missing candles |
| Dashboard / screens | Local execution-service reads only | n/a |
