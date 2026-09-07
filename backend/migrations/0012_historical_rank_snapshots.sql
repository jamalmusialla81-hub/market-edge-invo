-- Immutable research-only snapshots of the full candidate universe available at
-- a historical scan decision time.  These tables are deliberately separate
-- from customer recommendations and cannot affect a production scan.
CREATE TABLE IF NOT EXISTS historical_scan_snapshots (
  scan_id TEXT PRIMARY KEY,
  scan_timestamp INTEGER NOT NULL,
  data_timestamp INTEGER NOT NULL,
  universe_mode TEXT NOT NULL,
  eligible_universe_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  quant_version TEXT NOT NULL,
  ml_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  source_dataset_hash TEXT NOT NULL,
  scan_cadence_ms INTEGER NOT NULL,
  candidate_count INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_historical_scan_snapshots_time ON historical_scan_snapshots(scan_timestamp);

CREATE TABLE IF NOT EXISTS historical_scan_candidates (
  candidate_id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  invo_instrument TEXT,
  direction TEXT NOT NULL,
  strategy TEXT NOT NULL,
  reference_price REAL,
  entry REAL,
  stop REAL,
  tp1 REAL,
  tp2 REAL,
  rr REAL,
  setup_quality REAL,
  entry_quality TEXT,
  quant_score REAL,
  ml_applicability TEXT NOT NULL,
  ml_raw_score REAL,
  combined_score REAL,
  regime TEXT,
  feature_json TEXT NOT NULL,
  feature_hash TEXT NOT NULL,
  candidate_rank INTEGER,
  candidate_count INTEGER NOT NULL,
  valid_current_geometry INTEGER NOT NULL,
  invalidation_reason TEXT,
  targets_json TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  immutable INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(scan_id) REFERENCES historical_scan_snapshots(scan_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_historical_scan_candidates_scan_rank ON historical_scan_candidates(scan_id,candidate_rank);
CREATE INDEX IF NOT EXISTS idx_historical_scan_candidates_asset ON historical_scan_candidates(asset,created_at);
CREATE INDEX IF NOT EXISTS idx_historical_scan_candidates_pending ON historical_scan_candidates(scan_id,resolved_at);
