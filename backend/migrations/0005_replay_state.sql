CREATE TABLE IF NOT EXISTS replay_states (
 asset TEXT PRIMARY KEY, dataset_version TEXT NOT NULL, source_dataset_hash TEXT NOT NULL, status TEXT NOT NULL, cursor_timestamp INTEGER, last_processed_timestamp INTEGER, candles_processed INTEGER NOT NULL DEFAULT 0, decision_points_written INTEGER NOT NULL DEFAULT 0, targets_written INTEGER NOT NULL DEFAULT 0, started_at INTEGER, updated_at INTEGER NOT NULL, completed_at INTEGER, last_error TEXT
);
