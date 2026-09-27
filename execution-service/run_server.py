"""Runs the paper execution-service against a configurable DB path (env
EXECUTION_SERVICE_DB_PATH). Used by the endurance harness (Part I), which
needs the SAME persisted SQLite file across separate CI runs -- the
`--factory` uvicorn CLI has no way to pass an argument to the factory
function, so this tiny wrapper exists only to do that.

The desktop app also launches the service through this file (frozen by
PyInstaller into the `market-edge-exec` executable), with
EXECUTION_SERVICE_PORT to pick the port and POST /system/shutdown for a
graceful, cross-platform stop (no reliance on POSIX signals on Windows).

Maintenance subcommands (used by the desktop app's backup/restore; each
prints one JSON object and exits 0 on success):
  version                      build/version/schema info
  backup-db SRC DST            consistent online copy of SRC into DST
  validate-db PATH             read-only integrity/schema check
  migrate PATH                 back up if needed, create tables, migrate forward
  nautilus-selftest            runs the real Nautilus BacktestEngine scenario
                               (diagnostics/real_backtest_scenarios.py) to prove
                               the full nautilus_trader package is present
"""
import json
import os
import sys


def _print(obj, ok=True):
    print(json.dumps(obj, default=str))
    sys.exit(0 if ok else 1)


def _maintenance(argv):
    from market_edge_exec.buildinfo import build_info
    from market_edge_exec.persistence import migrations

    cmd = argv[0]
    try:
        if cmd == "version":
            _print({**build_info(), "schema_version": migrations.target_version()})
        if cmd == "backup-db" and len(argv) == 3:
            dst = migrations.backup_database(argv[1], argv[2])
            _print({"ok": True, "path": dst, **migrations.inspect_database(dst)})
        if cmd == "validate-db" and len(argv) == 2:
            result = migrations.inspect_database(argv[1])
            _print(result, ok=result["ok"])
        if cmd == "nautilus-selftest":
            if not getattr(sys, "frozen", False):
                sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "diagnostics"))
            import nautilus_trader
            import real_backtest_scenarios
            report = real_backtest_scenarios.run()
            # the rest of the package's heavy dependencies load too (data catalog = pyarrow/pandas)
            import pandas
            import pyarrow
            from nautilus_trader.persistence.catalog import ParquetDataCatalog  # noqa: F401
            ok = report["orders_filled"] >= 4 and report["positions_closed"] >= 2
            _print({"ok": ok, "nautilus_trader": nautilus_trader.__version__, "pyarrow": pyarrow.__version__,
                    "pandas": pandas.__version__, **report}, ok=ok)
        if cmd == "migrate" and len(argv) == 2:
            from market_edge_exec.api.app import create_app
            app = create_app(db_path=argv[1])
            _print({"ok": True, **app.state.migration.to_dict()})
    except migrations.MigrationError as error:
        _print({"ok": False, "error": str(error)}, ok=False)
    _print({"ok": False, "error": f"usage: {__doc__}"}, ok=False)


def main():
    if len(sys.argv) > 1:
        _maintenance(sys.argv[1:])

    import uvicorn

    from market_edge_exec.api.app import create_app
    from market_edge_exec.persistence.migrations import MigrationError

    try:
        app = create_app(db_path=os.environ.get("EXECUTION_SERVICE_DB_PATH", "market_edge_exec.sqlite3"))
    except MigrationError as error:
        # Fail safe: the database and any backup are left exactly as they are.
        print(json.dumps({"event": "startup_refused", "error": str(error)}), file=sys.stderr, flush=True)
        sys.exit(3)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=int(os.environ.get("EXECUTION_SERVICE_PORT", "8000")),
                                          # the desktop app polls every few seconds; its log view doesn't need each GET
                                          access_log=os.environ.get("EXECUTION_SERVICE_ACCESS_LOG", "1") != "0"))

    def request_shutdown():
        server.should_exit = True

    app.state.request_shutdown = request_shutdown
    if os.environ.get("EXECUTION_SERVICE_EXIT_ON_STDIN_EOF") == "1":
        # The desktop app holds our stdin pipe. If the app dies without a
        # clean shutdown (force quit, crash), the pipe closes and we stop
        # gracefully instead of lingering as an orphan on the port.
        import threading

        def watch_parent():
            try:
                while sys.stdin.buffer.read(1024):
                    pass
            except Exception:
                pass
            print(json.dumps({"event": "parent_gone_shutdown"}), file=sys.stderr, flush=True)
            request_shutdown()

        threading.Thread(target=watch_parent, daemon=True).start()
    server.run()
    if os.environ.get("EXECUTION_SERVICE_EXIT_ON_STDIN_EOF") == "1":
        # Every write is its own committed SQLite transaction, so nothing is
        # pending here. Exit now rather than in interpreter teardown, which can
        # block on Windows while the watcher thread still has a read on stdin.
        print(json.dumps({"event": "service_stopped"}), file=sys.stderr, flush=True)
        sys.stdout.flush()
        os._exit(0)


if __name__ == "__main__":
    main()
