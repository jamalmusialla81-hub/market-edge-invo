'use strict';
const assert = require('node:assert/strict');
const V2 = require('./rank-research-v2.js');

function rng(seed) { let state = seed >>> 0; return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const random = rng(42), gauss = () => (random() + random() + random() + random() - 2) * 1.2;
const DAY = 86_400_000, start = Date.UTC(2024, 10, 1);
function sequence(timestamp, drift) {
  const frame = interval => ({available: true, window_end: timestamp, rows: Array.from({length: 128}, (_, i) => ({time: timestamp - (128 - i) * interval, close_to_close: drift / 1000 + gauss() / 1000, high_low: .004 + random() * .002, relative_volume: .6 + random(), atr_normalized_move: drift + gauss() * .3, rolling_volatility: .002, upper_wick: random(), lower_wick: random(), distance_recent_high: -random() * .02, distance_recent_low: random() * .02}))});
  return {timeframes: {m5: frame(300_000), m15: frame(900_000), h1: frame(3_600_000)}};
}
// A planted, direction-aware pre-entry signal: signed h1 momentum predicts the
// within-scan outcome.  Quant score is pure noise with respect to outcomes.
function synthetic(scans = 220) {
  const rows = [];
  for (let k = 0; k < scans; k++) {
    const timestamp = start + k * DAY, count = 1 + Math.floor(random() * 4);
    for (let c = 0; c < count; c++) {
      const direction = random() > .5 ? 'long' : 'short', s = direction === 'long' ? 1 : -1, roc = gauss() * 2, entry = 100, stop = direction === 'long' ? 99 : 101, edge = s * roc;
      const finalR = .35 * edge + gauss() * .5 - .1;
      rows.push({candidate_id: `c-${k}-${c}`, scan_id: `scan-${k}`, scan_timestamp: timestamp, asset: ['BTC', 'ETH', 'SOL'][c % 3], direction, strategy: 'TREND CONTINUATION', entry, stop, rr: 1.8, quant_score: 60 + Math.floor(random() * 30), candidate_rank: c + 1, regime: 'RANGE', valid_current_geometry: 1,
        feature_json: JSON.stringify({m5: {rsi: 50, roc5: 0, atr: 1, relativeVolume: 1}, m15: {rsi: 50, roc5: 0, atr: 1, relativeVolume: 1}, h1: {rsi: 50 + roc * 3, roc5: roc, atr: 1, ema20: 100, ema50: 100, support: 98, resistance: 102, trend: 'neutral'}, h4: {rsi: 50, roc5: 0, atr: 2}, d1: {atr: 4}, objective: {frames: {}}}),
        targets_json: JSON.stringify({status: 'RESOLVED', FINAL_R: finalR, TP1_BEFORE_SL: finalR > .5, STOP_HIT: finalR < -.8, MFE: Math.max(0, finalR + .3), MAE: Math.min(0, finalR - .3), duration_bars: 100}),
        sequence_json: JSON.stringify(sequence(timestamp, roc * .1))});
    }
  }
  return rows;
}

// Holdout isolation: rows at or after the development cutoff never survive parsing.
const holdoutRow = {...synthetic(1)[0], scan_timestamp: V2.HOLDOUT.startMs + DAY, scan_id: 'late', candidate_id: 'late'};
const embargoRow = {...synthetic(1)[0], scan_timestamp: V2.HOLDOUT.devCutoffMs, scan_id: 'edge', candidate_id: 'edge'};
const parsedHoldout = V2.parseRows([holdoutRow, embargoRow]);
assert.equal(parsedHoldout.rows.length, 0);
assert.equal(parsedHoldout.excludedHoldoutOrEmbargo, 2);
assert.ok(V2.HOLDOUT.devCutoffMs + V2.OUTCOME_HORIZON_MS + V2.EMBARGO_MS <= V2.HOLDOUT.startMs);
assert.throws(() => V2.consumeHoldout({registry: {has: () => false, add: () => {}}, modelSpec: {name: 'x', families: []}}), /HOLDOUT_SEALED/);
const consumed = new Map(), registry = {has: id => consumed.has(id), add: (id, value) => consumed.set(id, value)};
V2.consumeHoldout({registry, modelSpec: {name: 'WITHIN_SCAN_RIDGE', families: ['MOMENTUM']}, confirm: 'CONSUME_SEALED_HOLDOUT_ONCE'});
assert.throws(() => V2.consumeHoldout({registry, modelSpec: {name: 'WITHIN_SCAN_RIDGE', families: ['MOMENTUM']}, confirm: 'CONSUME_SEALED_HOLDOUT_ONCE'}), /HOLDOUT_ALREADY_CONSUMED/);

// Leakage guard rejects any outcome-derived feature name.
assert.throws(() => V2.assertPreEntryFeatureNames({BASE: {finalR: 1}}), /LEAKAGE_REJECTED/);
assert.throws(() => V2.assertPreEntryFeatureNames({BASE: {mfeRatio: 1}}), /LEAKAGE_REJECTED/);

// Features are direction-aware: mirrored long/short with mirrored momentum agree.
const {rows} = V2.parseRows(synthetic(220));
const long = rows.find(row => row.direction === 'long'), mirrored = {...long, direction: 'short', features: {...long.features, h1: {...long.features.h1, roc5: -long.features.h1.roc5, rsi: 100 - long.features.h1.rsi}}};
assert.ok(Math.abs(V2.extractFeatures(long).MOMENTUM.h1Roc5Dir - V2.extractFeatures(mirrored).MOMENTUM.h1Roc5Dir) < 1e-12);
assert.ok(Math.abs(V2.extractFeatures(long).MOMENTUM.h1RsiDir - V2.extractFeatures(mirrored).MOMENTUM.h1RsiDir) < 1e-12);

// Cost conversion: FINAL_R is already net of 0.16%; 1% stop => 0.08% extra = -0.08R.
assert.ok(Math.abs(V2.costR({entry: 100, stop: 99, targets: {FINAL_R: .5}}, .0024) - .42) < 1e-9);

// Ties share the pick: an all-tied model earns the exact scan mean (random expectation).
const tieRows = [{scan_id: 'a', timestamp: 1, candidate_id: '1', entry: 100, stop: 99, targets: {FINAL_R: 1}}, {scan_id: 'a', timestamp: 1, candidate_id: '2', entry: 100, stop: 99, targets: {FINAL_R: -1}}];
assert.equal(V2.picks(tieRows, [0, 0])[0].r, 0);
assert.equal(V2.picks(tieRows, [1, 0])[0].r, 1);

// Walk-forward folds are chronological, purged, and embargoed.
const groups = V2.groupByScan(rows), folds = V2.walkForwardFolds(groups, {folds: 5});
assert.equal(folds.length, 5);
for (const fold of folds) {
  assert.ok(fold.train.every(group => group[0].timestamp + V2.OUTCOME_HORIZON_MS + V2.EMBARGO_MS <= fold.testStartMs));
  assert.ok(fold.purged >= 11, 'daily cadence with a 256h embargo purges at least 11 scans');
}
const inner = V2.innerSplit(groups.slice(0, 100));
assert.ok(inner.fit.at(-1)[0].timestamp + V2.OUTCOME_HORIZON_MS + V2.EMBARGO_MS <= inner.validation[0][0].timestamp);

// Bootstrap is deterministic.
assert.deepEqual(V2.blockBootstrap([1, -1, .5, .2, -.3, .8, .1, -.2]), V2.blockBootstrap([1, -1, .5, .2, -.3, .8, .1, -.2]));

// The suite recovers the planted signal out of sample and Quant does not.
const features = V2.featureTable(rows, {});
const run = V2.walkForward(rows, features, {models: ['RANDOM', 'CURRENT_QUANT', 'WITHIN_SCAN_RIDGE', 'LAMBDARANK_GBM_FINAL_R', 'RIDGE_FINAL_R', 'LOGISTIC_TP1', 'GBM_FINAL_R'], folds: 4});
const evaluate = name => V2.evaluateOos(run.models[name], run.models.CURRENT_QUANT, run.models.RANDOM);
const ridge = evaluate('WITHIN_SCAN_RIDGE'), quant = evaluate('CURRENT_QUANT'), randomPick = evaluate('RANDOM'), lambda = evaluate('LAMBDARANK_GBM_FINAL_R');
assert.ok(ridge.atCosts['0.16%'].meanR > randomPick.atCosts['0.16%'].meanR + .1, 'within-scan ridge must find the planted signal');
assert.ok(lambda.atCosts['0.16%'].meanR > randomPick.atCosts['0.16%'].meanR + .05, 'lambdarank must find the planted signal');
assert.ok(ridge.monotonicity.weightedPairAccuracy > .6);
assert.ok(Math.abs(quant.monotonicity.weightedPairAccuracy - .5) < .1, 'noise quant score is near chance');
assert.ok(ridge.rankBuckets['#1'].meanR > ridge.rankBuckets['#2-5'].meanR);
assert.ok(ridge.vsRandom016.ci95.low > 0);
assert.equal(typeof V2.acceptance(ridge).verdict, 'string');
// The conv model sees direction-signed sequences and must also beat random on this planted drift.
const convRun = V2.walkForward(rows, features, {models: ['RANDOM', 'CURRENT_QUANT', 'CONV1D_MTF'], folds: 3});
const conv = V2.evaluateOos(convRun.models.CONV1D_MTF, convRun.models.CURRENT_QUANT, convRun.models.RANDOM);
assert.ok(conv.monotonicity.weightedPairAccuracy > .55, `conv pair accuracy ${conv.monotonicity.weightedPairAccuracy}`);

const audit = V2.datasetAudit(rows);
assert.equal(audit.scanGroups, 220);
assert.ok(audit.choiceScanGroups < audit.scanGroups);
console.log('rank-research-v2 tests passed');
