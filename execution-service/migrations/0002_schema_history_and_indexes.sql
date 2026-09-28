-- 0002: record which app version applied each migration, and index the
-- columns the desktop views filter on. Additive only: no table is altered,
-- no row is rewritten, so persistence semantics are unchanged.
CREATE TABLE IF NOT EXISTS schema_history (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at REAL NOT NULL,
    app_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades (status);
CREATE INDEX IF NOT EXISTS idx_paper_signals_at ON paper_signals (at_ms);
CREATE INDEX IF NOT EXISTS idx_paper_equity_at ON paper_equity (at_ms);
