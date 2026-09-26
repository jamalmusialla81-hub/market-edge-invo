"""Runs the paper execution-service against a configurable DB path (env
EXECUTION_SERVICE_DB_PATH). Used by the endurance harness (Part I), which
needs the SAME persisted SQLite file across separate CI runs -- the
`--factory` uvicorn CLI has no way to pass an argument to the factory
function, so this tiny wrapper exists only to do that."""
import os

import uvicorn

from market_edge_exec.api.app import create_app

if __name__ == "__main__":
    app = create_app(db_path=os.environ.get("EXECUTION_SERVICE_DB_PATH", "market_edge_exec.sqlite3"))
    uvicorn.run(app, host="127.0.0.1", port=8000)
