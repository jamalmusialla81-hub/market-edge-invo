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

Ctrl/Cmd + 1–7 switches screens.

On exit the app stops the loop gracefully, then asks the execution-service to
shut down (`POST /system/shutdown`), killing either only after a grace period.
Every backend write is its own committed SQLite transaction, so no stop leaves
partial state. A service the app found already running (and that accepts its
key) is adopted and never stopped by the app.

## Running

Requirements: a checkout of this repository, Python 3.12 with the
execution-service dependencies, Node 22.

```
cd execution-service && python3.12 -m venv .venv && .venv/bin/pip install nautilus_trader fastapi "uvicorn[standard]" pydantic httpx
cd ../desktop && npm ci
npm run tauri dev            # development
npx tauri build              # installers: .app/.dmg on macOS, .exe/.msi on Windows
```

The app finds the checkout by walking up from its working directory or
executable, or from `MARKET_EDGE_HOME`. Other overrides: `MARKET_EDGE_PYTHON`,
`MARKET_EDGE_NODE`, `MARKET_EDGE_EXEC_PORT` (default 8765),
`MARKET_EDGE_DB_PATH` (default: the app data dir), `MARKET_EDGE_CYCLE_INTERVAL_MS`.

Installed builds are not self-contained yet: they still need the checkout,
Python and Node on the machine. Builds are unsigned.

## Tests

- `npm test` — UI tests with explicit fixtures (`src/__tests__/fixtures.ts`);
  application code never renders demo values.
- `cargo test --lib` — controller unit tests. `MARKET_EDGE_KEYRING_TEST=1`
  adds a real OS credential-store round trip (run on macOS and Windows in CI).
- `MARKET_EDGE_INTEGRATION=1 MARKET_EDGE_PYTHON=... cargo test --test process_integration`
  — launches the real execution-service and forward loop, runs a live cycle,
  stops the loop gracefully, shuts down, restarts on the same database.
- `scripts/linux_app_e2e.sh` — drives the built app under a virtual display
  and captures every screen (CI: `.github/workflows/desktop-app.yml`).
