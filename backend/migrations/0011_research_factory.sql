-- Phase 3B/3C research-only provenance. These tables cannot influence a live
-- scan; they preserve both accepted and rejected experiment evidence.
CREATE TABLE IF NOT EXISTS research_experiments (
  experiment_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  hypothesis TEXT NOT NULL,
  source TEXT NOT NULL,
  strategy TEXT,
  direction TEXT,
  feature_set_json TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  engine_hash TEXT NOT NULL,
  train_range_json TEXT,
  validation_range_json TEXT,
  test_range_json TEXT,
  fee_model_json TEXT NOT NULL,
  result_json TEXT,
  lookahead_status TEXT NOT NULL,
  recursive_status TEXT NOT NULL,
  decision TEXT NOT NULL,
  rejection_reason TEXT,
  record_hash TEXT NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_research_experiments_created ON research_experiments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_experiments_dataset ON research_experiments(dataset_hash,created_at DESC);

CREATE TABLE IF NOT EXISTS research_feature_observations (
  observation_id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  scan_id TEXT,
  signal_timestamp INTEGER NOT NULL,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  strategy TEXT NOT NULL,
  rank INTEGER,
  feature_definition_version TEXT NOT NULL,
  feature_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  outcome_json TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_feature_observation_recommendation ON research_feature_observations(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_research_feature_observation_time ON research_feature_observations(signal_timestamp);
