'use strict';

// Read-only analysis of immutable decision records.  This module has no
// network, scanner, model, exchange, or persistence capability.
const Factory = require('./research-factory.js');

const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; } };
const valueAt = (object, paths) => {
  for (const path of paths) {
    let value = object;
    for (const key of path.split('.')) value = value && typeof value === 'object' ? value[key] : undefined;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};
const label = value => value == null ? 'UNAVAILABLE' : String(value);
const groupBy = (rows, resolver) => rows.reduce((groups, row) => {
  const key = label(resolver(row));
  (groups[key] ||= []).push(row);
  return groups;
}, {});

function normalize(row) {
  const features = json(row.features_json ?? row.features), target = json(row.targets_json ?? row.targets ?? row.target);
  const rank = finite(valueAt(row, ['rank'])) ?? finite(valueAt(features, ['rank', 'scan_rank', 'candidateRank', 'candidate_rank', 'selection.rank']));
  return {
    signal_id: String(row.signal_id || ''), timestamp: finite(row.timestamp), asset: row.asset || null,
    strategy: row.strategy || null, direction: row.direction || null, regime: row.regime || null,
    quality_score: finite(row.quality_score), entry: finite(row.preferred_entry ?? row.entry ?? row.signal_price),
    stop: finite(row.stop), tp1: finite(row.tp1), tp2: finite(row.tp2), rr: finite(row.rr), rank,
    entry_quality: valueAt(features, ['entryQuality', 'entry_quality', 'entry.quality']),
    setup_quality: valueAt(features, ['setupQuality', 'setup_quality']) ?? finite(row.quality_score),
    features, target
  };
}

function metricGroups(rows, resolver) {
  return Object.fromEntries(Object.entries(groupBy(rows, resolver)).map(([key, values]) => [key, Factory.metrics(values)]));
}

function report(rows) {
  const normalized = rows.map(normalize).filter(row => row.signal_id && Number.isFinite(row.timestamp));
  const metricRows = normalized.filter(row => Number.isFinite(row.target?.FINAL_R));
  const featureKeys = [...new Set(metricRows.flatMap(row => Object.keys(row.features || {})))].sort();
  const result = {
    source: 'immutable-resolved-decision-records',
    total_rows: normalized.length,
    eligible_resolved_rows: metricRows.length,
    baseline: Factory.metrics(metricRows),
    cost_sensitivity: Factory.costSensitivity(metricRows),
    distributions: {
      strategy: metricGroups(metricRows, row => row.strategy),
      direction: metricGroups(metricRows, row => row.direction),
      asset: metricGroups(metricRows, row => row.asset),
      regime: metricGroups(metricRows, row => row.regime),
      entry_quality: metricGroups(metricRows, row => row.entry_quality),
      setup_quality: metricGroups(metricRows, row => row.setup_quality),
      rank: Factory.rankAnalysis(metricRows)
    },
    feature_inventory: featureKeys,
    fitness_metric_audit: {
      resolved_rows: metricRows.length,
      missing_final_r: normalized.length - metricRows.length,
      all_resolved_rows_included: metricRows.length === normalized.length,
      mark_to_market_available: false,
      status: normalized.length === metricRows.length ? 'PASS_FOR_RESOLVED_WINDOW' : 'INCOMPLETE_PENDING_OR_MISSING_OUTCOMES'
    }
  };
  return result;
}

module.exports = {normalize, report};
