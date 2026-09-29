-- 0004: Adaptive Exit Manager V1 shadow records (MAJOR 3). Additive only: two
-- new tables. exit_path_observations is append-only; exit_policy_counterfactuals
-- rows are frozen once finalized. Neither is ever read back into a trade record.
CREATE TABLE IF NOT EXISTS exit_path_observations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    eval_ms INTEGER NOT NULL,
    price REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    open REAL NOT NULL,
    batch INTEGER NOT NULL,
    last INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exit_obs_trade ON exit_path_observations (trade_id, seq);
CREATE TABLE IF NOT EXISTS exit_policy_counterfactuals (
    trade_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL,
    finalized INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    params TEXT NOT NULL,
    state TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (trade_id, policy_version)
);
CREATE INDEX IF NOT EXISTS idx_exit_cf_policy ON exit_policy_counterfactuals (policy_version, finalized);
CREATE TRIGGER IF NOT EXISTS exit_path_observations_no_update BEFORE UPDATE ON exit_path_observations
    BEGIN SELECT RAISE(ABORT, 'EXIT_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS exit_path_observations_no_delete BEFORE DELETE ON exit_path_observations
    BEGIN SELECT RAISE(ABORT, 'EXIT_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS exit_cf_finalized_no_update BEFORE UPDATE ON exit_policy_counterfactuals
    WHEN OLD.finalized = 1 BEGIN SELECT RAISE(ABORT, 'EXIT_COUNTERFACTUAL_FINALIZED'); END;
CREATE TRIGGER IF NOT EXISTS exit_cf_finalized_no_delete BEFORE DELETE ON exit_policy_counterfactuals
    WHEN OLD.finalized = 1 BEGIN SELECT RAISE(ABORT, 'EXIT_COUNTERFACTUAL_FINALIZED'); END;
