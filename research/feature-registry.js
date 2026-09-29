'use strict';

// Feature registry V1 (DATA 4). A DATA FILE that documents the features that
// exist today: it does not compute anything and is not imported by the scan,
// the Quant engine or the paper engine. Adding a feature here does not add
// it to any model; changing a calculation elsewhere without updating this
// file fails research/feature-registry.test.js.
//
// Every entry is DECISION_TIME: knowable at the scan's decision time from
// completed candles and venue context. Hindsight fields are listed
// separately (HINDSIGHT_FIELDS) so the registry and shadow-leakage-guard.js
// can be cross-checked in both directions.
//
// Missing-data behaviour uses the DATA 2 vocabulary where a row is affected;
// a missing INPUT never makes a feature a fabricated number.
//   FRAME_OMITTED      the whole timeframe block is absent (fewer than 30 completed candles)
//   NULL               the field is present and null
//   ZERO_FILLED        the producer substitutes 0 (a WEAKNESS of the legacy vector; trainers must treat 0 as "unknown" or drop the row)
//   OBJECT_NULL        the whole derivatives block is null (no venue context for the asset)

const crypto = require('node:crypto');

const FEATURE_SET_VERSION = 'FEATURE-SET-V2';
const SHADOW_FEATURE_VERSION = 'shadow-features-v2';   // signal-bridge/shadow_capture.mjs FEATURE_VERSION this registry documents

const CALC = Object.freeze({
  legacy: { file: 'backend/scan-core.mjs', function: 'features' },
  frame: { file: 'signal-bridge/shadow_capture.mjs', function: 'frameFeatures' },
  deriv: { file: 'signal-bridge/shadow_capture.mjs', function: 'derivatives' },
  cross: { file: 'signal-bridge/shadow_capture.mjs', function: 'crossMarket' },
});

const ALLOWED = Object.freeze({
  legacy: ['LEGACY_ML_WEIGHTING', 'SHADOW_CHALLENGER', 'RESEARCH'],
  shadow: ['SHADOW_CHALLENGER', 'RESEARCH'],
});

function entry(o) {
  return Object.freeze({
    version: 1, classification: 'DECISION_TIME', point_in_time: true, provenance: 'HYPERLIQUID',
    ...o,
    range: Object.freeze([...o.range]), source_fields: Object.freeze([...o.source_fields]), allowed_use: Object.freeze([...o.allowed_use]),
  });
}

// ---- A. the legacy ML feature vector: backend/scan-core.mjs features(candidate) --------------------------
// Inputs are the production candidate (strategy label, regime, H4 and M15 frame values). Producer zero-fills
// missing frame values (`?? 0`).
const legacy = [];
const L = (name, group, source, range, calc_note, missing = 'ZERO_FILLED', timeframe = 'candidate') =>
  legacy.push(entry({ name, path: `legacy.${name}`, group, calc: CALC.legacy, source_fields: source, range, calc_note, missing, timeframe,
    lookback: 'per production candidate', allowed_use: ALLOWED.legacy }));
L('quality', 'legacy_candidate', ['candidate.setupQuality|quality'], [0, 1], 'setup quality / 100', 'ZERO_FILLED');
L('rr', 'legacy_candidate', ['candidate.rr1|rr'], [0, 20], 'reward:risk to TP1', 'ZERO_FILLED');
L('long', 'legacy_candidate', ['candidate.direction'], [0, 1], '1 if long else 0', 'ZERO_FILLED');
for (const [name, label] of [['trendContinuation', 'TREND CONTINUATION'], ['breakout', 'BREAKOUT + RETEST'], ['momentum', 'MOMENTUM CONTINUATION'],
  ['meanReversion', 'MEAN REVERSION'], ['liquiditySweep', 'LIQUIDITY-SWEEP REVERSAL']]) {
  L(name, 'legacy_strategy_flag', ['candidate.strategy'], [0, 1], `1 if strategy === '${label}'`, 'ZERO_FILLED');
}
for (const [name, rx] of [['regimeTrend', '/UPTREND|DOWNTREND/'], ['regimeRange', '/RANGE/'], ['regimeBreakout', '/BREAKOUT/'], ['regimeCompression', "=== 'COMPRESSION'"]]) {
  L(name, 'legacy_regime_flag', ['candidate.regime'], [0, 1], `1 if regime matches ${rx}`, 'ZERO_FILLED');
}
L('h4Rsi', 'legacy_frame', ['candidate.frame.rsi'], [0, 1], 'H4 RSI / 100', 'ZERO_FILLED', '4h');
L('h4Roc5', 'legacy_frame', ['candidate.frame.roc5'], [-1, 5], 'H4 5-bar rate of change', 'ZERO_FILLED', '4h');
L('h4RelativeVolume', 'legacy_frame', ['candidate.frame.relativeVolume'], [0, 50], 'H4 relative volume', 'ZERO_FILLED', '4h');
L('m15Rsi', 'legacy_frame', ['candidate.timeframes.m15.rsi'], [0, 1], 'M15 RSI / 100', 'ZERO_FILLED', '15m');
L('m15RelativeVolume', 'legacy_frame', ['candidate.timeframes.m15.relativeVolume'], [0, 50], 'M15 relative volume', 'ZERO_FILLED', '15m');

// ---- B. shadow point-in-time features: decision.features.<tf>.<name> ---------------------------------------
const FRAMES = [['m5', '5m'], ['m15', '15m'], ['h1', '1h'], ['h4', '4h'], ['d1', '1d']];
const FRAME_FIELDS = [
  ['last_close', 'close of the last completed candle', [0, 1e9], 'last close', 1],
  ['last_bar_time', 'open time (ms) of the last completed candle', [0, 4e12], 'last bar time', 1],
  ['ret_1', 'return over 1 bar', [-1, 10], 'last.close / close[n-1-1] - 1', 2],
  ['ret_6', 'return over 6 bars', [-1, 10], 'last.close / close[n-1-6] - 1', 7],
  ['ret_24', 'return over 24 bars', [-1, 10], 'last.close / close[n-1-24] - 1', 25],
  ['atr', 'average true range, 14 bars', [0, 1e9], 'mean of the last 14 true ranges', 15],
  ['atr_pct', 'ATR as a fraction of the last close', [0, 5], 'atr / last.close', 15],
  ['rsi', 'RSI, 14 bars (simple mean of gains / losses)', [0, 100], '100 - 100 / (1 + mean gain / mean loss)', 15],
  ['vol_20', 'stdev of 20 log returns', [0, 2], 'stdev of the last 20 log returns', 21],
  ['range_pos_20', 'position of the close inside the 20-bar high-low range', [0, 1], '(close - low20) / (high20 - low20); 0.5 if flat', 20],
  ['ema20_dist', 'distance of the close from EMA20', [-1, 5], 'last.close / EMA20 - 1', 120],
  ['ema50_dist', 'distance of the close from EMA50', [-1, 5], 'last.close / EMA50 - 1', 200],
  ['rel_volume', 'last volume relative to the mean of the previous 20', [0, 100], 'last.volume / mean(volume[-21:-1]); null if no volume', 21],
];
const frames = [];
for (const [key, tf] of FRAMES) {
  for (const [name, what, range, calc, lookback] of FRAME_FIELDS) {
    frames.push(entry({ name: `${key}.${name}`, path: `features.${key}.${name}`, group: 'shadow_frame', calc: CALC.frame, source_fields: [`completed ${tf} candles`],
      range, calc_note: `${what}: ${calc}`, missing: 'FRAME_OMITTED', timeframe: tf, lookback: `${lookback} completed candles (block needs >= 30)`, allowed_use: ALLOWED.shadow }));
  }
}

const derivs = [];
for (const [name, src, range] of [['funding', 'funding', [-0.05, 0.05]], ['open_interest', 'openInterest', [0, 1e13]], ['premium', 'premium', [-0.2, 0.2]],
  ['day_notional_volume', 'dayNtlVlm', [0, 1e13]], ['mark_px', 'markPx', [0, 1e9]], ['oracle_px', 'oraclePx', [0, 1e9]], ['prev_day_px', 'prevDayPx', [0, 1e9]]]) {
  derivs.push(entry({ name, path: `derivatives.${name}`, group: 'shadow_derivatives', calc: CALC.deriv, source_fields: [`metaAndAssetCtxs.${src}`], range,
    calc_note: `venue asset context field ${src}, rounded to 6 significant digits`, missing: 'OBJECT_NULL', timeframe: 'snapshot', lookback: 'snapshot at decision time', allowed_use: ALLOWED.shadow }));
}
// DATA 14 (added in FEATURE-SET-V2): basis against the venue's own oracle. NULL when an input is missing; never estimated.
// Per-value provenance is captured beside the block as derivatives_provenance. No claim that these carry edge.
for (const [name, formula, src, range] of [['basis_mark_oracle', 'markPx / oraclePx - 1', ['metaAndAssetCtxs.markPx', 'metaAndAssetCtxs.oraclePx'], [-0.2, 0.2]],
  ['basis_mid_oracle', 'midPx / oraclePx - 1', ['metaAndAssetCtxs.midPx', 'metaAndAssetCtxs.oraclePx'], [-0.2, 0.2]]]) {
  derivs.push(entry({ name, path: `derivatives.${name}`, group: 'shadow_derivatives', calc: CALC.deriv, source_fields: src, range,
    calc_note: `${formula}, rounded to 6 significant digits; same venue, same snapshot`, missing: 'NULL', timeframe: 'snapshot', lookback: 'snapshot at decision time', allowed_use: ALLOWED.shadow }));
}

const cross = [];
for (const [name, range, calc, extra] of [
  ['markets', [0, 500], 'number of markets in the scan'],
  ['breadth_h1_up', [0, 1], 'fraction of markets with h1.ret_1 > 0'], ['breadth_h4_up', [0, 1], 'fraction of markets with h4.ret_1 > 0'],
  ['median_h1_ret_1', [-1, 1], 'median h1.ret_1'], ['median_h4_ret_1', [-1, 1], 'median h4.ret_1'], ['median_h1_vol_20', [0, 2], 'median h1.vol_20'],
  ['btc.h1_ret_1', [-1, 1], 'BTC h1.ret_1'], ['btc.h4_ret_1', [-1, 1], 'BTC h4.ret_1'], ['btc.d1_ret_1', [-1, 1], 'BTC d1.ret_1'],
  ['btc.h1_vol_20', [0, 2], 'BTC h1.vol_20'], ['btc.h4_rsi', [0, 100], 'BTC h4.rsi'],
]) {
  cross.push(entry({ name: `cross.${name}`, path: `cross_market.${name}`, group: 'shadow_cross_market', calc: CALC.cross, source_fields: ['every market\'s point-in-time frame features in the same scan'],
    range, calc_note: calc, missing: 'NULL', timeframe: name.includes('h4') ? '4h' : name.includes('d1') ? '1d' : '1h', lookback: 'same scan, cross-sectional', allowed_use: ALLOWED.shadow }));
}

const FEATURES = Object.freeze([...legacy, ...frames, ...derivs, ...cross]);

// Fields that describe the future. They are NOT features; the registry lists them so the guard and the registry
// can be checked against each other. shadow-leakage-guard.js must flag every one of these.
const HINDSIGHT_FIELDS = Object.freeze([
  'mfe', 'mae', 'mfe_r', 'mae_r', 'optimal_entry', 'optimal_tp1', 'optimal_tp2', 'optimal_exit', 'realized_pnl', 'realised_r', 'policy_r',
  'classification', 'outcome_label', 'hindsight_best_direction', 'best_achievable_r', 'time_to_tp1', 'tp1_hit', 'first_touch', 'future_return',
  'giveback_r', 'counterfactual_R', 'counterfactual_exit_price',
]);

// Execution-quality fields exist only after the fill (DATA 1). Also not features.
const OUTCOME_EVENT_FIELDS = Object.freeze(['execution_quality', 'latency_to_fill_ms', 'stop_overshoot', 'entry_slippage_cost', 'exit_fills', 'fees']);

function byName() { return new Map(FEATURES.map((f) => [f.path, f])); }
function get(path) { return byName().get(path) || null; }
function featureSet(paths) {
  const map = byName();
  const unknown = [...paths].filter((p) => !map.has(p));
  if (unknown.length) throw new Error(`UNREGISTERED_FEATURES: ${unknown.join(', ')}`);
  return { feature_set_version: FEATURE_SET_VERSION, features: [...paths].map((p) => map.get(p)) };
}
// Content hash of the registry: pinned by the test, so an entry cannot change without a FEATURE_SET_VERSION bump.
function registryHash() {
  return crypto.createHash('sha256').update(JSON.stringify({ v: FEATURE_SET_VERSION, f: FEATURES, h: HINDSIGHT_FIELDS, o: OUTCOME_EVENT_FIELDS })).digest('hex');
}

module.exports = { FEATURE_SET_VERSION, SHADOW_FEATURE_VERSION, FEATURES, HINDSIGHT_FIELDS, OUTCOME_EVENT_FIELDS, get, featureSet, registryHash };
