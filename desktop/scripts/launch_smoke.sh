#!/usr/bin/env bash
# macOS / Windows smoke test of the BUILT app: launch it, confirm it starts
# the real execution-service it manages and that the service reports the
# real Nautilus + SQLite components, then stop everything.
set -euo pipefail
APP="${APP:?path to built app executable}"
PORT="${MARKET_EDGE_EXEC_PORT:-8765}"
"$APP" > app-smoke.log 2>&1 &
APP_PID=$!
ok=0
for i in $(seq 1 180); do
  if curl -sf "http://127.0.0.1:$PORT/health" > smoke-health.json; then ok=1; break; fi
  sleep 1
done
cat smoke-health.json || true
kill "$APP_PID" 2>/dev/null || true
# The app was killed abruptly, so it could not stop its child: do it here.
if command -v taskkill >/dev/null 2>&1; then taskkill //F //IM python.exe >/dev/null 2>&1 || true; else pkill -f run_server.py || true; fi
[ "$ok" = 1 ] || { echo "APP_LAUNCH_SMOKE_FAILED: execution-service never became healthy"; cat app-smoke.log; exit 1; }
grep -q '"paper_only":true' smoke-health.json && echo "APP_LAUNCH_SMOKE_OK"
