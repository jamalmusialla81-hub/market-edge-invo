'use strict';
const assert = require('node:assert/strict');
const C = require('./historical-rank-v2-clean.js');

const B = 300_000, DAY = 86_400_000, scan = Date.UTC(2025, 2, 1);
function series(start, count, seed = 1, drift = 0) {
  let state = seed, price = 100; const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  return Array.from({length: count}, (_, i) => { const open = price, move = (random() - .5) * .004 + drift + .002 * Math.sin(i / 400); price = Math.max(1, open * (1 + move)); const high = Math.max(open, price) * (1 + random() * .001), low = Math.min(open, price) * (1 - random() * .001); return {time: start + i * B, open, high, low, close: price, volume: 10 + random() * 10}; });
}
const history = C.HISTORY_BARS + 400, start = scan - (C.HISTORY_BARS + 100) * B;
const full = series(start, history, 7, .00002);
const prepared = C.prepareAsset('BTC', full, {now: scan + 10 * DAY});

// Fresh, complete history passes.
const ok = C.historyCheck(prepared, scan);
assert.equal(ok.ok, true); assert.equal(ok.freshness_status, 'FRESH_EXACT'); assert.equal(ok.latest_feature_candle_close, scan);
// Missing latest candle => stale => fail closed.
const noLatest = C.prepareAsset('BTC', full.filter(row => row.time !== scan - B), {now: scan + 10 * DAY});
assert.equal(C.historyCheck(noLatest, scan).ok, false); assert.equal(C.historyCheck(noLatest, scan).reason, 'LATEST_5M_CANDLE_MISSING');
// One missing candle anywhere in the trailing 256h => fail closed.
const gap = C.prepareAsset('BTC', full.filter(row => row.time !== scan - 100 * 3_600_000), {now: scan + 10 * DAY});
assert.equal(C.historyCheck(gap, scan).reason, 'GAP_IN_STRICT_LOOKBACK');
// Coverage below 99.5% over the 61-day window => fail closed.
const sparse = C.prepareAsset('BTC', full.filter((row, i) => row.time >= scan - 256 * 3_600_000 || i % 50), {now: scan + 10 * DAY});
assert.equal(C.historyCheck(sparse, scan).reason, 'HISTORY_WINDOW_COVERAGE_BELOW_99_5');
// Archive preparation rejects conflicting duplicates and drops future rows.
assert.throws(() => C.prepareAsset('BTC', [...full.slice(0, 10), {...full[5], volume: full[5].volume + 1}]), /conflicting duplicate/);
assert.equal(C.prepareAsset('BTC', full, {now: scan}).rows.at(-1).time, scan - B);
// Window integrity rejects non-monotonic, future or stale windows.
assert.throws(() => C.assertWindowIntegrity([full[1], full[0]], full[2].time), /non-monotonic/);
assert.throws(() => C.assertWindowIntegrity([full[0]], full[0].time), /future/);
assert.throws(() => C.assertWindowIntegrity([full[0]], full[0].time + 3 * B), /STALE_SNAPSHOT_REJECTED/);

// Full scan: provenance is complete, hashes are deterministic, no other venue.
const assets = ['BTC', 'ETH', 'SOL'].map((asset, k) => C.prepareAsset(asset, series(start, history, 11 + k * 7, k === 1 ? -.00003 : .00003), {now: scan + 10 * DAY}));
const built = C.buildScan({timestamp: scan, assets});
assert.equal(built.skipped, undefined);
assert.deepEqual(built.snapshot.eligible_universe, ['BTC', 'ETH', 'SOL']);
assert.equal(built.snapshot.engine_version, 'HISTORICAL-RANK-V2-CLEAN');
assert.equal(C.buildScan({timestamp: scan, assets}).snapshot.snapshot_hash, built.snapshot.snapshot_hash);
for (const row of built.candidates) {
  const p = row.feature_json.provenance;
  for (const key of ['dataset_version', 'label_version', 'scan_id', 'scan_timestamp', 'asset', 'entry_source', 'entry_venue', 'entry_instrument_type', 'latest_feature_candle_timestamp', 'freshness_status']) assert.ok(p[key] !== undefined && p[key] !== null, key);
  assert.equal(p.entry_venue, 'COINBASE'); assert.equal(p.entry_instrument_type, 'SPOT'); assert.equal(p.latest_feature_candle_timestamp, scan - B);
  assert.equal(row.feature_json.sequence_compact.timeframes.m5.window_end, scan);
  assert.equal(C.expandSequence(row.feature_json.sequence_compact).timeframes.h1.rows.length, 64);
}
// An asset with a stale latest candle is excluded; the scan records why.
const mixed = C.buildScan({timestamp: scan, assets: [assets[0], C.prepareAsset('XRP', full.filter(row => row.time !== scan - B), {now: scan + 10 * DAY})]});
assert.deepEqual(mixed.snapshot.eligible_universe, ['BTC']);
assert.equal(mixed.excluded[0].asset, 'XRP'); assert.equal(mixed.excluded[0].reason, 'LATEST_5M_CANDLE_MISSING');
assert.equal(C.buildScan({timestamp: scan, assets: [noLatest]}).skipped, true);

// Strict outcomes.
const outcomeCandles = (bars, shape) => Array.from({length: bars}, (_, k) => ({time: scan + k * B, ...shape(k)}));
const withOutcome = candles => C.prepareAsset('BTC', [...full.filter(row => row.time < scan), ...candles], {now: scan + 10 * DAY});
const long = {timestamp: scan, valid_current_geometry: true, direction: 'long', stop: 99, rr: 1.8};
// Stop and TP1 in the same candle => stop first.
const both = C.resolveStrict(long, withOutcome(outcomeCandles(288, k => k === 3 ? {open: 100, high: 103, low: 98, close: 100, volume: 1} : {open: 100, high: 100.2, low: 99.8, close: 100, volume: 1})));
assert.equal(both.status, 'RESOLVED'); assert.equal(both.STOP_HIT, true); assert.equal(both.TP1_BEFORE_SL, false); assert.equal(both.exit_reason, 'STOP'); assert.ok(both.FINAL_R < -1);
// TP1 candle that also touches breakeven => exit the rest at breakeven.
const be = C.resolveStrict(long, withOutcome(outcomeCandles(288, k => k === 3 ? {open: 100.6, high: 104, low: 100.4, close: 101, volume: 1} : {open: 100.5, high: 100.6, low: 100.4, close: 100.5, volume: 1})));
assert.equal(be.exit_reason, 'BREAKEVEN_SAME_CANDLE_AS_TP1'); assert.equal(be.TP1_BEFORE_SL, true);
// A missing candle before exit => unresolved, never a manufactured timeout.
const holed = outcomeCandles(288, () => ({open: 100, high: 100.2, low: 99.8, close: 100, volume: 1})).filter((_, k) => k !== 150);
const missing = C.resolveStrict(long, withOutcome(holed));
assert.equal(missing.status, 'UNRESOLVED_DATA_GAP'); assert.equal(missing.reason, 'OUTCOME_CANDLE_MISSING');
assert.equal(C.resolveStrict(long, withOutcome([])).reason, 'ENTRY_CANDLE_MISSING');
// A gap AFTER the exit does not matter.
const stoppedEarly = outcomeCandles(288, k => k === 2 ? {open: 100, high: 100.1, low: 98, close: 99, volume: 1} : {open: 100, high: 100.2, low: 99.8, close: 100, volume: 1}).filter((_, k) => k !== 200);
assert.equal(C.resolveStrict(long, withOutcome(stoppedEarly)).status, 'RESOLVED');
// Full timeout carries provenance and label version.
const flat = C.resolveStrict(long, withOutcome(outcomeCandles(288, () => ({open: 100, high: 100.2, low: 99.8, close: 100, volume: 1}))));
assert.equal(flat.exit_reason, 'TIMEOUT'); assert.equal(flat.duration_bars, 288); assert.equal(flat.outcome_venue, 'COINBASE'); assert.equal(flat.label_version, 'outcome-strict-v1'); assert.equal(flat.entry_price, 100);
console.log('V2-CLEAN generator integrity tests passed');
