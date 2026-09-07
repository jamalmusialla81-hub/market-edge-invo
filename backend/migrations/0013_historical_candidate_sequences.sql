-- Immutable normalized candle-sequence inputs for historical rank candidates.
-- Raw candles remain reproducible from the already-hashed canonical cache;
-- this table stores only price-scale-invariant model inputs and provenance.
CREATE TABLE IF NOT EXISTS historical_candidate_sequences (
  candidate_id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  signal_timestamp INTEGER NOT NULL,
  asset TEXT NOT NULL,
  sequence_version TEXT NOT NULL,
  source_dataset_hash TEXT NOT NULL,
  sequence_hash TEXT NOT NULL,
  sequence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(candidate_id) REFERENCES historical_scan_candidates(candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_historical_candidate_sequences_scan ON historical_candidate_sequences(scan_id, signal_timestamp);
