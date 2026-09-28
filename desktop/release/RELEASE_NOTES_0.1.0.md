# Market Edge 0.1.0 — macOS Apple Silicon (unsigned preview, paper trading only)

> **Unsigned build.** This app is **not code-signed with a Developer ID and not notarized by Apple**
> (ad-hoc signature, no Team ID). macOS Gatekeeper will block the first launch until you approve it
> manually. The exact Gatekeeper assessment of these files, recorded on a macOS runner, is in
> `SIGNATURE.txt`. Verify the download against `SHA256SUMS.txt` before opening it.

## Supported

- **macOS on Apple Silicon (arm64), macOS 11 or later.**
- Not supported in this release: Intel Macs, Windows (deferred; see below) and Linux.

## What it is

- A standalone desktop app. It needs **no Python, no Node and no repository checkout**: the execution service
  (frozen Python 3.12 with Nautilus Trader 1.231.0 bundled) and the Node forward loop ship inside the app.
- **Paper trading only.** LIVE is not selectable (`set_mode(LIVE)` always refuses, and there is no
  code path to a real-money venue). TESTNET is shown but disabled: no testnet backend is wired
  into the execution service yet. Testnet keys can be stored in the Keychain, but they are not used.
- Architecture: the forward loop produces signals, which pass risk checks in the execution service
  and are routed to the Nautilus-backed paper engine. A Hummingbot bridge contract exists in the
  codebase and is not used by the desktop app.
- Local state is kept in a SQLite database in `~/Library/Application Support/Market Edge`, never inside the app bundle.
  - Restart and crash recovery with startup reconciliation.
  - Schema migrations, with an automatic pre-migration backup.
  - Backup and restore; backups contain no secrets.
  - In-place update keeps existing data.
- Offline safety: if market data is unreachable, new entries pause and no prices are invented.
- The service API key is stored in the macOS Keychain.

## Validation

For this exact build, CI passed on a clean macOS arm64 machine with no system Python or Node and no repository checkout:
- install from .dmg and from .app;
- live paper signal → risk → route → fill;
- crash recovery, restart persistence and migration;
- backup and restore;
- offline behaviour.

The Python (Nautilus), Hummingbot-bridge, Node, UI and Rust test suites also passed.

## Research foundation (merged in this release; not used by the app)

- The legacy `HISTORICAL-RANK-V1` research dataset was found to be built from stale market data. It is marked
  **INVALID** and preserved for audit only.
- A clean, fully provenanced research dataset (`HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF`, Coinbase spot) was established.
  No model research has been promoted to production. The current scoring shows **no measurable edge** over random selection on clean data.
- No profitability or validated trading edge is claimed.

## Windows

Windows installers are **deferred** to a later release (unsigned; pending code signing).

## Install

1. Download `Market-Edge_0.1.0_aarch64.dmg` and `SHA256SUMS.txt` from this release.
2. Verify the download: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`.
3. Open the .dmg and drag **Market Edge** to **Applications**.
4. Launch Market Edge from Applications. Because the app is unsigned, macOS will refuse to open it the first time.
   Then open **System Settings → Privacy & Security**, find the message about “Market Edge” and choose **Open Anyway**,
   then confirm. This is needed once.
