/* TASK Y (#102): forward evidence sufficiency. Measurement only: nothing consumes this to gate a decision yet.
   Raw trade count is not evidence. Correlated trades from one episode or cluster count once, so a large single-episode
   sample cannot reach DECISION_USEFUL while a smaller, genuinely diverse one can. Elapsed time never suffices by itself.
   Missing episode/cluster/scan linkage is counted as unlinked and never invented, so it can only lower a tier. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MarketEdgeEvidence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 'EVIDENCE-SUFFICIENCY-V1';
  const DAY_MS = 86400000;
  // DECISION_USEFUL floors are the forward-diagnostic floors (execution-service analysis/forward_diagnostic.py FLOORS).
  const FLOORS = { resolved: 100, clusters: 30, episodes: 30, days: 14, assets: 4, strategies: 2 };
  // The legacy sampleTier used 10 / 30 / 100 trades: DIRECTIONAL = 30% and EARLY = 10% of the DECISION_USEFUL floor on every
  // dimension (rounded up), the same ratios, applied to independent evidence instead of raw trades.
  const TIERS = [
    { tier: 'DECISION_USEFUL', legacy: 'decision-useful', fraction: 1 },
    { tier: 'DIRECTIONAL', legacy: 'directional', fraction: 0.3 },
    { tier: 'EARLY', legacy: 'early', fraction: 0.1 }
  ];
  const tierFloors = fraction => Object.fromEntries(Object.entries(FLOORS).map(([k, v]) => [k, Math.max(1, Math.ceil(v * fraction - 1e-9))]));

  const text = v => (v === undefined || v === null || v === '' ? null : String(v));
  function pick(row, keys) { for (const k of keys) { const v = text(row && row[k]); if (v !== null) return v; } return null; }
  function timeMs(row) {
    for (const k of ['resolvedAtMs', 'resolved_at_ms', 'decisionTs', 'decision_ts', 'timeMs', 'time', 'entryTime', 'ts']) {
      const n = Number(row && row[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }
  function isResolved(row) {
    if (row && typeof row.resolved === 'boolean') return row.resolved;
    if (row && row.resolutionStatus) return ['RESOLVED', 'RESOLVED_WITH_GAPS'].includes(row.resolutionStatus);
    return Number.isFinite(Number(row && (row.r ?? row.resultR ?? row.outcomeR))) && (row.r ?? row.resultR ?? row.outcomeR) !== null;
  }

  /* rows: [{scanId, episodeId, clusterId, asset, strategy, direction, regime, time|decisionTs, resolved|r}] (snake_case accepted). */
  function evidenceSufficiency(rows) {
    const all = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : [];
    const resolvedRows = all.filter(isResolved);
    const distinct = (list, keys) => new Set(list.map(r => pick(r, keys)).filter(v => v !== null));
    const episodeKeys = ['episodeId', 'episode_id', 'marketEpisodeId', 'market_episode_id'];
    const clusterKeys = ['clusterId', 'cluster_id', 'observationClusterId', 'observation_cluster_id'];
    const scanKeys = ['scanId', 'scan_id'];
    const times = resolvedRows.map(timeMs).filter(v => v !== null);
    const counts = {
      observations: all.length,
      resolved: resolvedRows.length,
      episodes: distinct(resolvedRows, episodeKeys).size,
      scans: distinct(resolvedRows, scanKeys).size,
      clusters: distinct(resolvedRows, clusterKeys).size,
      assets: distinct(resolvedRows, ['asset', 'coin']).size,
      strategies: distinct(resolvedRows, ['strategy', 'strategyId', 'strategy_id']).size,
      directions: distinct(resolvedRows, ['direction']).size,
      regimes: distinct(resolvedRows, ['regime']).size,
      days: times.length > 1 ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0
    };
    const unlinked = {
      episode: resolvedRows.filter(r => pick(r, episodeKeys) === null).length,
      cluster: resolvedRows.filter(r => pick(r, clusterKeys) === null).length,
      scan: resolvedRows.filter(r => pick(r, scanKeys) === null).length
    };
    const cleared = floors => Object.keys(floors).every(k => counts[k] >= floors[k]);
    const hit = TIERS.find(t => cleared(tierFloors(t.fraction)));
    const status = hit ? hit.tier : 'INSUFFICIENT';
    // What holds the next tier back: the dimensions below its floors, worst shortfall first.
    const next = hit ? TIERS[TIERS.indexOf(hit) - 1] : TIERS[TIERS.length - 1];
    const nextFloors = next ? tierFloors(next.fraction) : null;
    const shortfalls = nextFloors ? Object.keys(nextFloors).filter(k => counts[k] < nextFloors[k])
      .map(k => ({ dimension: k, have: Math.round(counts[k] * 100) / 100, need: nextFloors[k] }))
      .sort((a, b) => a.have / a.need - b.have / b.need) : [];
    const warnings = [];
    if (counts.resolved && counts.resolved >= 2 * Math.max(1, counts.episodes)) warnings.push(`${counts.resolved} resolved outcomes come from only ${counts.episodes} independent episodes`);
    if (unlinked.episode || unlinked.cluster) warnings.push(`${unlinked.episode} resolved rows have no episode id and ${unlinked.cluster} no cluster id; they add no independent evidence`);
    return {
      version: VERSION, status, legacyTier: hit ? hit.legacy : 'tiny', counts, unlinked, floors: FLOORS,
      tierFloors: Object.fromEntries(TIERS.map(t => [t.tier, tierFloors(t.fraction)])),
      nextTier: next ? next.tier : null, shortfalls, warnings,
      note: 'Measurement only. Diversity of direction and regime is reported but has no floor yet. Elapsed days alone never lift a tier.'
    };
  }

  return { VERSION, FLOORS, TIERS, tierFloors, evidenceSufficiency };
});
