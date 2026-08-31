-- Immutable autonomous ML dataset snapshots and pre-outcome selection pairs.
-- These records are research artifacts only and never grant execution authority.
CREATE TABLE IF NOT EXISTS ml_dataset_generations (
  dataset_id TEXT PRIMARY KEY,
  dataset_hash TEXT NOT NULL UNIQUE,
  source_dataset_id TEXT NOT NULL,
  source_dataset_hash TEXT NOT NULL,
  row_ids_json TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  new_row_count INTEGER NOT NULL,
  date_start INTEGER NOT NULL,
  date_end INTEGER NOT NULL,
  feature_schema_version TEXT NOT NULL,
  target_schema_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ml_dataset_generations_created ON ml_dataset_generations(created_at DESC);

CREATE TABLE IF NOT EXISTS ml_forward_selection_snapshots (
  selection_id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  quant_only_json TEXT NOT NULL,
  ml_assisted_json TEXT NOT NULL,
  outcome_json TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ml_forward_selection_timestamp ON ml_forward_selection_snapshots(timestamp);
