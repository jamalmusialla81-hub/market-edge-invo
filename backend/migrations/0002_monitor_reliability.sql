-- Source provenance and health are explicit: failures cannot be mislabeled as a complete monitor run.
ALTER TABLE market_states ADD COLUMN quote_currency TEXT;
ALTER TABLE market_states ADD COLUMN canonical_source TEXT;
ALTER TABLE market_states ADD COLUMN backup_source TEXT;
ALTER TABLE market_states ADD COLUMN last_success_at INTEGER;
ALTER TABLE market_states ADD COLUMN last_failure_at INTEGER;
ALTER TABLE market_states ADD COLUMN failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_market_states_health ON market_states(status, updated_at DESC);
