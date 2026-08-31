-- Phase 2 immutable challenger shadow evidence and governance reports.
CREATE TABLE IF NOT EXISTS ml_challenger_shadow_scans (
  scan_id TEXT NOT NULL,
  challenger_model_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  candidate_universe_json TEXT NOT NULL,
  quant_selection_json TEXT NOT NULL,
  incumbent_selection_json TEXT NOT NULL,
  challenger_selection_json TEXT NOT NULL,
  outcome_json TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  immutable INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scan_id, challenger_model_id)
);
CREATE INDEX IF NOT EXISTS idx_ml_challenger_shadow_model ON ml_challenger_shadow_scans(challenger_model_id,timestamp);
CREATE TABLE IF NOT EXISTS ml_promotion_readiness_reports (
  report_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ml_promotion_readiness_model ON ml_promotion_readiness_reports(model_id,created_at DESC);
CREATE TABLE IF NOT EXISTS ml_model_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  report_id TEXT,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ml_model_lifecycle_model ON ml_model_lifecycle_events(model_id,created_at DESC);
