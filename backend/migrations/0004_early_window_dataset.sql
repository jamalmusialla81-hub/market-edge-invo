CREATE TABLE IF NOT EXISTS historical_decision_points (
  signal_id TEXT PRIMARY KEY, asset TEXT NOT NULL, timestamp INTEGER NOT NULL, strategy TEXT NOT NULL, direction TEXT NOT NULL, regime TEXT NOT NULL, quality_score REAL NOT NULL, signal_price REAL NOT NULL, preferred_entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL NOT NULL, tp2 REAL NOT NULL, rr REAL NOT NULL, features_json TEXT NOT NULL, targets_json TEXT NOT NULL, dataset_version TEXT NOT NULL, source_dataset_hash TEXT NOT NULL, created_at INTEGER NOT NULL, immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_historical_decisions_asset_time ON historical_decision_points(asset,timestamp);
CREATE TABLE IF NOT EXISTS research_datasets (
  id TEXT PRIMARY KEY, dataset_hash TEXT NOT NULL, source_hashes_json TEXT NOT NULL, date_start INTEGER NOT NULL, date_end INTEGER NOT NULL, feature_schema_json TEXT NOT NULL, target_schema_json TEXT NOT NULL, summary_json TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL
);
