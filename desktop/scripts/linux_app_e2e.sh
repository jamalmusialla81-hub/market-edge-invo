#!/usr/bin/env bash
# Drives the REAL built desktop app (not a browser mock) under a virtual X
# display: the app launches the real execution-service, START PAPER runs the
# real forward loop against live market data, then each screen is captured,
# RECONCILE NOW / PAUSE / KILL SWITCH / RESUME are exercised through the UI,
# and the window is closed to check the graceful-exit path. Evidence (PNGs,
# the app's own log, the SQLite file) lands in $OUT.
set -euo pipefail
APP="${APP:?path to built market-edge-desktop binary}"
OUT="${OUT:-desktop-e2e}"
CYCLES_WAIT_S="${CYCLES_WAIT_S:-240}"
mkdir -p "$OUT"
export DISPLAY=:99
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
sleep 2
openbox >/dev/null 2>&1 &
eval "$(dbus-launch --sh-syntax)"
export MARKET_EDGE_DATA_DIR="$PWD/$OUT/appdata"
mkdir -p "$MARKET_EDGE_DATA_DIR"
# start with the loop stopped so START PAPER is exercised by a click
echo '{"schema":1,"auto_start_paper":false}' > "$MARKET_EDGE_DATA_DIR/config.json"
export MARKET_EDGE_CYCLE_INTERVAL_MS="${MARKET_EDGE_CYCLE_INTERVAL_MS:-60000}"
"$APP" > "$OUT/app-stdout.log" 2>&1 &
APP_PID=$!
PORT="${MARKET_EDGE_EXEC_PORT:-8765}"
for i in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/health" | tee "$OUT/health.json"
sleep 8
shot() { sleep "${2:-3}"; import -window root "$OUT/$1.png"; echo "captured $1"; }
WIN=""
for w in $(xdotool search --pid "$APP_PID"); do
  case "$(xdotool getwindowname "$w")" in "Market Edge"*) WIN=$w ;; esac
done
[ -n "$WIN" ] || { echo "app window not found"; exit 1; }
xdotool windowactivate --sync "$WIN" 2>/dev/null || true
click() { xdotool mousemove --window "$WIN" "$1" "$2" click 1; }
screen() { xdotool key "ctrl+$1"; }

shot 01-dashboard-startup
click 75 80            # START PAPER
shot 02-started 5
echo "waiting ${CYCLES_WAIT_S}s for real forward-loop cycles..."
sleep "$CYCLES_WAIT_S"
screen 1; shot 03-dashboard-after-cycles
screen 2; shot 04-signals
screen 3; shot 05-positions
screen 4; shot 06-trades
screen 5; shot 07-performance 5
screen 6; shot 08-risk
screen 7; shot 09-system 4
screen 8; shot 09b-about 3
screen 9; shot 09c-shadow 3
screen 7
click 334 80           # RECONCILE NOW
shot 10-reconciled
click 499 80           # PAUSE NEW ENTRIES
shot 11-paused
click 1350 80; sleep 1; xdotool type KILL; shot 12-kill-confirm 1
xdotool key Return; shot 13-killed
click 634 80; sleep 1; xdotool type CLEAR_HALT; xdotool key Return   # RESUME -> reconcile + clear
shot 14-resumed 5
click 198 80           # STOP PAPER
shot 15-stopping 3
screen 7; shot 16-system-after-stop 10

xdotool windowclose "$WIN" 2>/dev/null || wmctrl -i -c "$WIN" || true
for i in $(seq 1 90); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$APP_PID" 2>/dev/null; then echo "APP DID NOT EXIT"; kill "$APP_PID"; exit 1; fi
cp "$OUT/appdata/logs/"*.log "$OUT/"
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; then echo "execution-service still running after app exit"; exit 1; fi
grep -q '"execution-service stopped"' "$OUT/desktop.log" && echo "GRACEFUL_EXIT_OK"
grep -c '"source":"forward-loop"' "$OUT/forward-loop.log" | xargs echo "forward-loop log lines:"
grep '"event":"cycle"' "$OUT/forward-loop.log" | tail -5 || true
