"""Regenerates legacy_v0.sqlite3: a database exactly as the desktop MVP
(schema before versioning, PRAGMA user_version = 0) left it, with a custom
starting equity and risk setting. Used to prove the installed app migrates
an existing user's data forward (desktop clean-machine CI, Rust integration
test). Run from execution-service/: python tests/fixtures/make_legacy_v0_db.py"""
import os
import sqlite3
import sys
from contextlib import closing

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from market_edge_exec.control.settings import ControlStore  # noqa: E402
from market_edge_exec.paper.ledger import PaperLedger  # noqa: E402
from market_edge_exec.persistence.store import Store  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "legacy_v0.sqlite3")
if os.path.exists(OUT):
    os.remove(OUT)
Store(OUT)
PaperLedger(OUT, starting_equity=25_000.0)
control = ControlStore(OUT)
control.update_settings({"max_risk_per_trade_pct": 0.5, "stale_data_timeout_s": 90})
with closing(sqlite3.connect(OUT)) as conn:
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    conn.execute("VACUUM")
print(OUT)
