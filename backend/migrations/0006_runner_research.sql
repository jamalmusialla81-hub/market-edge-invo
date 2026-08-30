CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  runner TEXT NOT NULL,
  stage TEXT NOT NULL,
  asset TEXT,
  status TEXT NOT NULL,
  input_cursor INTEGER,
  output_cursor INTEGER,
  candles_processed INTEGER NOT NULL DEFAULT 0,
  decision_points_written INTEGER NOT NULL DEFAULT 0,
  outcomes_resolved INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_runs_created ON research_runs(created_at DESC);
