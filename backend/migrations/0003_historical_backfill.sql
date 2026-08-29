-- Durable, source-specific historical cache for chronological research replay.
CREATE TABLE IF NOT EXISTS historical_dataset_manifests (
  dataset_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  base_timeframe TEXT NOT NULL,
  target_start INTEGER NOT NULL,
  target_end INTEGER NOT NULL,
  cursor_start INTEGER NOT NULL,
  status TEXT NOT NULL,
  downloaded_at INTEGER NOT NULL,
  candle_count INTEGER NOT NULL DEFAULT 0,
  expected_candles INTEGER NOT NULL DEFAULT 0,
  missing_candles INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  gap_count INTEGER NOT NULL DEFAULT 0,
  partial_excluded INTEGER NOT NULL DEFAULT 0,
  coverage REAL NOT NULL DEFAULT 0,
  dataset_hash TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  last_error TEXT,
  completed_at INTEGER,
  PRIMARY KEY(asset, exchange, base_timeframe)
);
CREATE INDEX IF NOT EXISTS idx_historical_manifest_status ON historical_dataset_manifests(status, downloaded_at DESC);
