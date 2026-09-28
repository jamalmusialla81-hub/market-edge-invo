# Market Edge desktop (Tauri + React, paper only)

A control and monitoring shell over the existing stack. It does not redesign
or reimplement any trading logic: the forward loop is `signal-bridge/forward_loop.mjs`
(which runs the unmodified `backend/scan-core.mjs`), execution is the Python
`execution-service/`, and canonical state stays in that service's SQLite file.

```
React UI ──Tauri IPC──▶ Rust controller (src-tauri) ──X-API-Key, 127.0.0.1──▶ execution-service ──▶ Nautilus portfolio / paper ledger / SQLite
                              │
                              └── spawns + supervises: execution-service (Python), forward loop (Node)
```

- The webview never sees the API key, never opens the database, and can only
  call the commands registered in `src-tauri/src/lib.rs` (no fs/shell/http
  plugins). The key is generated on first run and kept in the OS credential
  store (macOS Keychain, Windows Credential Manager). If no store is available
  it lives in memory for that session only, never in a file.
- LIVE is not a setting. `config::set_mode(LIVE)` always refuses and there is
  no code path to a real-money venue. BACKTEST and TESTNET are shown but
  disabled until they are wired into the execution-service.
- Risk settings are edited in the app but validated and persisted by the
  execution-service (`PUT /risk/config`); defaults equal the existing
  `RiskLimits`, so an untouched session behaves exactly as before.

## Controls

| Button | What happens |
|---|---|
| START PAPER | Starts the forward loop (5-minute cadence by default). |
| STOP PAPER | Sends `STOP` on the loop's stdin. The current cycle finishes, the runtime segment closes, the loop exits. Open trades stay OPEN and resume from their last checked candle next time. |
| RECONCILE NOW | `POST /reconcile`; a failed reconciliation halts trading, as before. |
| PAUSE NEW ENTRIES | Blocks new trades (`ENTRIES_PAUSED`); exits keep processing. Not a halt. |
| RESUME | Clears the pause. If a halt is active, asks for `CLEAR_HALT`, runs a fresh reconciliation and clears the halt only if it comes back clean. |
| KILL SWITCH | Asks for `KILL`, then engages the persistent halt. Reduce-only exits still process. |

Ctrl/Cmd + 1–8 switches screens.

## Open positions and Trade Detail

Discovery (scan, rank, open) keeps its 5-minute cadence. Positions that are
already open are managed by a separate open-position monitor inside the
forward-loop process (`signal-bridge/position_monitor.mjs`), which only runs
while at least one position is open:

- Hyperliquid websocket `trades` stream per open coin: a print that crosses
  the active stop, TP1 or TP2 is posted to `POST /paper/tick` straight away.
- A 10s heartbeat (`POSITION_MONITOR_INTERVAL_MS`, clamped to 5–60s): one
  batched `allMids` read for all open positions, posted per position, plus
  the highest/lowest stream prints since the last heartbeat (MFE/MAE only).
- The discovery loop's completed 5m candle sweep stays as the last backstop.

**Limitation:** if the stream is down, the monitor is poll-only (shown as
`POLL_ONLY`). A poll sees only the sampled mid, so a touch-and-reverse between
two polls is caught later by the 5m candle sweep, not by the poll. No price
path between observations is invented. A price older than 30s (or the
operator's stale-data timeout, whichever is lower) is not evaluated; the
position is flagged `STALE` / `MARKET_DATA_OFFLINE` and kept open.

Clicking any row in Open positions, Trade history or the Dashboard's
positions opens Trade Detail: a candlestick chart (1m/5m/15m/1h from
Hyperliquid `candleSnapshot`, pre-entry context plus the full trade) with
ENTRY/STOP/TP1/TP2 lines, entry and actual exit markers, live figures for
open trades (refreshed without reloading), and the original decision-time
record. The research (hindsight) overlay is off by default, available only
for a closed trade with a resolved post-outcome label, and never merged into
the trade record. Back or Esc returns to the list.

On exit the app stops the loop gracefully, then asks the execution-service to
shut down (`POST /system/shutdown`), killing either only after a grace period.
Every backend write is its own committed SQLite transaction, so no stop leaves
partial state. A service the app found already running (and that accepts its
key) is adopted and never stopped by the app.

## Installed app (standalone)

The installers carry everything the app runs; the machine needs no Python,
Node, npm or repository.

| Resource (macOS `Contents/Resources/`, Windows install dir, Linux `/usr/lib/Market Edge/`) | What it is |
|---|---|
| `execution-service/market-edge-exec[.exe]` | the execution-service frozen with PyInstaller (`packaging/market-edge-exec.spec`): CPython 3.12, FastAPI/uvicorn, SQLite and the complete `nautilus_trader` package. `market-edge-exec nautilus-selftest` runs the real Nautilus BacktestEngine. |
| `runtime/node[.exe]` | the official Node.js 22 binary, private to the app |
| `signal-bridge/` | `forward_loop.mjs` and its whole import graph (`backend/scan-core.mjs`, `quant-engine.js`, `ml-engine.js`, ...) copied byte for byte; `MANIFEST.json` lists their sha256 |
| `migrations/` | numbered SQL migrations for the service's SQLite file |
| `config/` | `build_info.json` (version, git SHA, build time, packaging) and `defaults.json` |

Nothing is written there. State lives in the OS app-data directory
(`~/Library/Application Support/Market Edge/`, `%APPDATA%\Market Edge\`,
`~/.local/share/Market Edge/`): `market_edge_paper.sqlite3`,
`market_edge_shadow_research.sqlite3` (shadow learning, research only), `config.json`,
`logs/{desktop,execution-service,forward-loop,reconciliation}.log` (rotated at
5 MB, 5 kept) and `backups/`. Updating or reinstalling the app never touches it.

A release build only ever runs from its bundle: if the bundle is missing or
incomplete it refuses to start and says so; it never looks for a repository.

On startup the app creates the app-data folder, starts the execution-service
(which backs up and migrates an older database first, and refuses a newer one
without modifying it), reconciles, checks live market data, and starts the
forward paper loop if it was running when the app was last closed (on by
default).

Supervision: a crashed execution-service is restarted at most 3 times in 10
minutes; new entries are paused until a post-restart reconciliation is clean.
A crashed forward loop pauses entries and is restarted (at most 3 times in 30
minutes) only if the service is healthy, trading is not halted, market data is
online and a reconciliation is clean. If live prices can't be fetched the app
shows MARKET DATA OFFLINE and pauses new entries; only fresh prices lift that
pause. The supervisor never lifts an operator's pause or a kill switch. If the
app itself dies, the service notices its closed stdin and shuts down.

About → EXPORT BACKUP / IMPORT BACKUP: a `.mebackup` zip (format v2) of
consistent snapshots of the paper database AND the shadow research database,
plus non-secret settings, with a manifest (schema versions, source commit,
dataset versions, sha256, row counts). Import validates it (checksums, SQLite
integrity, required tables, schemas not newer) before anything changes, keeps
the current databases in `backups/`, restores, reconciles and leaves new
entries paused. Keys stay in the keychain and are never exported. There is no
cloud backup: nothing leaves the machine unless you copy the file yourself.
Full data inventory and the public-API budget: [DATA_AND_BACKUP.md](DATA_AND_BACKUP.md). The same operations exist headless for
support and tests: `--self-check`, `--export-backup F`, `--verify-backup F`,
`--restore-backup F --confirm RESTORE` (refused while the app is running).

## Building installers

```
python3.12 -m pip install nautilus_trader fastapi "uvicorn[standard]" pydantic httpx pyinstaller
python3.12 -m PyInstaller --noconfirm --distpath /tmp/pyi desktop/packaging/market-edge-exec.spec
python3.12 desktop/packaging/stage_resources.py --exec-dist /tmp/pyi/execution-service   # -> src-tauri/bundle/
cd desktop && npm ci
npx tauri build --bundles app,dmg --config src-tauri/tauri.bundle.conf.json    # macOS
npx tauri build --bundles nsis,msi --config src-tauri/tauri.bundle.conf.json   # Windows
```

Signing: with `APPLE_CERTIFICATE`/`APPLE_SIGNING_IDENTITY` (+ `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID` for notarization and stapling) or
`WINDOWS_CERTIFICATE` repository secrets, CI signs every bundled binary
(`packaging/sign/`) and the installers. Without them it builds unsigned and
reports `SIGNING: SKIPPED_NOT_CONFIGURED`.

## Developer mode

`npm run tauri dev` (or any debug build) runs the repo's own
`execution-service/run_server.py` with a Python 3.12 that has the dependencies
above and `signal-bridge/forward_loop.mjs` with system Node. Overrides:
`MARKET_EDGE_HOME`, `MARKET_EDGE_PYTHON`, `MARKET_EDGE_NODE` (developer layout
only), `MARKET_EDGE_EXEC_PORT` (default 8765), `MARKET_EDGE_DATA_DIR`,
`MARKET_EDGE_CYCLE_INTERVAL_MS`.

## Tests

- `npm test` — UI tests with explicit fixtures (`src/__tests__/fixtures.ts`);
  application code never renders demo values.
- `cargo test --lib` — controller unit tests. `MARKET_EDGE_KEYRING_TEST=1`
  adds a real OS credential-store round trip (run on macOS and Windows in CI).
- `MARKET_EDGE_INTEGRATION=1 [MARKET_EDGE_BUNDLE_DIR=src-tauri/bundle | MARKET_EDGE_PYTHON=...] cargo test --test process_integration`
  — launches the real (frozen or developer) execution-service and forward loop: live cycle,
  graceful stop/shutdown/restart, crash recovery with bounded restarts, the market-data gate,
  backup export/validate/restore and migration of a pre-versioning database.
- `packaging/clean-machine/clean_machine_test.sh` — CI installs the .dmg/.app (Apple Silicon)
  and .exe/.msi (Windows x64) on runners with Python and Node removed and no checkout, and runs
  the whole paper flow; `offline_test.sh` then restarts the installed Mac app with every exchange
  API unreachable. Intel macOS and Linux installers are not built (out of scope).
- `scripts/linux_app_e2e.sh` — drives the built app under a virtual display
  and captures every screen (CI: `.github/workflows/desktop-app.yml`).
