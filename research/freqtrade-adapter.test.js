'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Adapter = require('./freqtrade-adapter.js');
const decision = {signal_id: 'test-1', timestamp: 1_730_332_800_000, asset: 'BTC', direction: 'short', entry: 72_450, stop: 72_663.19, tp1: 71_710.4, tp2: 70_900, rr: 1.8};

test('adapter faithfully maps a frozen decision without an execution capability', () => {
  const signal = Adapter.toResearchSignal(decision);
  assert.equal(signal.enter_short, 1);
  assert.equal(signal.enter_long, 0);
  assert.equal(signal.execution.includes('no exchange order'), true);
  assert.deepEqual(Adapter.parity(decision, signal), {pass: true, mismatch: []});
  assert.equal(Adapter.researchConfig().exchange_execution, false);
});

test('adapter refuses incomplete geometry rather than inventing a trade', () => {
  assert.throws(() => Adapter.toResearchSignal({...decision, stop: null}), /INVALID_FROZEN_DECISION/);
});
