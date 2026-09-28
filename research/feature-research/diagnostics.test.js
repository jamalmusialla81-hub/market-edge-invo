'use strict';
const assert = require('node:assert/strict');
const D = require('./diagnostics.js');

// Horizon resolver: a long that hits TP1 then TP2.
const B = 300_000, T = 1_700_000_000_000 - (1_700_000_000_000 % B), byTime = new Map();
const path = [[100, 100.5, 99.9, 100.4], [100.4, 101.6, 100.3, 101.5], [101.5, 103.2, 101.4, 103]];
path.forEach(([o, h, l, c], k) => byTime.set(T + k * B, {time: T + k * B, open: o, high: h, low: l, close: c}));
const win = D.resolveAtHorizon({timestamp: T, stop: 99, rr: 1.5, direction: 'long'}, byTime, 3);
assert.equal(win.status, 'RESOLVED'); assert.equal(win.TP1_BEFORE_SL, true); assert.equal(win.TP2_HIT, true);
assert.equal(D.resolveAtHorizon({timestamp: T, stop: 99, rr: 1.5, direction: 'long'}, byTime, 5).status, 'RESOLVED', 'TP2 exits before the gap');
assert.equal(D.resolveAtHorizon({timestamp: T, stop: 90, rr: 5, direction: 'long'}, byTime, 5).status, 'UNRESOLVED_DATA_GAP', 'missing candle before exit is never inferred');
// Horizon diagnostic refuses to read past the holdout start.
assert.throws(() => D.horizonDiagnostic([{timestamp: T, asset: 'BTC', targets: {FINAL_R: 0}}], () => byTime, {}, {holdoutStartMs: T + 10 * B}), /HOLDOUT_BREACH/);
// Paired delta requires identical scans.
const pick = (id, r) => ({scan_id: id, timestamp: 0, r, choices: 2, row: {asset: 'BTC', direction: 'long', strategy: 'S'}});
assert.throws(() => D.pairedDelta([pick('a', 1)], [pick('b', 1)]), /PAIRING_MISMATCH/);
const many = Array.from({length: 40}, (_, i) => pick(`s${i}`, i % 2 ? .5 : -.2)), base = many.map(p => ({...p, r: p.r - .1}));
const delta = D.pairedDelta(many, base); assert.ok(Math.abs(delta.meanDelta - .1) < 1e-12); assert.equal(delta.bootstrapWinPct, 100);
// Classification: placebo downgrade.
const good = {meanDelta: .1, bootstrapWinPct: 95, foldsPositive: 5, leaveOneAssetOut: {BTC: .1}};
assert.equal(D.classify({reg: good, rank: good, pairAccDrop: 0, maxSplitShare: .1, leakagePass: true, placeboP: .05}).classification, 'RETAIN');
assert.equal(D.classify({reg: good, rank: good, pairAccDrop: 0, maxSplitShare: .1, leakagePass: true, placeboP: .15}).classification, 'PROMISING');
assert.equal(D.classify({reg: good, rank: good, pairAccDrop: 0, maxSplitShare: .1, leakagePass: true, placeboP: .3}).classification, 'WEAK SIGNAL');
assert.equal(D.classify({reg: good, rank: {...good, meanDelta: -.1}, pairAccDrop: 0, maxSplitShare: .1, leakagePass: true}).classification, 'WEAK SIGNAL');
// ESS: iid series ~ n; strongly autocorrelated series << n.
let s = 1; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - .5; };
const iid = Array.from({length: 400}, rnd), ar = []; let x = 0; for (let i = 0; i < 400; i++) { x = .9 * x + rnd(); ar.push(x); }
assert.ok(D.autocorrEss(iid).ess > 250); assert.ok(D.autocorrEss(ar).ess < 100);
console.log('feature-research diagnostics: all tests passed');
