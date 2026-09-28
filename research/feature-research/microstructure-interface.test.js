'use strict';
const assert = require('node:assert/strict');
const M = require('./microstructure-interface.js');

const book = M.fromBook({bids: [[99.9, 5], [99.8, 10]], asks: [[100.1, 2], [100.2, 8]], trades: [{aggressor: 'buy', qty: 3}, {aggressor: 'sell', qty: 1}]});
assert.ok(Math.abs(book.spread_bps - 20) < 1e-9);
assert.equal(book.bid_depth, 5); assert.equal(book.ask_depth, 2);                 // 10 bps window around mid 100
assert.ok(Math.abs(book.microprice - (99.9 * 2 + 100.1 * 5) / 7) < 1e-12);
assert.equal(book.aggressive_buy_flow, 3);
assert.equal(M.fromBook({bids: [], asks: []}).spread_bps, null);
const T = 1_000_000, provenance = {provider: 'X', venue: 'X', instrument: 'BTC-USD', instrument_type: 'SPOT', source_timestamp: T - 500, capture_timestamp: T - 400};
const policy = {side: 'long', maxSpreadBps: 25, minOpposingDepth: 1};
assert.equal(M.assess({alphaValid: false}).decision, 'SKIP');
assert.equal(M.assess({alphaValid: true, micro: M.NotConfiguredProvider.snapshot(), policy, T, maxAgeMs: 1000}).decision, 'WAIT');
assert.equal(M.assess({alphaValid: true, micro: {...book, provenance}, policy: null, T, maxAgeMs: 1000}).reason, 'NO_RESEARCHED_POLICY');
assert.equal(M.assess({alphaValid: true, micro: {...book, provenance: {...provenance, source_timestamp: T - 5000}}, policy, T, maxAgeMs: 1000}).reason, 'STALE_OR_FUTURE_SNAPSHOT');
assert.equal(M.assess({alphaValid: true, micro: {...book, provenance: {...provenance, source_timestamp: T + 1}}, policy, T, maxAgeMs: 1000}).reason, 'STALE_OR_FUTURE_SNAPSHOT');
const unfavourable = M.assess({alphaValid: true, micro: {...book, provenance}, policy: {...policy, maxSpreadBps: 10}, T, maxAgeMs: 1000});
assert.deepEqual([unfavourable.alpha, unfavourable.execution, unfavourable.decision], ['ALPHA_VALID', 'EXECUTION_UNFAVOURABLE', 'WAIT']);
assert.equal(M.assess({alphaValid: true, micro: {...book, provenance}, policy, T, maxAgeMs: 1000}).execution, 'EXECUTION_FAVOURABLE');
console.log('microstructure interface: all tests passed');
