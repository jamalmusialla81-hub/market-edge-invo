'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Factory = require('./research-factory.js');

const records = Array.from({length: 48}, (_, index) => ({asset: index % 2 ? 'BTC' : 'ETH', strategy: 'Trend Continuation', direction: index % 3 ? 'long' : 'short', regime: 'UP_NORMAL', rank: index % 12 + 1, timestamp: 1_700_000_000_000 + index * 300_000, entry: 100, stop: 99, target: {FINAL_R: index % 4 ? 1.2 : -1.1, TP1_BEFORE_SL: index % 4 !== 0, MFE: 1.8, MAE: -.7, bars_held: 12}}));

test('research metrics retain all cost cases and mark fragile edges', () => {
  const result = Factory.costSensitivity(records);
  assert.deepEqual(Object.keys(result.cases), ['0.08%', '0.16%', '0.25%', '0.40%']);
  assert.equal(result.cases['0.16%'].n, 48);
  assert.equal(typeof result.cost_fragile, 'boolean');
});

test('chronological splits never shuffle observations', () => {
  const split = Factory.chronologicalSplits([...records].reverse());
  assert.equal(split.development[0].timestamp, records[0].timestamp);
  assert.equal(split.test.at(-1).timestamp, records.at(-1).timestamp);
});

test('rank analysis retains unranked rows and gates monotonicity on sample size', () => {
  const result = Factory.rankAnalysis(records);
  assert.equal(result.buckets['#1'].n, 4);
  assert.equal(result.ranking_monotonicity, 'INSUFFICIENT EVIDENCE');
});

test('experiment records require immutable provenance', () => {
  assert.throws(() => Factory.experimentRecord({experiment_id: 'x'}), /HYPOTHESIS/);
  const record = Factory.experimentRecord({experiment_id: 'baseline-1', hypothesis: 'Freeze baseline', dataset_hash: 'dataset', engine_hash: 'engine'});
  assert.equal(record.decision, 'PENDING');
  assert.ok(record.record_hash);
});
