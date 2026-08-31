-- Immutable ML research artifacts. Models are research records, never execution authority.
CREATE TABLE IF NOT EXISTS ml_shadow_predictions (
  prediction_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  prediction_timestamp INTEGER NOT NULL,
  predicted_value REAL NOT NULL,
  calibrated_probability REAL,
  input_feature_hash TEXT NOT NULL,
  outcome_json TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  immutable INTEGER NOT NULL DEFAULT 1,
  UNIQUE(model_id, signal_id)
);
CREATE INDEX IF NOT EXISTS idx_ml_shadow_model ON ml_shadow_predictions(model_id, prediction_timestamp);
