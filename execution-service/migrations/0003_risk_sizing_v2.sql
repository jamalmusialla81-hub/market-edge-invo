-- 0003: Risk Sizing V2 records. Additive only: two new tables, both
-- immutable (UPDATE/DELETE refused), so an original sizing decision or an
-- after-trade measurement can never be rewritten by later data.
CREATE TABLE IF NOT EXISTS risk_sizing_decisions (
    decision_id TEXT PRIMARY KEY,
    signal_id TEXT,
    asset TEXT,
    mode TEXT NOT NULL,
    role TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    approved INTEGER NOT NULL,
    reason TEXT,
    created_at_ms INTEGER NOT NULL,
    record TEXT NOT NULL,
    record_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_sizing_signal ON risk_sizing_decisions (signal_id);
CREATE TABLE IF NOT EXISTS risk_sizing_outcomes (
    signal_id TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    record TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS risk_sizing_decisions_no_update BEFORE UPDATE ON risk_sizing_decisions
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS risk_sizing_decisions_no_delete BEFORE DELETE ON risk_sizing_decisions
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS risk_sizing_outcomes_no_update BEFORE UPDATE ON risk_sizing_outcomes
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS risk_sizing_outcomes_no_delete BEFORE DELETE ON risk_sizing_outcomes
    BEGIN SELECT RAISE(ABORT, 'SIZING_RECORD_IMMUTABLE'); END;
