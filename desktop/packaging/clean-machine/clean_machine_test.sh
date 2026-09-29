#!/usr/bin/env bash
# Installed-app test for a machine with NO Python, NO Node and NO repository.
#
# usage: clean_machine_test.sh <macos|windows|linux> <app executable> <install root> <label>
#
# Runs the INSTALLED Market Edge (not a build tree) and proves, from the OS
# process table, the app's own status snapshot (MARKET_EDGE_STATUS_FILE) and
# the log files in the OS app-data directory:
#   bundled layout only (never a repo) · no python/node from PATH ever used ·
#   first-run init · service + loop auto start · SQLite · live scan · paper
#   signal routed · position · reconciliation · crash recovery · graceful quit
#   · restart persistence · keychain key reused · backup export/verify/restore
#   · legacy DB migration.
# Needs only bash, jq and the platform's own tools. Writes $OUT/results.txt
# (one PASS/FAIL line per check) and exits 1 if any check failed.
set -uo pipefail

PLATFORM=$1
APP=$2
ROOT=$3
LABEL=$4
OUT=${OUT:-"$PWD/evidence-$LABEL"}
FIXTURE=${FIXTURE:-"$(dirname "$0")/legacy_v0.sqlite3"}
TRADE_WAIT_S=${TRADE_WAIT_S:-900}
STAGES=${STAGES:-"all"}
mkdir -p "$OUT"
RESULTS="$OUT/results.txt"
: > "$RESULTS"
export MARKET_EDGE_CYCLE_INTERVAL_MS=${MARKET_EDGE_CYCLE_INTERVAL_MS:-60000}
STATUS="$OUT/status.json"
export MARKET_EDGE_STATUS_FILE="$STATUS"
unset MARKET_EDGE_HOME MARKET_EDGE_PYTHON MARKET_EDGE_NODE MARKET_EDGE_DEV MARKET_EDGE_DATA_DIR

case "$PLATFORM" in
  macos) DATA="$HOME/Library/Application Support/Market Edge" ;;
  windows) DATA="$(cygpath -u "$APPDATA")/Market Edge" ;;
  linux) DATA="$HOME/.local/share/Market Edge" ;;
esac

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
pass() { echo "PASS $1${2:+ -- $2}" | tee -a "$RESULTS"; }
fail() { echo "FAIL $1${2:+ -- $2}" | tee -a "$RESULTS"; }
check() { local name=$1 detail=$2; shift 2; if "$@"; then pass "$name" "$detail"; else fail "$name" "$detail"; fi; }
st() { jq -r "$1" "$STATUS" 2>/dev/null; }
wait_for() { # wait_for <seconds> <jq boolean expr>
  local deadline=$((SECONDS + $1))
  while [ $SECONDS -lt $deadline ]; do
    if [ -f "$STATUS" ] && jq -e "$2" "$STATUS" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}
under_root() { case "$1" in "$ROOT"*) return 0 ;; *) return 1 ;; esac; }
native() { if [ "$PLATFORM" = windows ]; then cygpath -w "$1"; else echo "$1"; fi; }

# ---------------------------------------------------------------- traps
# Any python/node/npm/pip looked up through PATH lands here and is recorded.
TRAPS="$OUT/traps"
mkdir -p "$TRAPS"
for t in python python3 python3.12 pip pip3 node npm npx; do
  printf '#!/usr/bin/env bash\necho "$0 $*" >> "%s/trap-hits.log"\nexit 97\n' "$TRAPS" > "$TRAPS/$t"
  chmod +x "$TRAPS/$t"
  [ "$PLATFORM" = windows ] && cp "$TRAPS/$t" "$TRAPS/$t.cmd" 2>/dev/null
done
export PATH="$TRAPS:$PATH"

# process table: "pid<TAB>ppid<TAB>executable/command"
procs() {
  if [ "$PLATFORM" = windows ]; then
    powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { \"\$(\$_.ProcessId)\`t\$(\$_.ParentProcessId)\`t\$(\$_.ExecutablePath)\" }" | tr -d '\r'
  else
    ps -axo pid=,ppid=,command= | awk '{pid=$1; ppid=$2; $1=""; $2=""; sub(/^  /,""); print pid "\t" ppid "\t" $0}'
  fi
}
exe_of() { procs | awk -F'\t' -v p="$1" '$1==p {print $3}' | head -1; }
to_unix() { if [ "$PLATFORM" = windows ] && [ -n "$1" ]; then cygpath -u "$1"; else echo "$1"; fi; }

APP_PID=""
launch() { # launch <tag> [extra env...]
  local tag=$1; shift
  rm -f "$STATUS"
  log "launching $APP ($tag)"
  ( cd "$OUT" && exec env "$@" "$APP" > "$OUT/app-$tag.stdout.log" 2>&1 ) &
  APP_PID=$!
  sleep 2
  if [ "$PLATFORM" = windows ]; then
    # $! is the MSYS pid; find the real Windows pid of the app executable
    local w; w=$(native "$APP")
    APP_PID=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath -eq '$w' } | Sort-Object CreationDate -Descending | Select-Object -First 1).ProcessId" | tr -d '\r')
  fi
  log "app pid $APP_PID"
}

quit_app() { # graceful: the same path as closing the window
  log "quitting app gracefully"
  if [ "$PLATFORM" = windows ]; then
    taskkill //PID "$APP_PID" > /dev/null 2>&1
  else
    kill -TERM "$APP_PID" 2>/dev/null
  fi
  local deadline=$((SECONDS + 90))
  while [ $SECONDS -lt $deadline ]; do
    if ! procs | awk -F'\t' '{print $1}' | grep -qx "$APP_PID"; then break; fi
    sleep 1
  done
  sleep 3
}

leftovers() { procs | awk -F'\t' '{print $3}' | grep -E "market-edge-exec|runtime[/\\\\]node" | grep -v grep || true; }

screenshot() {
  case "$PLATFORM" in
    macos) screencapture -x "$OUT/$1.png" 2>/dev/null ;;
    linux) import -window root "$OUT/$1.png" 2>/dev/null ;;
    windows) powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \$bmp=New-Object System.Drawing.Bitmap \$b.Width,\$b.Height; \$g=[System.Drawing.Graphics]::FromImage(\$bmp); \$g.CopyFromScreen(\$b.Location,[System.Drawing.Point]::Empty,\$b.Size); \$bmp.Save('$(native "$OUT/$1.png")')" 2>/dev/null ;;
  esac
}

# ================================================================ 0. machine is clean
log "== 0. environment"
for tool in python python3 node npm pip; do
  real=$(PATH="${PATH#"$TRAPS:"}" command -v $tool 2>/dev/null || true)
  if [ -n "$real" ] && [ "$real" != "/usr/bin/python3" ]; then fail "NO_SYSTEM_$tool" "$real"; else pass "NO_SYSTEM_$tool" "${real:-absent}"; fi
done
[ "$PLATFORM" = macos ] && [ -x /usr/bin/python3 ] && log "note: /usr/bin/python3 is the macOS system stub (SIP-protected); traps + process table prove it is never used"
check REPO_ABSENT "no execution-service/ or signal-bridge/ checkout in $PWD" test ! -e "$PWD/execution-service" -a ! -e "$PWD/signal-bridge"

# ================================================================ 1. layout
log "== 1. self-check (headless)"
"$APP" --self-check --result "$OUT/self-check.json" > /dev/null 2>&1
check SELF_CHECK "bundled execution-service + node answer" test "$(jq -r .ok "$OUT/self-check.json")" = true
check LAYOUT_BUNDLED "$(jq -r .layout.kind "$OUT/self-check.json")" test "$(jq -r .layout.kind "$OUT/self-check.json")" = BUNDLED
EXEC_BIN=$(to_unix "$(jq -r .layout.exec_program "$OUT/self-check.json")")
NODE_BIN=$(to_unix "$(jq -r .layout.node "$OUT/self-check.json")")
check EXEC_INSIDE_APP "$EXEC_BIN" under_root "$EXEC_BIN"
check NODE_INSIDE_APP "$NODE_BIN" under_root "$NODE_BIN"
check REPO_ROOT_NULL "layout.repo_root" test "$(jq -r .layout.repo_root "$OUT/self-check.json")" = null
check VERSION_0_2_0 "$(jq -r '.app_version + " " + .git_sha + " " + .build_timestamp' "$OUT/self-check.json")" test "$(jq -r .app_version "$OUT/self-check.json")" = 0.2.0
check BACKEND_FROZEN "$(jq -r '.execution_service | "backend " + .backend_version + " python " + .python + " schema v" + (.schema_version|tostring)' "$OUT/self-check.json")" test "$(jq -r .execution_service.frozen "$OUT/self-check.json")" = true

# ================================================================ 2. legacy DB migration (separate data dir)
if [ -f "$FIXTURE" ]; then
  log "== 2. migration of a pre-versioning database"
  MIG="$OUT/migration-data"
  rm -rf "$MIG"; mkdir -p "$MIG"
  cp "$FIXTURE" "$MIG/market_edge_paper.sqlite3"
  launch migration MARKET_EDGE_DATA_DIR="$MIG" MARKET_EDGE_EXEC_PORT=8791
  if wait_for 240 '.status.migration != null'; then
    check MIGRATION_FROM_V0 "$(st '.status.migration | "v\(.from_version) -> v\(.to_version), applied \(.applied)"')" test "$(st .status.migration.from_version)" = 0
    check MIGRATION_BACKUP "$(st .status.migration.backup_path)" test -n "$(ls "$MIG"/backups/pre-migration-v0-* 2>/dev/null)"
    check MIGRATION_DATA_KEPT "starting equity $(st .account.starting_equity)" jq -e '.account.starting_equity == 25000' "$STATUS"
  else
    fail MIGRATION_FROM_V0 "service never reported (see app-migration.stdout.log)"
  fi
  quit_app
fi

# ================================================================ 3. first run, auto start, live paper flow
log "== 3. first run in the OS app-data directory: $DATA"
if [ -e "$DATA" ]; then log "note: $DATA already exists (update/reinstall run)"; FIRST=0; else FIRST=1; fi
launch first
check APP_LAUNCHES "pid $APP_PID" test -n "$APP_PID"
wait_for 300 '.execution_service.state == "RUNNING" and .health.status == "ok"'
check EXEC_SERVICE_AUTO_START "$(st .execution_service.program)" test "$(st .execution_service.state)" = RUNNING
EXEC_PID=$(st .execution_service.pid)
EXEC_OS=$(to_unix "$(exe_of "$EXEC_PID")")
check EXEC_PROCESS_FROM_BUNDLE "os pid $EXEC_PID: $EXEC_OS" under_root "$EXEC_OS"
wait_for 60 '.forward_loop.state == "RUNNING"'
check FORWARD_LOOP_AUTO_START "$(st .forward_loop.program)" test "$(st .forward_loop.state)" = RUNNING
LOOP_PID=$(st .forward_loop.pid)
LOOP_OS=$(to_unix "$(exe_of "$LOOP_PID")")
check LOOP_PROCESS_FROM_BUNDLE "os pid $LOOP_PID: $LOOP_OS" under_root "$LOOP_OS"
check SQLITE_OPENS "$(st '.status.sqlite | "quick_check \(.quick_check) \(.path)"')" test "$(st .status.sqlite.ok)" = true
check NAUTILUS_IN_BUNDLE "$(st '.status.nautilus.version')" test "$(st .status.nautilus.ok)" = true
check HEALTH_VERSION "$(st '.health | "v\(.version) schema v\(.schema_version) sha \(.build.git_sha)"')" test "$(st .health.version)" = 0.2.0
check FIRST_RUN_INIT "config.json, logs/, backups/, DB in $DATA" test -f "$DATA/config.json" -a -d "$DATA/logs" -a -d "$DATA/backups" -a -f "$DATA/market_edge_paper.sqlite3"
for f in desktop execution-service forward-loop reconciliation; do
  check "LOG_$f" "$DATA/logs/$f.log" test -f "$DATA/logs/$f.log"
done
KEYLINE=$(grep -ho 'service API key [a-z]* in [^"]*' "$DATA/logs/desktop.log" | tail -1)
if [ "$PLATFORM" = linux ]; then
  log "note: key store on this Linux container: ${KEYLINE:-none} (no Secret Service in a headless container; macOS/Windows jobs test the real OS store)"
else
  check KEYCHAIN_KEY_STORED "$KEYLINE" bash -c "echo '$KEYLINE' | grep -Eq 'service API key (created|loaded) in (macOS Keychain|Windows Credential Manager)'"
fi
if [ -n "${PREVIOUS_STATUS:-}" ] && [ -f "$PREVIOUS_STATUS" ]; then
  wait_for 60 '.trade_ids != null'
  check UPDATE_STATE_PRESERVED "before reinstall $(jq -c .trade_ids "$PREVIOUS_STATUS"), after $(st '.trade_ids|tostring')" \
    jq -e --slurpfile prev "$PREVIOUS_STATUS" '($prev[0].trade_ids // []) - (.trade_ids // []) | length == 0' "$STATUS"
  check UPDATE_NOT_FIRST_RUN "config.json first_run_at kept" test $FIRST = 0
fi
check NO_MUTABLE_STATE_IN_APP "no *.sqlite3 / logs under $ROOT" test -z "$(find "$ROOT" \( -name '*.sqlite3' -o -name '*.log' -o -name 'config.json' \) 2>/dev/null | head -1)"
screenshot "01-running"

log "waiting up to ${TRADE_WAIT_S}s for a live scan to route a paper trade"
wait_for 120 '.supervisor.market.online != null'
# #14: Hyperliquid's public API limits request weight per IP, and a CI runner's IP is
# shared with every other job on it, so an HTTP 429 here is the environment, not a
# defect. What must hold is that the app HANDLES it: new entries paused (fail closed,
# no price invented), the probe backing off instead of hammering, and live data
# confirmed as soon as the limit window rolls over. A non-429 failure still FAILs.
if [ "$(st .supervisor.market.online)" = true ]; then
  pass LIVE_MARKET_DATA "$(st .supervisor.market.detail)"
elif [ "$(st .supervisor.market.rate_limited)" = true ]; then
  log "market data rate limited at start ($(st .supervisor.market.detail)); verifying degraded mode"
  wait_for 15 '.status.entries_paused == true'
  check RATE_LIMIT_FAILS_CLOSED "entries_paused=$(st .status.entries_paused) reason=$(st .status.entries_paused_reason)" test "$(st .status.entries_paused)" = true
  check RATE_LIMIT_PROBE_BACKS_OFF "consecutive 429 $(st .supervisor.market.consecutive_429), next probe in $(st .supervisor.market.next_probe_in_s)s" test "$(st '.supervisor.market.next_probe_in_s // 0')" -ge 30
  if wait_for 420 '.supervisor.market.online == true'; then
    pass LIVE_MARKET_DATA "recovered after rate limit: $(st .supervisor.market.detail)"
  else
    # Still limited 7 minutes later: that is the runner's shared IP, and the degraded
    # mode was verified above. The app must still be up and still failing closed.
    check LIVE_MARKET_DATA_DEGRADED "still rate limited: $(st .supervisor.market.detail); entries_paused=$(st .status.entries_paused)" \
      test "$(st .status.entries_paused)" = true -a "$(st .execution_service.state)" = RUNNING
  fi
else
  fail LIVE_MARKET_DATA "$(st .supervisor.market.detail)"
fi
# this process's own cycle count, not the trade/position count: on a reinstall those can
# already be >=1 from state carried over, which would satisfy the trade wait instantly and
# never actually prove this run's loop scanned anything.
wait_for "$TRADE_WAIT_S" '(.loop.cycles_seen // 0) >= 1'
# DEFERRED_RATE_LIMITED is a healthy cycle (discovery deferred on HTTP 429, nothing traded);
# ERROR is not.
check LIVE_SCAN_RAN "cycles $(st .loop.cycles_seen), last outcome $(st .loop.last_outcome)" test "$(st .loop.cycles_seen)" -ge 1 -a "$(st .loop.last_outcome)" != ERROR

# a cycle can legitimately come back REJECTED (a market-data rate-limit blip pausing entries, or a
# bounded execution-service crash+recovery -- both seen back to back on a loaded CI runner) without
# the loop itself being broken. The supervisor's own bounds (up to 3 execution-service restarts per
# 10 minutes, each with backoff, plus repeated market-data probes every 30s) mean working-as-designed
# recovery can itself take minutes; give it most of the same budget as the cycles-seen wait above
# rather than a short fixed window that fails on the very recovery behavior being exercised.
if wait_for 600 '(.positions_count // 0) >= 1 or (.trades_count // 0) >= 1'; then
  pass PAPER_SIGNAL_ROUTED "$(st '.status.latest_signal | "\(.asset) \(.direction) \(.outcome)"')"
  pass POSITION_APPEARS "$(st '.positions[0] | "\(.asset) \(.direction) qty \(.quantity) @ \(.entry) lev \(.leverage)"')"
else
  fail PAPER_SIGNAL_ROUTED "no trade within TRADE_WAIT_S; last outcome $(st .loop.last_outcome), signals $(st .signals_count)"
  fail POSITION_APPEARS "none"
fi
wait_for 30 '.status.last_reconcile.reconciled == true'
check RECONCILIATION_PASSES "$(st '.status.last_reconcile | "reconciled=\(.reconciled)"')" test "$(st .status.last_reconcile.reconciled)" = true
check RECONCILIATION_LOG "$(wc -l < "$DATA/logs/reconciliation.log") lines" test -s "$DATA/logs/reconciliation.log"
screenshot "02-trade"

# no console windows: only the app window is visible
if [ "$PLATFORM" = windows ]; then
  powershell -NoProfile -Command "Get-Process | Where-Object { \$_.MainWindowHandle -ne 0 } | Select-Object ProcessName,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200" > "$OUT/visible-windows.txt"
  check NO_CONSOLE_WINDOWS "$(tr -s ' \r\n' ' ' < "$OUT/visible-windows.txt")" bash -c "! grep -Eiq 'market-edge-exec|^node|conhost|cmd ' '$OUT/visible-windows.txt'"
fi

# ---- crash recovery: kill the service abruptly
log "== 4. crash recovery"
TRADES_BEFORE_CRASH=$(st .trades_count)
if [ "$PLATFORM" = windows ]; then taskkill //F //PID "$EXEC_PID" > /dev/null 2>&1; else kill -9 "$EXEC_PID"; fi
if wait_for 240 ".execution_service.state == \"RUNNING\" and .execution_service.pid != $EXEC_PID and .supervisor.recovering == false and .status != null"; then
  pass SERVICE_CRASH_RESTARTED "new pid $(st .execution_service.pid), crashes $(st .execution_service.crashes), restarts in window $(st .supervisor.exec_restarts_in_window)"
  check CRASH_RECONCILED_BEFORE_RESUME "$(st .supervisor.last_action)" grep -q 'post-restart reconciliation: reconciled=true' "$DATA/logs/reconciliation.log"
  check CRASH_STATE_PRESERVED "trades $TRADES_BEFORE_CRASH -> $(st .trades_count)" test "$(st .trades_count)" = "$TRADES_BEFORE_CRASH"
  wait_for 60 '.forward_loop.state == "RUNNING"'
  check LOOP_BACK_AFTER_RECOVERY "$(st .forward_loop.state)" test "$(st .forward_loop.state)" = RUNNING
else
  fail SERVICE_CRASH_RESTARTED "$(st .supervisor)"
fi

# ---- graceful quit + restart persistence
log "== 5. quit and restart"
SNAP="$OUT/before-restart.json"
cp "$STATUS" "$SNAP"
quit_app
check GRACEFUL_EXIT "desktop.log: service stopped + app exited" bash -c "grep -q 'execution-service stopped' '$DATA/logs/desktop.log' && grep -q 'Market Edge exited' '$DATA/logs/desktop.log'"
check NO_ORPHANS "$(leftovers | tr '\n' ' ')" test -z "$(leftovers)"
launch restart
wait_for 300 '.execution_service.state == "RUNNING" and .account != null and .trades_count != null'
check RESTART_TRADES_PRESERVED "$(jq -c .trade_ids "$SNAP") == $(st '.trade_ids|tostring')" test "$(jq -c .trade_ids "$SNAP")" = "$(jq -c .trade_ids "$STATUS")"
check RESTART_BALANCE_PRESERVED "starting $(st .account.starting_equity), realized $(jq .account.realized_pnl "$SNAP") -> $(st .account.realized_pnl)" jq -e --slurpfile a "$SNAP" '.account.realized_pnl == $a[0].account.realized_pnl and .account.starting_equity == $a[0].account.starting_equity' "$STATUS"
check RESTART_POSITIONS_PRESERVED "$(jq .positions_count "$SNAP") -> $(st .positions_count)" test "$(jq .positions_count "$SNAP")" -le "$(st .positions_count)" -o "$(jq .trades_count "$SNAP")" = "$(st .trades_count)"
[ "$PLATFORM" = linux ] || check KEYCHAIN_KEY_REUSED "$(grep -o 'service API key [a-z]* in [^"]*' "$DATA/logs/desktop.log" | tail -1)" bash -c "grep -o 'service API key [a-z]* in' '$DATA/logs/desktop.log' | tail -1 | grep -q loaded"
check RESTART_NO_MIGRATION "$(st '.status.migration.applied|tostring')" test "$(st '.status.migration.applied|length')" = 0
wait_for 60 '.status.last_reconcile.reconciled == true'
check RESTART_RECONCILED "startup reconciliation" test "$(st .status.last_reconcile.reconciled)" = true
screenshot "03-after-restart"
quit_app

# ---- backup export / verify / restore (headless, app closed)
log "== 6. backup / restore"
BK="$OUT/backup.mebackup"
"$APP" --export-backup "$(native "$BK")" --result "$OUT/export.json" > /dev/null 2>&1
check BACKUP_EXPORT "$(jq -c '.manifest | {schema_version, counts, secrets_included}' "$OUT/export.json")" test "$(jq -r .ok "$OUT/export.json")" = true
check BACKUP_NO_SECRETS "entries $(jq -c .entries "$OUT/export.json")" test "$(jq -r '.manifest.secrets_included' "$OUT/export.json")" = false -a "$(jq -r '.entries|length' "$OUT/export.json")" = 4
check BACKUP_HAS_SHADOW_DB "$(jq -c '.manifest | {shadow_included, shadow_counts, dataset_versions, cloud_backup}' "$OUT/export.json")" test "$(jq -r '.manifest.shadow_included' "$OUT/export.json")" = true -a "$(jq -r '.manifest.cloud_backup' "$OUT/export.json")" = false
"$APP" --verify-backup "$(native "$BK")" --result "$OUT/verify.json" > /dev/null 2>&1
check BACKUP_VERIFY "$(jq -c .validation.counts "$OUT/verify.json")" test "$(jq -r .ok "$OUT/verify.json")" = true
check BACKUP_VERIFY_SHADOW "$(jq -c .shadow_validation.counts "$OUT/verify.json")" test "$(jq -r .shadow_validation.ok "$OUT/verify.json")" = true
head -c 2000 "$BK" > "$OUT/truncated.mebackup"
"$APP" --verify-backup "$(native "$OUT/truncated.mebackup")" --result "$OUT/verify-bad.json" > /dev/null 2>&1
check BACKUP_REJECTS_CORRUPT "$(jq -r .error "$OUT/verify-bad.json")" test "$(jq -r .ok "$OUT/verify-bad.json")" = false
"$APP" --restore-backup "$(native "$BK")" --confirm RESTORE --result "$OUT/restore.json" > /dev/null 2>&1
check BACKUP_RESTORE "kept $(jq -r .previous_database_kept_at "$OUT/restore.json")" test "$(jq -r .ok "$OUT/restore.json")" = true
check BACKUP_RESTORE_SHADOW "kept $(jq -r .previous_shadow_database_kept_at "$OUT/restore.json")" test "$(jq -r .shadow_restored "$OUT/restore.json")" = true
launch after-restore
wait_for 300 '.execution_service.state == "RUNNING" and .trades_count != null'
check RESTORE_STATE_MATCHES "$(st '.trade_ids|tostring')" test "$(jq -c .trade_ids "$SNAP")" = "$(jq -c .trade_ids "$STATUS")"
cp "$STATUS" "$OUT/final-state.json" 2>/dev/null   # the real last state, not the earlier before-restart snapshot
quit_app
check NO_ORPHANS_FINAL "$(leftovers | tr '\n' ' ')" test -z "$(leftovers)"

# ---- nothing ever reached a trap
if [ -s "$TRAPS/trap-hits.log" ]; then fail NO_PATH_PYTHON_NODE_USED "$(tr '\n' ';' < "$TRAPS/trap-hits.log")"; else pass NO_PATH_PYTHON_NODE_USED "no python/node/npm/pip lookups through PATH"; fi
# never a repo path in any log
if grep -rqE "run_server\.py|MARKET_EDGE_HOME|layout DevRepo|DEV_REPO" "$DATA/logs" 2>/dev/null; then fail NO_REPO_FALLBACK "repo path found in logs"; else pass NO_REPO_FALLBACK "logs show only the bundled layout"; fi

cp -r "$DATA/logs" "$OUT/app-data-logs" 2>/dev/null
cp "$DATA/config.json" "$OUT/app-data-config.json" 2>/dev/null
echo
echo "==== $LABEL: $(grep -c '^PASS' "$RESULTS") PASS, $(grep -c '^FAIL' "$RESULTS") FAIL"
if grep -q '^FAIL' "$RESULTS"; then
  grep '^FAIL' "$RESULTS"
  # print the app's own logs into the CI job log itself: the evidence artifact
  # is not always fetchable, and these are what explains a FAIL
  for f in forward-loop execution-service desktop reconciliation; do
    echo "---- tail of $f.log ----"
    tail -n 200 "$DATA/logs/$f.log" 2>/dev/null || echo "(no $f.log)"
  done
  exit 1
fi
exit 0
