'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Features = require('./feature-engine.js');

const START = Date.UTC(2025, 0, 1);
function candles(interval, count = 80) {
  return Array.from({length: count}, (_, index) => {
    const base = 100 + index * .35 + (index % 7 === 0 ? 1.1 : 0);
    return {time: START + index * interval, open: base, high: base + 1.2, low: base - 1, close: base + .25, volume: 1000 + index * 10};
  });
}
function frames(signalTime) {
  return Object.fromEntries(Object.entries(Features.INTERVALS).map(([name, interval]) => [name, candles(interval).filter(row => row.time + interval <= signalTime)]));
}

test('objective snapshots are frozen from fully completed candles only', () => {
  const signalTime = START + 80 * Features.INTERVALS.m5;
  const snapshot = Features.snapshot({timeframes: frames(signalTime), signalTime, trade: {direction: 'long', entry: 120, tp1: 125}});
  assert.equal(snapshot.featureDefinitionVersion, 'objective-feature-v1');
  assert.equal(snapshot.signalTimestamp, signalTime);
  assert.ok(snapshot.featureHash);
  assert.equal(snapshot.orderBlock.status, 'RESEARCH_ONLY_NOT_IMPLEMENTED');
  assert.ok(['AVAILABLE', 'UNAVAILABLE'].includes(snapshot.ltfConfirmation.status));
  for (const source of Object.values(snapshot.sources)) assert.ok(source.latestCandleClose == null || source.latestCandleClose <= signalTime);
  for (const frame of Object.values(snapshot.frames)) {
    assert.ok(frame.structure.pivotDefinition);
    assert.ok(frame.source.latestCandleClose == null || frame.source.latestCandleClose <= signalTime);
  }
  assert.equal(Features.assertPreEntry(snapshot, signalTime), true);
});

test('future or incomplete MTF candles are rejected before feature generation', () => {
  const signalTime = START + 80 * Features.INTERVALS.m5;
  const input = frames(signalTime);
  input.m15.push({time: signalTime - Features.INTERVALS.m15 / 2, open: 100, high: 101, low: 99, close: 100, volume: 1});
  assert.throws(() => Features.snapshot({timeframes: input, signalTime}), /LOOKAHEAD_REJECTED/);
});

test('confirmed pivots cannot be available before their right-side bars close', () => {
  const interval = Features.INTERVALS.m5;
  const rows = candles(interval, 12);
  const signalTime = rows[5].time + interval;
  const pivots = Features.confirmedPivots(rows, interval, signalTime);
  assert.ok([...pivots.highs, ...pivots.lows].every(pivot => pivot.confirmedAt <= signalTime));
});
