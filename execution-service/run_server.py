"""Runs the paper execution-service against a configurable DB path (env
EXECUTION_SERVICE_DB_PATH). Used by the endurance harness (Part I), which
needs the SAME persisted SQLite file across separate CI runs -- the
`--factory` uvicorn CLI has no way to pass an argument to the factory
function, so this tiny wrapper exists only to do that.

The desktop app also launches the service through this file, with
EXECUTION_SERVICE_PORT to pick the port and POST /system/shutdown for a
graceful, cross-platform stop (no reliance on POSIX signals on Windows)."""
import os

import uvicorn

from market_edge_exec.api.app import create_app

if __name__ == "__main__":
    app = create_app(db_path=os.environ.get("EXECUTION_SERVICE_DB_PATH", "market_edge_exec.sqlite3"))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=int(os.environ.get("EXECUTION_SERVICE_PORT", "8000"))))

    def request_shutdown():
        server.should_exit = True

    app.state.request_shutdown = request_shutdown
    server.run()
