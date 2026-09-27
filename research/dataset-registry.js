'use strict';

// Authoritative status of every historical rank dataset generation.  Research
// and training code must call assertTrainable() before reading a generation.
// Invalid generations are preserved untouched in D1 for auditability; they are
// never repaired in place and never used as evidence.
const DATASETS = Object.freeze({
  'HISTORICAL-RANK-PILOT-V2': Object.freeze({
    status: 'UNVERIFIED',
    trainable: false,
    reason: 'Built by the same cached-snapshot path as V1 and never audited for stale inputs; do not use as evidence until re-audited.'
  }),
  'HISTORICAL-RANK-V1': Object.freeze({
    status: 'INVALID_CONTAMINATED',
    trainable: false,
    invalidatedAt: '2026-09-27',
    reason: 'Stale frozen inputs: generation continued past the end of the historical Coinbase backfill and cachedSnapshot() reused the last available candles (529/572 resolved rows). Their outcomes were relabelled with Binance USD-M prices against stale stops. The daily trainer also selected models on the test tail. Preserved for audit only.',
    evidence: 'research/RANK_RESEARCH_V2.md; CI runs 36302777190 and 36303109323',
    preservedIn: 'D1 historical_scan_snapshots / historical_scan_candidates / historical_candidate_sequences where engine_version = HISTORICAL-RANK-V1'
  }),
  'HISTORICAL-RANK-V2-CLEAN': Object.freeze({
    status: 'ACTIVE',
    trainable: true,
    reason: 'Rebuilt from genuine Coinbase spot 5m candles with fail-closed freshness, gap and provenance invariants; strict outcome labels (missing data = unresolved).'
  })
});
function status(engine) { return DATASETS[engine] || {status: 'UNKNOWN', trainable: false, reason: 'Unregistered dataset generation'}; }
function assertTrainable(engine) {
  const entry = status(engine);
  if (!entry.trainable) throw new Error(`DATASET_NOT_TRAINABLE: ${engine} is ${entry.status}. ${entry.reason}`);
  return entry;
}
module.exports = {DATASETS, status, assertTrainable};
