'use strict';
const assert = require('node:assert/strict');
const C = require('./catalyst-events.js');

const base = {event_time: '2026-10-20T20:05:00Z', available_at: '2026-10-20T20:06:00Z', ticker: 'AAPL', category: 'REPORTED', directionality: 'BULLISH', confidence: .8, extraction: 'MACHINE_EXTRACTED', extractor: {name: 'headline-parser', version: '0.1'}, source: {name: 'WSJ', kind: 'NEWSWIRE'}, raw: {headline: 'Apple beats'}, payload: {fiscal_period: 'FY26Q4', eps_estimate: 1.6, eps_actual: 1.7}};
const earnings = C.createEvent('EarningsEvent', base);
assert.equal(earnings.type, 'EarningsEvent');
assert.deepEqual(earnings.tickers, ['AAPL']);
assert.ok(Object.isFrozen(earnings));
assert.equal(C.createEvent('EarningsEvent', base).event_id, earnings.event_id, 'ids are deterministic');

// Required provenance and point-in-time fields fail closed.
assert.throws(() => C.createEvent('EarningsEvent', {...base, available_at: undefined}), /AVAILABLE_AT_REQUIRED/);
assert.throws(() => C.createEvent('EarningsEvent', {...base, raw: undefined}), /RAW_PROVENANCE/);
assert.throws(() => C.createEvent('EarningsEvent', {...base, extraction: undefined}), /EXTRACTION_REQUIRED/);
assert.throws(() => C.createEvent('EarningsEvent', {...base, extraction: 'HUMAN_REVIEWED'}), /REVIEW_PROVENANCE/);
assert.throws(() => C.createEvent('EarningsEvent', {...base, confidence: 1.5}), /CONFIDENCE/);
assert.throws(() => C.createEvent('EarningsEvent', {...base, category: 'UPGRADE'}), /CATEGORY_INVALID/);
assert.throws(() => C.createEvent('EarningsEvent', {...base, payload: {eps_final_return: 1}}), /UNKNOWN_FIELDS/);
assert.throws(() => C.createEvent('AnalystEvent', {...base, ticker: undefined, category: 'UPGRADE', payload: {}}), /TICKER_REQUIRED/);
const macro = C.createEvent('MacroEvent', {...base, ticker: undefined, category: 'CPI', payload: {region: 'US', indicator: 'CPI YoY', consensus: 2.9, actual: 3.1}});
assert.deepEqual(macro.tickers, []);

// Point-in-time filtering and immutable revisions.
const analyst = C.createEvent('AnalystEvent', {...base, category: 'UPGRADE', available_at: '2026-10-21T12:00:00Z', event_time: '2026-10-21T11:30:00Z', payload: {firm: 'X', rating_from: 'HOLD', rating_to: 'BUY'}, extraction: 'HUMAN_REVIEWED', reviewed_by: 'analyst-1', reviewed_at: '2026-10-21T12:00:00Z'});
const revision = C.createEvent('EarningsEvent', {...base, available_at: '2026-10-22T00:00:00Z', payload: {...base.payload, eps_actual: 1.65}, supersedes: earnings.event_id});
const events = [earnings, analyst, revision, macro];
assert.deepEqual(C.asOf(events, '2026-10-20T20:05:30Z', {ticker: 'AAPL'}).map(e => e.event_id), []);
assert.deepEqual(C.asOf(events, '2026-10-21T00:00:00Z', {ticker: 'AAPL'}).map(e => e.event_id).sort(), [earnings.event_id, macro.event_id].sort());
assert.ok(!C.asOf(events, '2026-10-23T00:00:00Z', {ticker: 'AAPL'}).some(e => e.event_id === earnings.event_id), 'a knowable revision supersedes the original');
assert.deepEqual(C.asOf(events, '2026-10-23T00:00:00Z', {ticker: 'AAPL', humanReviewedOnly: true}).map(e => e.event_id), [analyst.event_id]);
assert.ok(C.assertPointInTime({decision_time: Date.parse('2026-10-21T13:00:00Z'), event_ids: [analyst.event_id]}, events));
assert.throws(() => C.assertPointInTime({decision_time: Date.parse('2026-10-21T11:59:00Z'), event_ids: [analyst.event_id]}, events), /LOOKAHEAD_REJECTED/);
console.log('Catalyst event research interface tests passed');
