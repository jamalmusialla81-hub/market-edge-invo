'use strict';
const assert = require('node:assert/strict');
const A = require('./candle-archive.js');

const B = A.BASE_MS, t0 = Date.UTC(2025, 0, 1);
const candle = (time, price = 100) => ({time, open: price, high: price + 1, low: price - 1, close: price, volume: 5});

// Coinbase row order [t_s, low, high, open, close, volume] is mapped correctly.
const mapped = A.fromCoinbase([[t0 / 1000, 99, 102, 100, 101, 7]], {asset: 'BTC', product: 'BTC-USD'})[0];
assert.deepEqual([mapped.time, mapped.open, mapped.high, mapped.low, mapped.close, mapped.volume], [t0, 100, 102, 99, 101, 7]);

// Validation drops but never repairs: invalid OHLC, off-grid, future, duplicates.
const input = [candle(t0 + B), candle(t0), candle(t0), {...candle(t0 + 2 * B), close: 999}, candle(t0 + 3 * B + 7), candle(t0 + 5 * B), {...candle(t0 + 4 * B), volume: 1}, {...candle(t0 + 4 * B), volume: 2}, candle(t0 + 10_000 * B)];
const v = A.validateSeries(input, {now: t0 + 100 * B});
assert.deepEqual(v.rows.map(row => (row.time - t0) / B), [0, 1, 4, 5]);
assert.equal(v.issues.invalidOhlc, 1);
assert.equal(v.issues.offGrid, 1);
assert.equal(v.issues.future, 1);
assert.equal(v.issues.duplicates, 2);
assert.equal(v.issues.conflictingDuplicates, 1);
assert.ok(v.issues.nonMonotonicInput > 0);
assert.deepEqual(v.gaps, [{from: t0 + 2 * B, to: t0 + 4 * B, missing: 2}]);

// Presence index counts missing slots, including outside the archive range.
const index = A.presenceIndex(v.rows);
assert.equal(index.missing(t0, t0 + 6 * B), 2);
assert.equal(index.missing(t0 - 2 * B, t0 + 2 * B), 2);
assert.equal(index.missing(t0 + 4 * B, t0 + 6 * B), 0);
assert.equal(index.missing(t0 + 4 * B, t0 + 8 * B), 2);

// Monthly manifests hash exact content and report coverage.
const rows = Array.from({length: 288}, (_, i) => candle(t0 + i * B, 100 + i));
const manifest = A.monthlyManifest(rows, {asset: 'BTC', product: 'BTC-USD', from: t0, to: t0 + 2 * 86_400_000});
assert.equal(manifest.length, 1);
assert.equal(manifest[0].present, 288);
assert.equal(manifest[0].missing, 288);
assert.equal(manifest[0].venue, 'COINBASE');
assert.equal(manifest[0].instrument_type, 'SPOT');
assert.equal(manifest[0].sha256, A.monthlyManifest(rows, {asset: 'BTC', product: 'BTC-USD', from: t0, to: t0 + 2 * 86_400_000})[0].sha256);
assert.notEqual(manifest[0].sha256, A.monthlyManifest(rows.map((row, i) => i ? row : {...row, close: 1}), {asset: 'BTC', product: 'BTC-USD', from: t0, to: t0 + 2 * 86_400_000})[0].sha256);
assert.deepEqual(A.missingPeriods(rows, {from: t0, to: t0 + 2 * 86_400_000}).map(p => p.missing_candles), [288]);
console.log('Candle archive tests passed');
