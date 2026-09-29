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
  'HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF': Object.freeze({
    status: 'ACTIVE',
    trainable: true,
    approvedAt: '2026-09-27',
    reason: 'Separate version, approved 2026-09-27. 5m/15m/1h strictly from Coinbase spot 5m (no fill, fail closed); 4h from native Coinbase spot 1h and 1d from native Coinbase spot daily candles, point-in-time only. Never mixed with strict V2-CLEAN rows.'
  }),
  // Dataset-expansion v1 (research/dataset-expansion/): the original six
  // assets plus ADA, AERO, AVAX, BCH, DOT, HBAR, LINK, ONDO, UNI, XLM under the
  // same frozen NATIVE-HTF generator and labels. A SEPARATE version: the
  // original NATIVE-HTF dataset above is not overwritten or mixed. Built
  // offline in CI, development window only (the sealed holdout is not read).
  'HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED': Object.freeze({
    status: 'ACTIVE',
    trainable: true,
    developmentOnly: true,
    approvedAt: '2026-09-28',
    reason: 'Separate expanded version (16 assets, 609 development choice scans). Reproduces the 1,362 stored NATIVE-HTF development rows byte-exact. Research measurement only: the placebo gate still fails, so nothing trained on it may be promoted.',
    evidence: 'research/dataset-expansion/README.md; research/dataset-expansion/reports/dataset-manifest.json; CI run 36377309789'
  }),
  // Forward shadow learning (desktop execution-service, research-only SQLite
  // file). Collected continuously; NOT trainable until the labels and the
  // diagnostic classifications have been validated and a grouped (cluster /
  // episode) evaluation plan is approved. Paper-executed rows are a separate
  // store and are never silently mixed with shadow rows.
  'FORWARD-SHADOW-RAW-V1': Object.freeze({
    status: 'COLLECTING',
    trainable: false,
    reason: 'Decision-time observations of every candidate and market state per scan; immutable. Not evidence until resolved and validated.'
  }),
  'FORWARD-SHADOW-RESOLVED-V1': Object.freeze({
    status: 'COLLECTING',
    trainable: false,
    reason: 'Same-venue counterfactual labels and post-outcome hindsight labels (research only). Hindsight fields are targets/diagnostics, never features (shadow-leakage-guard.js). Validate before training.'
  }),
  'FORWARD-PAPER-EXECUTED-V1': Object.freeze({
    status: 'COLLECTING',
    trainable: false,
    reason: 'Copies of paper trades actually accepted; the paper ledger stays authoritative. Too few rows to train on.'
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
// Forward-shadow training snapshots (DATA 3) are registered by adding a NEW entry built from the snapshot's
// manifest (execution-service/market_edge_exec/datasets/builder.py writes manifest.registry_entry). This returns a
// copy of the registry with that entry; it never edits or replaces an existing entry, and a version name is never reused.
function withSnapshot(datasets, manifest) {
  const v = manifest && manifest.version, e = manifest && manifest.registry_entry;
  if (!v || !e || manifest.manifest_schema !== 'forward-snapshot/v1' || !/^FORWARD-SHADOW-RESOLVED-V1-SNAPSHOT-\d{8}$/.test(v)) throw new Error('SNAPSHOT_MANIFEST_INVALID');
  if (!/^[0-9a-f]{64}$/.test(manifest.content_hash || '')) throw new Error('SNAPSHOT_MANIFEST_MISSING_CONTENT_HASH');
  if (datasets[v]) throw new Error(`DATASET_VERSION_EXISTS: ${v} is never overwritten`);
  return Object.freeze({...datasets, [v]: Object.freeze({...e, contentHash: manifest.content_hash, counts: manifest.counts})});
}
module.exports = {DATASETS, status, assertTrainable, withSnapshot};
