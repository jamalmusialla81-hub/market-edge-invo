#!/usr/bin/env bash
# Offline start of the INSTALLED app, on the app data left by
# clean_machine_test.sh, with every exchange API unreachable: the app must still
# launch, show MARKET DATA OFFLINE, keep existing state visible, place no new
# trades and invent no prices.
# usage: offline_test.sh <app executable> <label>   (expects $OUT/final-state.json from the online run)
set -uo pipefail
APP=$1
LABEL=$2
OUT=${OUT:-"$PWD/evidence-$LABEL"}
mkdir -p "$OUT"
RESULTS="$OUT/results-offline.txt"
: > "$RESULTS"
STATUS="$OUT/status-offline.json"
export MARKET_EDGE_STATUS_FILE="$STATUS" MARKET_EDGE_CYCLE_INTERVAL_MS=30000
pass() { echo "PASS $1${2:+ -- $2}" | tee -a "$RESULTS"; }
fail() { echo "FAIL $1${2:+ -- $2}" | tee -a "$RESULTS"; }
check() { local name=$1 detail=$2; shift 2; if "$@"; then pass "$name" "$detail"; else fail "$name" "$detail"; fi; }
st() { jq -r "$1" "$STATUS" 2>/dev/null; }
wait_for() { local d=$((SECONDS + $1)); while [ $SECONDS -lt $d ]; do [ -f "$STATUS" ] && jq -e "$2" "$STATUS" >/dev/null 2>&1 && return 0; sleep 3; done; return 1; }

check NO_MARKET_NETWORK "Hyperliquid, Coinbase and Binance APIs unreachable" \
  bash -c "! curl -s --max-time 8 -o /dev/null https://api.hyperliquid.xyz/info && ! curl -s --max-time 8 -o /dev/null https://api.exchange.coinbase.com/products && ! curl -s --max-time 8 -o /dev/null https://api.binance.com/api/v3/ping"
"$APP" > "$OUT/app-offline.stdout.log" 2>&1 &
PID=$!
check APP_LAUNCHES_OFFLINE "pid $PID" wait_for 240 '.execution_service.state == "RUNNING" and .status != null'
wait_for 60 '.supervisor.market.online == false'
check MARKET_DATA_OFFLINE_SHOWN "$(st .supervisor.market.detail)" test "$(st .supervisor.market.online)" = false
check NO_NEW_ENTRIES "entries paused: $(st .status.entries_paused_reason)" test "$(st .status.entries_paused_reason)" = MARKET_DATA_OFFLINE
# baseline taken now, at confirmed-offline launch -- not from the earlier online
# run, which can still be legitimately updating marks/trades up to its own quit
BEFORE="$OUT/offline-start-state.json"
cp "$STATUS" "$BEFORE"
check EXISTING_STATE_VISIBLE "trades $(jq -c .trade_ids "$BEFORE") -> $(st '.trade_ids|tostring')" test "$(jq -c .trade_ids "$BEFORE")" = "$(jq -c .trade_ids "$STATUS")"
sleep 75   # at least two loop cycles attempt a scan with no network
check NO_TRADES_WHILE_OFFLINE "trades $(st .trades_count) after $(st .loop.cycles_seen) offline cycles, last outcome $(st .loop.last_outcome)" \
  test "$(st .trades_count)" = "$(jq -r '.trades_count // 0' "$BEFORE")"
# marks are never invented: every open position keeps its last real mark (source + timestamp from before going offline)
check NO_FAKE_PRICES "$(st '[.positions[]? | "\(.asset) mark \(.current_price) via \(.mark_source)"] | join(", ")')" \
  jq -e --slurpfile b "$BEFORE" '[.positions[]?.current_price] == [$b[0].positions[]?.current_price]' "$STATUS"
check SQLITE_INTACT "$(st .status.sqlite.quick_check)" test "$(st .status.sqlite.quick_check)" = ok
if command -v screencapture >/dev/null; then screencapture -x "$OUT/offline.png" 2>/dev/null; else import -window root "$OUT/offline.png" 2>/dev/null; fi
kill -TERM $PID
for i in $(seq 1 90); do kill -0 $PID 2>/dev/null || break; sleep 1; done
check OFFLINE_GRACEFUL_EXIT "" bash -c "! kill -0 $PID 2>/dev/null"
echo "==== $LABEL offline: $(grep -c '^PASS' "$RESULTS") PASS, $(grep -c '^FAIL' "$RESULTS") FAIL"
grep '^FAIL' "$RESULTS" && exit 1
exit 0
