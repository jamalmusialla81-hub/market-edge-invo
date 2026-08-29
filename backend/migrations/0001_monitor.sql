-- Market Edge server-side research storage. No exchange credentials or execution tables exist.
CREATE TABLE IF NOT EXISTS monitor_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,
  assets_requested INTEGER NOT NULL DEFAULT 0,
  assets_completed INTEGER NOT NULL DEFAULT 0,
  candles_written INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]',
  engine_version TEXT NOT NULL,
  execution_disabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS canonical_candles (
  asset TEXT NOT NULL,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  close_time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  source_latency_ms INTEGER,
  received_at INTEGER NOT NULL,
  dataset_hash TEXT NOT NULL,
  PRIMARY KEY (asset, exchange, interval, open_time)
);
CREATE INDEX IF NOT EXISTS idx_canonical_candles_recent ON canonical_candles(asset, interval, open_time DESC);

CREATE TABLE IF NOT EXISTS market_states (
  asset TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  data_health TEXT NOT NULL,
  source_status TEXT NOT NULL,
  reference_price REAL,
  reference_time INTEGER,
  stale_after INTEGER,
  disagreement_pct REAL,
  state_json TEXT NOT NULL,
  dataset_hash TEXT,
  engine_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  execution_disabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS monitor_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  asset TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_monitor_events_created ON monitor_events(created_at DESC);

CREATE TABLE IF NOT EXISTS tradingview_alert_evidence (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  asset TEXT,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  alert_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS paper_signal_snapshots (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  signal_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  dataset_hash TEXT,
  execution_disabled INTEGER NOT NULL DEFAULT 1,
  immutable INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS paper_outcomes (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  outcome_json TEXT NOT NULL,
  FOREIGN KEY(signal_id) REFERENCES paper_signal_snapshots(id)
);

CREATE TABLE IF NOT EXISTS model_registry (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
