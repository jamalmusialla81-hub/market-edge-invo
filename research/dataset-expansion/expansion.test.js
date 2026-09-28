'use strict';
const assert = require('node:assert/strict');
const X = require('./expansion.js');
const DAY = 86_400_000;

// Screen: a liquid, long-listed, non-pegged product passes; each rule can fail it.
const product = {id: 'AAA-USD', base_currency: 'AAA', quote_currency: 'USD', status: 'online'};
const daily = (start, n, {price = i => 10 + 5 * Math.sin(i / 40), volume = () => 1e6} = {}) => Array.from({length: n}, (_, i) => ({time: start + i * DAY, open: price(i - 1 < 0 ? 0 : i - 1), high: price(i) * 1.01, low: price(i) * .99, close: price(i), volume: volume(i)}));
const good = daily(X.WINDOW.fromMs, 1600);
assert.equal(X.screenProduct(product, good).pass, true);
assert.equal(X.screenProduct(product, good).firstValidDate, '2021-09-01');
assert.deepEqual(X.screenProduct({...product, status: 'delisted'}, good).failed, ['S1_activeSpot']);
assert.ok(X.screenProduct({...product, base_currency: 'USDC'}, good).failed.includes('S2_notPeggedOrWrapped'));
assert.ok(X.screenProduct(product, daily(X.WINDOW.fromMs, 1600, {price: () => 1})).failed.includes('S2_notPeggedOrWrapped'));      // pegged
assert.ok(X.screenProduct(product, daily(Date.UTC(2024, 6, 1), 400)).failed.includes('S3_history'));                                  // listed too late
assert.ok(X.screenProduct(product, good.filter((_, i) => i % 20)).failed.includes('S4_dailyCoverage'));
assert.ok(X.screenProduct(product, daily(X.WINDOW.fromMs, 1600, {volume: () => 1e4})).failed.includes('S5_liquidity'));
assert.ok(X.screenProduct(product, daily(X.WINDOW.fromMs, 1600, {price: i => i < 800 ? 10 : 100})).failed.includes('S6_noStructuralBreak'));
// Screen ignores holdout-period data entirely.
const late = X.screenProduct(product, [...good.filter(r => r.time < X.WINDOW.fromMs + 1500 * DAY)]);
assert.ok(late.lastValidDate < '2025-11-19');
assert.equal(X.shortlist([{pass: true, medianDailyNotionalUsd: 1}, {pass: false, medianDailyNotionalUsd: 9}, {pass: true, medianDailyNotionalUsd: 5}]).map(s => s.medianDailyNotionalUsd).join(), '5,1');

// Usability: coverage is measured from the asset's own first candle, not the window start.
const from = Date.UTC(2023, 0, 1), to = X.WINDOW.toMs, bars = (to - from) / 300_000;
const entry = {first: new Date(from).toISOString(), to: new Date(to).toISOString(), present: bars, issues: {invalidOhlc: 0, conflictingDuplicates: 0, future: 0, duplicates: 0}, native: {'1h': {present: (to - from) / 3_600_000, issues: {future: 0}}, '1d': {present: (to - from) / DAY, issues: {future: 0}}}, months: [], missingPeriodsOver1h: [{from: '2021-09-01T00:00:00.000Z', hours: 9000}]};
assert.equal(X.usability(entry).usable, true); assert.deepEqual(X.usability(entry).majorGaps, []);
assert.equal(X.usability({...entry, present: bars * .95}).usable, false);
assert.equal(X.usability({...entry, issues: {...entry.issues, future: 1}}).usable, false);

// Diversity value: a lone candidate in an empty scan is not a choice.
const rows = [{asset: 'BTC', direction: 'long', strategy: 'T', timestamp: 1}, {asset: 'AAA', direction: 'short', strategy: 'T', timestamp: 1}, {asset: 'AAA', direction: 'long', strategy: 'T', timestamp: 2}, {asset: 'BTC', direction: 'long', strategy: 'T', timestamp: 3}, {asset: 'ETH', direction: 'long', strategy: 'T', timestamp: 3}, {asset: 'AAA', direction: 'long', strategy: 'T', timestamp: 3}];
const v = X.diversityValue(rows, ['AAA']).AAA;
assert.equal(v.candidateScans, 3); assert.equal(v.newChoiceScans, 1); assert.equal(v.turnsIntoChoice, 1); assert.equal(v.addsNewDirection, 1); assert.equal(v.scansWithNoOldCandidate, 1);

// Scan grid and ids match the frozen generator's grid.
assert.equal(new Date(X.scanGrid().firstScan).toISOString(), '2022-05-20T00:00:00.000Z');
assert.match(X.scanId(0), /^hrp-HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED-86400000-0$/);

// Regimes are point-in-time: changing a bar after the scan changes nothing.
const btc = Array.from({length: 200}, (_, i) => [i * DAY, 100 * Math.exp(i / 100), 1]);
const at = X.regimeClassifier(btc, [150 * DAY])(150 * DAY), later = X.regimeClassifier(btc.map((r, i) => i >= 150 ? [r[0], r[1] * 3, 1] : r), [150 * DAY])(150 * DAY);
assert.equal(at.trend, 'BULL'); assert.equal(at.r60, later.r60);

// Power: halving the effect quadruples the required scans.
const p = X.power(Array.from({length: 400}, (_, i) => (i % 2 ? 1 : -1)), 100);
assert.ok(Math.abs(p.effects['+0.02R'].scansForCiExcludingZero / p.effects['+0.04R'].scansForCiExcludingZero - 4) < .01);
assert.ok(p.effects['+0.04R'].scansFor80Power > p.effects['+0.04R'].scansForCiExcludingZero);
console.log('dataset-expansion tests passed');
