-- Anonymous, app-generated paper evidence only. No accounts, wallets, balances, names or notes.
CREATE TABLE IF NOT EXISTS community_paper_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('SIGNAL','OUTCOME')),
  client_signal_id TEXT NOT NULL,
  signal_json TEXT NOT NULL,
  outcome_json TEXT,
  created_at INTEGER NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_community_paper_signal ON community_paper_events(client_signal_id, created_at);
