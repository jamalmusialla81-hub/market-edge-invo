'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Analysis = require('./dataset-analysis.js');

const row = (index, rank) => ({
  signal_id: `row-${index}`, timestamp: 1_700_000_000_000 + index, asset: 'BTC', strategy: 'Trend Continuation', direction: index % 2 ? 'long' : 'short', regime: 'UP_NORMAL', quality_score: 70, preferred_entry: 100, stop: 99, tp1: 102, rr: 2,
  features_json: JSON.stringify({entryQuality: 'IDEAL', rank}),
  targets_json: JSON.stringify({status: 'RESOLVED', FINAL_R: index % 2 ? 1.1 : -1.2, TP1_BEFORE_SL: index % 2 === 1, MFE: 1.5, MAE: -.8, bars_held: 8})
});

test('dataset report only uses immutable resolved targets and retains unavailable rank buckets', () => {
  const result = Analysis.report([row(1, 1), row(2, 6), row(3, null)]);
  assert.equal(result.total_rows, 3);
  assert.equal(result.eligible_resolved_rows, 3);
  assert.equal(result.baseline.n, 3);
  assert.equal(result.distributions.entry_quality.IDEAL.n, 3);
  assert.equal(result.distributions.rank.buckets['#1'].n, 1);
  assert.equal(result.distributions.rank.buckets['UNRANKED'].n, 1);
  assert.equal(result.fitness_metric_audit.status, 'PASS_FOR_RESOLVED_WINDOW');
});
