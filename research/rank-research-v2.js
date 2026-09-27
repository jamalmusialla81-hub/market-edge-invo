'use strict';

// Research-only rank suite (V2).  It reads frozen historical rank candidates,
// never mutates signal-side state, never writes to D1 or the Worker, and has no
// path into the live scanner, Best Trade Now, Take Trade, journal, or execution.
//
// Scientific rules enforced here:
// - A fixed-date sealed holdout.  Development code filters it out before any
//   feature, model, or metric is computed; consumeHoldout() is the only door.
// - Chronological expanding walk-forward with purge (outcome horizon) and
//   embargo between every training window and the following test block.
// - Hyper-parameters are chosen on an inner, chronologically later slice of
//   the training window only.  Test blocks are never used for tuning.
// - Effective sample size is counted in scan groups, and ranking evidence only
//   in scans that actually contain a choice (>= 2 resolved candidates).
// - Confidence intervals use a moving-block bootstrap over scan groups.
// - Every engineered feature is pre-entry and direction-aware.

const VERSION = 'rank-research-v2';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const OUTCOME_HORIZON_MS = 288 * 300_000;          // historical-rank.js OUTCOME_BARS x 5m
const EMBARGO_MS = 256 * HOUR_MS;                  // longest frozen h1 sequence lookback
const COSTS = Object.freeze([.0008, .0016, .0025, .004]);
const BASE_COST = .0016;                           // FINAL_R is already net of this
// Sealed holdout.  Every Phase 5 scan at or after this timestamp is untouched
// research data: it has not been generated at the time this was fixed
// (the dataset ended 2025-08-17), so it has never been seen by any model.
const HOLDOUT = Object.freeze({
  id: 'PHASE5-V1-HOLDOUT-2025-12-01',
  startMs: Date.UTC(2025, 11, 1),
  // A development label must fully resolve, plus the embargo, before the
  // holdout starts: no development label or feature window can touch it.
  devCutoffMs: Date.UTC(2025, 11, 1) - EMBARGO_MS - OUTCOME_HORIZON_MS,
  rule: 'scan_timestamp >= startMs is holdout; development uses scan_timestamp < devCutoffMs only; consumption is one-shot with a pre-registered model hash'
});
const FAMILIES = Object.freeze(['BASE', 'SETUP', 'STRUCTURE', 'VOLATILITY', 'MOMENTUM', 'LIQUIDITY', 'REGIME', 'CROSS_MARKET', 'DERIVATIVES']);
const STRATEGIES = Object.freeze(['TREND CONTINUATION', 'BREAKOUT + RETEST', 'MOMENTUM CONTINUATION', 'MEAN REVERSION', 'LIQUIDITY-SWEEP REVERSAL']);
const LEAK_PATTERN = /outcome|target_|label|future|final_?r|mfe|mae|tp1_?hit|tp2|stop_?hit|pnl|duration|resolved/i;

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const mean = values => { const list = values.filter(Number.isFinite); return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null; };
const sum = values => values.reduce((total, value) => total + value, 0);
const std = values => { const centre = mean(values); const list = values.filter(Number.isFinite); return list.length > 1 ? Math.sqrt(mean(list.map(value => (value - centre) ** 2))) : null; };
function median(values) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null; }
function quantile(values, q) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const position = (sorted.length - 1) * q, low = Math.floor(position), high = Math.ceil(position); return sorted[low] + (sorted[high] - sorted[low]) * (position - low); }
const parse = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch { return {}; } };
const clip = (value, low, high) => Math.max(low, Math.min(high, value));
function rng(seed) { let state = seed >>> 0; return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hashString(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); }

// ---------------------------------------------------------------- dataset --
function sequenceSafe(row) {
  const frames = row.sequence?.timeframes || {};
  return ['m5', 'm15', 'h1'].every(name => { const frame = frames[name]; return frame?.available === true && Array.isArray(frame.rows) && frame.rows.length >= 128 && Number.isFinite(Number(frame.window_end)) && Number(frame.window_end) <= row.timestamp; });
}
// Development rows only.  Holdout rows are rejected here even if a loader
// accidentally returned them, so no downstream code can see them.
function parseRows(rows, {cutoffMs = HOLDOUT.devCutoffMs} = {}) {
  const parsed = rows.map(row => ({...row, timestamp: Number(row.scan_timestamp ?? row.timestamp), entry: finite(row.entry), stop: finite(row.stop), quant_score: finite(row.quant_score) ?? 0, candidate_rank: finite(row.candidate_rank), rr: finite(row.rr) ?? 0, targets: parse(row.targets_json ?? row.targets), sequence: parse(row.sequence_json ?? row.sequence), features: parse(row.feature_json ?? row.features)}));
  const leaked = parsed.filter(row => row.timestamp >= cutoffMs);
  const kept = parsed.filter(row => row.timestamp < cutoffMs && Number(row.valid_current_geometry) === 1 && row.targets.status === 'RESOLVED' && Number.isFinite(finite(row.targets.FINAL_R)) && row.entry > 0 && row.stop > 0 && sequenceSafe(row))
    .sort((a, b) => a.timestamp - b.timestamp || String(a.candidate_id).localeCompare(String(b.candidate_id)));
  return {rows: kept, excludedHoldoutOrEmbargo: leaked.length, droppedOther: parsed.length - leaked.length - kept.length};
}
function groupByScan(rows) { return Object.values(Object.groupBy(rows, row => row.scan_id)).sort((left, right) => left[0].timestamp - right[0].timestamp || String(left[0].scan_id).localeCompare(String(right[0].scan_id))); }
const stopFraction = row => Math.max(Math.abs(row.entry - row.stop) / row.entry, 1e-6);
// FINAL_R already contains the 0.16% round trip.  Other cost levels shift it by
// the extra cost expressed in the trade's own risk unit.
function costR(row, cost = BASE_COST) { return finite(row.targets.FINAL_R) - (cost - BASE_COST) / stopFraction(row); }

// ---------------------------------------------------------------- features --
const dirSign = row => row.direction === 'long' ? 1 : -1;
const trendValue = value => { const text = String(value ?? '').toUpperCase(); return /^(UP|LONG|BULL)/.test(text) ? 1 : /^(DOWN|SHORT|BEAR)/.test(text) ? -1 : 0; };
const volLevel = value => ({LOW: -1, NORMAL: 0, HIGH: 1})[String(value ?? '').toUpperCase()] ?? 0;
function seqRows(row, frame) { return row.sequence?.timeframes?.[frame]?.rows || []; }
function seqChannel(rows, key, count, offset = 0) { const end = rows.length - offset; return rows.slice(Math.max(0, end - count), end).map(item => finite(item?.[key])).filter(Number.isFinite); }
const ratio = (top, bottom) => Number.isFinite(top) && Number.isFinite(bottom) && Math.abs(bottom) > 1e-12 ? top / bottom : null;

// context: {crossMarket: {BTC: [{closeTime, close}], ...}, funding: {BTC: [{time, rate}], ...}}
function extractFeatures(row, context = {}) {
  const s = dirSign(row), f = row.features || {}, obj = f.objective?.frames || {}, price = row.entry;
  const frame = name => f[name] || {};
  const atr = name => finite(frame(name).atr);
  const out = {BASE: {}, SETUP: {}, STRUCTURE: {}, VOLATILITY: {}, MOMENTUM: {}, LIQUIDITY: {}, REGIME: {}, CROSS_MARKET: {}, DERIVATIVES: {}};
  // BASE reproduces the existing V0/V1 numeric vector (direction-blind by design).
  Object.assign(out.BASE, {quality: row.quant_score / 100, long: s > 0 ? 1 : 0, m5Rsi: finite(frame('m5').rsi), m5Roc: finite(frame('m5').roc5), m15Rsi: finite(frame('m15').rsi), m15Roc: finite(frame('m15').roc5), h1Rsi: finite(frame('h1').rsi), h1Roc: finite(frame('h1').roc5), h4Rsi: finite(frame('h4').rsi), h4Roc: finite(frame('h4').roc5), m15RelVol: finite(frame('m15').relativeVolume)});
  for (const strategy of STRATEGIES) out.SETUP[`strategy_${strategy.replace(/[^A-Z]+/g, '_')}`] = row.strategy === strategy ? 1 : 0;
  out.SETUP.quantRankPosition = Number.isFinite(row.candidate_rank) ? 1 / row.candidate_rank : null;

  // STRUCTURE: trend alignment, swing structure, distance from structural levels.
  const frames = ['m5', 'm15', 'h1', 'h4', 'd1'];
  out.STRUCTURE.trendAlignQuant = sum(frames.map(name => trendValue(frame(name).trend) * s));
  out.STRUCTURE.trendAlignObjective = sum(frames.map(name => trendValue(obj[name]?.structure?.trend) * s));
  for (const name of ['h1', 'h4', 'd1']) {
    const a = atr(name), ema20 = finite(frame(name).ema20), ema50 = finite(frame(name).ema50), support = finite(frame(name).support), resistance = finite(frame(name).resistance);
    out.STRUCTURE[`${name}PriceVsEma20Atr`] = a ? s * (price - ema20) / a : null;
    out.STRUCTURE[`${name}Ema20VsEma50Atr`] = a ? s * (ema20 - ema50) / a : null;
    if (name !== 'd1') {
      out.STRUCTURE[`${name}RoomBehindAtr`] = a ? (s > 0 ? price - support : resistance - price) / a : null;
      out.STRUCTURE[`${name}RoomAheadAtr`] = a ? (s > 0 ? resistance - price : price - support) / a : null;
    }
    const position = finite(obj[name]?.equilibrium?.rangePosition);
    out.STRUCTURE[`${name}RangePositionDir`] = position === null ? null : (s > 0 ? 1 - position : position);
  }
  for (const name of ['m15', 'h1', 'h4']) {
    out.STRUCTURE[`${name}BosAlign`] = trendValue(obj[name]?.structure?.bos) * s;
    out.STRUCTURE[`${name}ChochAlign`] = trendValue(obj[name]?.structure?.choch) * s;
  }
  out.STRUCTURE.h1DisplacementAtr = finite(obj.h1?.structure?.displacementAtr);
  const h1Seq = seqRows(row, 'h1'), m15Seq = seqRows(row, 'm15'), m5Seq = seqRows(row, 'm5');
  const lastH1 = h1Seq.at(-1) || {};
  out.STRUCTURE.h1BreakoutProximity = s > 0 ? finite(lastH1.distance_recent_high) : (finite(lastH1.distance_recent_low) === null ? null : -finite(lastH1.distance_recent_low));

  // VOLATILITY: ATR-normalised risk, realised volatility, regime, range expansion.
  out.VOLATILITY.stopPct = stopFraction(row) * 100;
  out.VOLATILITY.stopAtrH1 = atr('h1') ? Math.abs(row.entry - row.stop) / atr('h1') : null;
  for (const name of ['h1', 'h4', 'd1']) { out.VOLATILITY[`${name}AtrPct`] = finite(obj[name]?.momentum?.atrPct); out.VOLATILITY[`${name}VolExpansion`] = finite(obj[name]?.momentum?.volatilityExpansion); }
  out.VOLATILITY.h1RealizedVol = finite(obj.h1?.momentum?.realizedVolatility);
  for (const [name, rows] of [['m5', m5Seq], ['m15', m15Seq], ['h1', h1Seq]]) {
    out.VOLATILITY[`${name}RangeExpansion`] = ratio(mean(seqChannel(rows, 'high_low', 8)), mean(seqChannel(rows, 'high_low', 128)));
    out.VOLATILITY[`${name}RvRatio`] = ratio(finite(rows.at(-1)?.rolling_volatility), mean(seqChannel(rows, 'rolling_volatility', 128)));
  }

  // MOMENTUM: direction-signed multi-timeframe returns, RSI, acceleration.
  for (const name of ['m5', 'm15', 'h1', 'h4']) {
    const rsi = finite(frame(name).rsi), roc = finite(frame(name).roc5);
    out.MOMENTUM[`${name}RsiDir`] = rsi === null ? null : s * (rsi - 50) / 50;
    out.MOMENTUM[`${name}Roc5Dir`] = roc === null ? null : s * roc;
  }
  for (const name of ['h1', 'h4', 'd1']) { const roc20 = finite(obj[name]?.momentum?.roc20); out.MOMENTUM[`${name}Roc20Dir`] = roc20 === null ? null : s * roc20; }
  for (const bars of [4, 24, 72, 256]) out.MOMENTUM[`h1Ret${bars}Dir`] = h1Seq.length >= bars ? s * sum(seqChannel(h1Seq, 'close_to_close', bars)) * 100 : null;
  out.MOMENTUM.m5Ret12Dir = s * sum(seqChannel(m5Seq, 'close_to_close', 12)) * 100;
  for (const [name, rows] of [['m15', m15Seq], ['h1', h1Seq]]) out.MOMENTUM[`${name}AccelDir`] = s * (sum(seqChannel(rows, 'close_to_close', 8)) - sum(seqChannel(rows, 'close_to_close', 8, 8))) * 100;

  // LIQUIDITY: volume vs baseline, volume acceleration, spread/range proxy, wicks, known liquidity.
  for (const name of ['m5', 'm15', 'h1']) out.LIQUIDITY[`${name}RelVol`] = finite(frame(name).relativeVolume);
  for (const [name, rows] of [['m5', m5Seq], ['m15', m15Seq]]) out.LIQUIDITY[`${name}VolumeAccel`] = ratio(mean(seqChannel(rows, 'relative_volume', 6)), mean(seqChannel(rows, 'relative_volume', 64)));
  out.LIQUIDITY.m5RangeProxyVsH1Atr = atr('h1') ? ratio(median(seqChannel(m5Seq, 'high_low', 64)), atr('h1') / price) : null;
  const upper = mean(seqChannel(m5Seq, 'upper_wick', 12)), lower = mean(seqChannel(m5Seq, 'lower_wick', 12));
  out.LIQUIDITY.m5RejectionWickDir = upper === null || lower === null ? null : s * (lower - upper);
  out.LIQUIDITY.h1DistanceToLiquidityAtr = atr('h1') ? ratio(finite(obj.h1?.liquidity?.distanceToKnownLiquidity), atr('h1')) : null;
  const eqHigh = finite(obj.h1?.liquidity?.equalHighCount) ?? 0, eqLow = finite(obj.h1?.liquidity?.equalLowCount) ?? 0;
  out.LIQUIDITY.h1LiquidityAheadMinusBehind = s > 0 ? eqHigh - eqLow : eqLow - eqHigh;

  // REGIME: pre-entry regime labels only (computed from completed candles).
  for (const name of ['h1', 'h4', 'd1']) { out.REGIME[`${name}RegimeTrendAlign`] = trendValue(obj[name]?.regime?.trend) * s; out.REGIME[`${name}RegimeVol`] = volLevel(obj[name]?.regime?.volatility); }
  const regimeText = String(row.regime || '').toUpperCase();
  out.REGIME.regimeRange = /RANGE/.test(regimeText) ? 1 : 0;
  out.REGIME.regimeCompression = /COMPRESSION/.test(regimeText) ? 1 : 0;
  out.REGIME.regimeTrendAlign = /UPTREND/.test(regimeText) ? s : /DOWNTREND/.test(regimeText) ? -s : 0;

  // CROSS_MARKET: BTC/ETH returns, relative strength, breadth, broad volatility.
  const market = context.crossMarket;
  if (market) {
    const ret = (asset, hours) => { const series = market[asset]; if (!series) return null; const now = closeAt(series, row.timestamp), then = closeAt(series, row.timestamp - hours * HOUR_MS); return now && then ? Math.log(now / then) * 100 : null; };
    for (const hours of [1, 4, 24, 72]) out.CROSS_MARKET[`btcRet${hours}h`] = ret('BTC', hours);
    out.CROSS_MARKET.btcRet24hDir = out.CROSS_MARKET.btcRet24h === null ? null : s * out.CROSS_MARKET.btcRet24h;
    out.CROSS_MARKET.ethRet24hDir = ret('ETH', 24) === null ? null : s * ret('ETH', 24);
    const own = ret(row.asset, 24), btc = ret('BTC', 24), eth = ret('ETH', 24);
    out.CROSS_MARKET.rsVsBtc24hDir = own !== null && btc !== null ? s * (own - btc) : null;
    out.CROSS_MARKET.rsVsEth24hDir = own !== null && eth !== null ? s * (own - eth) : null;
    const own72 = ret(row.asset, 72), btc72 = ret('BTC', 72);
    out.CROSS_MARKET.rsVsBtc72hDir = own72 !== null && btc72 !== null ? s * (own72 - btc72) : null;
    const universe = Object.keys(market).map(asset => ret(asset, 24)).filter(Number.isFinite);
    out.CROSS_MARKET.breadth24hDir = universe.length >= 3 ? s * (universe.filter(value => value > 0).length / universe.length - .5) : null;
    out.CROSS_MARKET.dispersion24h = universe.length >= 3 ? std(universe) : null;
    out.CROSS_MARKET.btcRealizedVol24h = realizedVol(market.BTC, row.timestamp, 24);
  }
  // DERIVATIVES: funding settled at or before the scan (known at settlement).
  const funding = context.funding?.[row.asset];
  if (funding?.length) {
    const known = funding.filter(item => item.time <= row.timestamp);
    const last3 = known.slice(-3).map(item => item.rate), last90 = known.slice(-90).map(item => item.rate);
    if (last3.length) {
      out.DERIVATIVES.fundingLastDir = s * last3.at(-1) * 1e4;
      out.DERIVATIVES.funding24hDir = s * mean(last3) * 1e4;
      const dev = std(last90);
      out.DERIVATIVES.fundingZ30dDir = dev ? s * (mean(last3) - mean(last90)) / dev : null;
    }
  }
  assertPreEntryFeatureNames(out);
  return out;
}
function closeAt(series, timestamp) { let low = 0, high = series.length - 1, found = null; while (low <= high) { const middle = (low + high) >> 1; if (series[middle].closeTime <= timestamp) { found = series[middle]; low = middle + 1; } else high = middle - 1; } return found && timestamp - found.closeTime <= 2 * HOUR_MS ? found.close : null; }
function realizedVol(series, timestamp, hours) { if (!series) return null; const closes = []; for (let h = hours; h >= 0; h--) closes.push(closeAt(series, timestamp - h * HOUR_MS)); if (closes.some(value => !value)) return null; const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index])); return std(returns) * 100; }
function assertPreEntryFeatureNames(families) { for (const family of Object.values(families)) for (const name of Object.keys(family)) if (LEAK_PATTERN.test(name)) throw new Error(`LEAKAGE_REJECTED: feature name ${name}`); return true; }
function featureTable(rows, context) { return rows.map(row => extractFeatures(row, context)); }
function columns(featureRows, families) { const names = new Set(); for (const item of featureRows) for (const family of families) for (const name of Object.keys(item[family] || {})) names.add(`${family}.${name}`); return [...names].sort(); }
function matrix(featureRows, cols) { return featureRows.map(item => cols.map(col => { const [family, name] = col.split('.'); return finite(item[family]?.[name]); })); }
function fitScaler(X) {
  const width = X[0]?.length || 0, centre = [], scale = [], keep = [];
  for (let j = 0; j < width; j++) { const values = X.map(row => row[j]).filter(Number.isFinite), m = mean(values) ?? 0, d = std(values) ?? 0; centre.push(m); scale.push(d > 1e-9 ? d : 1); keep.push(values.length >= Math.max(10, X.length * .5) && d > 1e-9); }
  return {centre, scale, keep};
}
function applyScaler(X, scaler) { return X.map(row => row.map((value, j) => scaler.keep[j] ? clip(Number.isFinite(value) ? (value - scaler.centre[j]) / scaler.scale[j] : 0, -5, 5) : 0)); }

// ----------------------------------------------------------------- models --
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col; for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) { if (r === col) continue; const factor = M[r][col] / p; if (!factor) continue; for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c]; }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
function ridgeFit(X, y, lambda) {
  const width = X[0]?.length || 0, ym = mean(y) ?? 0, A = Array.from({length: width}, () => Array(width).fill(0)), b = Array(width).fill(0);
  for (let i = 0; i < X.length; i++) { const row = X[i], target = y[i] - ym; for (let j = 0; j < width; j++) { if (!row[j]) continue; b[j] += row[j] * target; for (let k = j; k < width; k++) A[j][k] += row[j] * row[k]; } }
  for (let j = 0; j < width; j++) { A[j][j] += lambda; for (let k = 0; k < j; k++) A[j][k] = A[k][j]; }
  return {weights: width ? solve(A, b) : [], intercept: ym};
}
const linear = (model, row) => model.intercept + row.reduce((total, value, j) => total + value * model.weights[j], 0);
function demeanWithinGroups(X, y, groupIds) {
  const index = new Map(); groupIds.forEach((id, i) => { const list = index.get(id) || []; list.push(i); index.set(id, list); });
  const Xd = X.map(row => row.slice()), yd = y.slice();
  for (const members of index.values()) {
    if (members.length < 2) { for (const i of members) { Xd[i] = Xd[i].map(() => 0); yd[i] = 0; } continue; }
    const width = X[0].length;
    for (let j = 0; j < width; j++) { const m = mean(members.map(i => X[i][j])); for (const i of members) Xd[i][j] = X[i][j] - m; }
    const my = mean(members.map(i => y[i])); for (const i of members) yd[i] = y[i] - my;
  }
  return {Xd, yd};
}
function logisticFit(X, y, lambda, iterations = 300, rate = .1) {
  const width = X[0]?.length || 0, w = Array(width).fill(0); let bias = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const grad = Array(width).fill(0); let gradBias = 0;
    for (let i = 0; i < X.length; i++) { const z = bias + X[i].reduce((t, v, j) => t + v * w[j], 0), p = 1 / (1 + Math.exp(-clip(z, -30, 30))), error = p - y[i]; gradBias += error; for (let j = 0; j < width; j++) grad[j] += error * X[i][j]; }
    bias -= rate * gradBias / X.length; for (let j = 0; j < width; j++) w[j] -= rate * (grad[j] / X.length + lambda * w[j]);
  }
  return {weights: w, intercept: bias};
}
// Histogram gradient-boosted depth-2 trees.  mode 'regression' fits squared
// loss; mode 'lambdarank' fits RankNet pairwise gradients inside each scan,
// weighted by |delta target| (magnitude-aware ranking on FINAL_R or TP1).
function binEdges(X, bins = 16) { const width = X[0]?.length || 0, edges = []; for (let j = 0; j < width; j++) { const values = X.map(row => row[j]), cuts = []; for (let q = 1; q < bins; q++) cuts.push(quantile(values, q / bins)); edges.push([...new Set(cuts)].sort((a, b) => a - b)); } return edges; }
function binOf(value, cuts) { let low = 0, high = cuts.length; while (low < high) { const middle = (low + high) >> 1; if (value <= cuts[middle]) high = middle; else low = middle + 1; } return low; }
function fitTree(B, grad, hess, members, depth, minLeaf, lambda, width, binsPerFeature) {
  const leaf = () => ({value: -sum(members.map(i => grad[i])) / (sum(members.map(i => hess[i])) + lambda)});
  if (depth === 0 || members.length < 2 * minLeaf) return leaf();
  const G = sum(members.map(i => grad[i])), H = sum(members.map(i => hess[i])), parent = G * G / (H + lambda);
  let best = null;
  for (let j = 0; j < width; j++) {
    const nb = binsPerFeature[j] + 1; if (nb < 2) continue;
    const gb = new Float64Array(nb), hb = new Float64Array(nb), cb = new Int32Array(nb);
    for (const i of members) { const b = B[i][j]; gb[b] += grad[i]; hb[b] += hess[i]; cb[b]++; }
    let gl = 0, hl = 0, cl = 0;
    for (let b = 0; b < nb - 1; b++) { gl += gb[b]; hl += hb[b]; cl += cb[b]; const cr = members.length - cl; if (cl < minLeaf || cr < minLeaf) continue; const gain = gl * gl / (hl + lambda) + (G - gl) ** 2 / (H - hl + lambda) - parent; if (!best || gain > best.gain) best = {feature: j, bin: b, gain}; }
  }
  if (!best || best.gain <= 1e-12) return leaf();
  const left = members.filter(i => B[i][best.feature] <= best.bin), right = members.filter(i => B[i][best.feature] > best.bin);
  return {feature: best.feature, bin: best.bin, left: fitTree(B, grad, hess, left, depth - 1, minLeaf, lambda, width, binsPerFeature), right: fitTree(B, grad, hess, right, depth - 1, minLeaf, lambda, width, binsPerFeature)};
}
const treeValue = (tree, bins) => tree.value !== undefined ? tree.value : treeValue(bins[tree.feature] <= tree.bin ? tree.left : tree.right, bins);
function gbmFit(X, y, groupIds, {mode = 'regression', rounds = 150, rate = .05, depth = 2, minLeaf = 15, lambda = 1, validation = null} = {}) {
  const edges = binEdges(X), width = X[0]?.length || 0, binsPerFeature = edges.map(cuts => cuts.length), toBins = rows => rows.map(row => row.map((value, j) => binOf(value, edges[j])));
  const B = toBins(X), n = X.length, score = new Float64Array(n), base = mode === 'regression' ? (mean(y) ?? 0) : 0, trees = [];
  score.fill(base);
  const groups = new Map(); groupIds.forEach((id, i) => { const list = groups.get(id) || []; list.push(i); groups.set(id, list); });
  const vB = validation ? toBins(validation.X) : null, vScore = validation ? new Float64Array(validation.X.length).fill(base) : null;
  let bestRound = 0, bestLoss = Infinity; const history = [];
  for (let round = 1; round <= rounds; round++) {
    const grad = new Float64Array(n), hess = new Float64Array(n);
    if (mode === 'regression') for (let i = 0; i < n; i++) { grad[i] = score[i] - y[i]; hess[i] = 1; }
    else for (const members of groups.values()) for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
      const i = members[a], k = members[b]; if (y[i] === y[k]) continue;
      const [hi, lo] = y[i] > y[k] ? [i, k] : [k, i], weight = Math.min(3, Math.abs(y[i] - y[k])), rho = 1 / (1 + Math.exp(clip(score[hi] - score[lo], -30, 30)));
      grad[hi] -= weight * rho; grad[lo] += weight * rho; hess[hi] += weight * rho * (1 - rho); hess[lo] += weight * rho * (1 - rho);
    }
    const members = [...Array(n).keys()].filter(i => mode === 'regression' || hess[i] > 0);
    if (!members.length) break;
    const tree = fitTree(B, grad, hess, members, depth, minLeaf, lambda, width, binsPerFeature); trees.push(tree);
    for (let i = 0; i < n; i++) score[i] += rate * treeValue(tree, B[i]);
    if (validation) { for (let i = 0; i < vB.length; i++) vScore[i] += rate * treeValue(tree, vB[i]); const loss = mode === 'regression' ? mean([...vScore].map((value, i) => (value - validation.y[i]) ** 2)) : -weightedPairAccuracy([...vScore], validation.y, validation.groupIds); history.push(loss); if (loss < bestLoss - 1e-9) { bestLoss = loss; bestRound = round; } }
  }
  const used = validation ? Math.max(1, bestRound) : trees.length;
  return {base, rate, edges, trees: trees.slice(0, used), rounds: used, predict: rows => toBins(rows).map(bins => base + rate * sum(trees.slice(0, used).map(tree => treeValue(tree, bins))))};
}

// Conv1D over direction-signed multi-timeframe sequences.  Channels are
// flipped for shorts so "favourable" always has the same sign.
const SEQ_FRAMES = ['m5', 'm15', 'h1'], SEQ_WINDOW = 32, SEQ_CHANNELS = 5, FILTERS = 4, KERNEL = 3;
function sequenceTensor(row) {
  const s = dirSign(row);
  return SEQ_FRAMES.map(name => seqRows(row, name).slice(-SEQ_WINDOW).map(item => [
    clip(s * (finite(item.close_to_close) ?? 0) * 100, -10, 10), clip((finite(item.high_low) ?? 0) * 100, 0, 20), clip(finite(item.relative_volume) ?? 1, 0, 6) - 1,
    clip(s * (finite(item.atr_normalized_move) ?? 0), -6, 6), clip((finite(item.rolling_volatility) ?? 0) * 100, 0, 20)]));
}
function convInit(seed) { const random = rng(seed), gaussian = () => (random() + random() + random() - 1.5) * .4; return {kernels: SEQ_FRAMES.map(() => Array.from({length: FILTERS}, () => Array.from({length: KERNEL * SEQ_CHANNELS}, gaussian))), biases: SEQ_FRAMES.map(() => Array(FILTERS).fill(0)), head: Array(SEQ_FRAMES.length * FILTERS * 2).fill(0), headBias: 0}; }
function convForward(model, tensor) {
  const embedding = [], cache = [];
  tensor.forEach((sequence, f) => {
    const length = sequence.length - KERNEL + 1, acts = [];
    for (let k = 0; k < FILTERS; k++) { const values = []; for (let t = 0; t < length; t++) { let z = model.biases[f][k]; for (let d = 0; d < KERNEL; d++) for (let c = 0; c < SEQ_CHANNELS; c++) z += model.kernels[f][k][d * SEQ_CHANNELS + c] * sequence[t + d][c]; values.push(Math.max(0, z)); } acts.push(values); embedding.push(mean(values) ?? 0, values.at(-1) ?? 0); }
    cache.push(acts);
  });
  return {embedding, cache, output: model.headBias + embedding.reduce((t, v, i) => t + v * model.head[i], 0)};
}
function convFit(tensors, targets, {validation = null, epochs = 40, patience = 5, rate = .003, l2 = 1e-3, seed = 7} = {}) {
  let model = convInit(seed); const moments = new Map(), random = rng(seed + 1); let step = 0, best = {loss: Infinity, model: structuredClone(model), epoch: 0}, stale = 0;
  const adam = (key, grad, param, i) => { const m = moments.get(key) || {m: 0, v: 0}; m.m = .9 * m.m + .1 * grad; m.v = .999 * m.v + .001 * grad * grad; moments.set(key, m); const mh = m.m / (1 - .9 ** step), vh = m.v / (1 - .999 ** step); param[i] -= rate * mh / (Math.sqrt(vh) + 1e-8); };
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const order = [...tensors.keys()].sort(() => random() - .5);
    for (const index of order) {
      step++; const tensor = tensors[index], pass = convForward(model, tensor), error = pass.output - targets[index];
      pass.embedding.forEach((value, i) => adam(`h${i}`, error * value + l2 * model.head[i], model.head, i)); adam('hb', error, model, 'headBias');
      tensor.forEach((sequence, f) => { for (let k = 0; k < FILTERS; k++) { const acts = pass.cache[f][k], length = acts.length, gMean = error * model.head[(f * FILTERS + k) * 2] / length, gLast = error * model.head[(f * FILTERS + k) * 2 + 1]; const gradK = Array(KERNEL * SEQ_CHANNELS).fill(0); let gradB = 0; for (let t = 0; t < length; t++) { if (acts[t] <= 0) continue; const g = gMean + (t === length - 1 ? gLast : 0); gradB += g; for (let d = 0; d < KERNEL; d++) for (let c = 0; c < SEQ_CHANNELS; c++) gradK[d * SEQ_CHANNELS + c] += g * sequence[t + d][c]; } gradK.forEach((g, i) => adam(`k${f}.${k}.${i}`, g + l2 * model.kernels[f][k][i], model.kernels[f][k], i)); adam(`b${f}.${k}`, gradB, model.biases[f], k); } });
    }
    if (validation) { const loss = mean(validation.tensors.map((tensor, i) => (convForward(model, tensor).output - validation.targets[i]) ** 2)); if (loss < best.loss - 1e-9) { best = {loss, model: structuredClone(model), epoch}; stale = 0; } else if (++stale >= patience) break; }
  }
  const final = validation ? best.model : model;
  return {model: final, bestEpoch: validation ? best.epoch : epochs, predict: tensorsIn => tensorsIn.map(tensor => convForward(final, tensor).output)};
}

// ---------------------------------------------------------------- metrics --
function weightedPairAccuracy(scores, targets, groupIds) {
  const groups = new Map(); groupIds.forEach((id, i) => { const list = groups.get(id) || []; list.push(i); groups.set(id, list); });
  let good = 0, total = 0;
  for (const members of groups.values()) for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) { const i = members[a], k = members[b], dy = targets[i] - targets[k]; if (!dy) continue; const w = Math.abs(dy), ds = scores[i] - scores[k]; total += w; good += ds === 0 ? w / 2 : Math.sign(ds) === Math.sign(dy) ? w : 0; }
  return total ? good / total : .5;
}
// One pick per scan.  Exact score ties share the pick (expected value of a
// random tie-break) so no model gains from candidate_id ordering.
function picks(rows, scores, cost = BASE_COST) {
  const byScan = new Map(); rows.forEach((row, i) => { const list = byScan.get(row.scan_id) || []; list.push({row, score: scores[i]}); byScan.set(row.scan_id, list); });
  return [...byScan.values()].map(list => { const top = Math.max(...list.map(item => item.score)), tied = list.filter(item => Math.abs(item.score - top) < 1e-12), r = mean(tied.map(item => costR(item.row, cost))); return {scan_id: list[0].row.scan_id, timestamp: list[0].row.timestamp, choices: list.length, tied: tied.length, r, row: tied[0].row, tp1: mean(tied.map(item => item.row.targets.TP1_BEFORE_SL ? 1 : 0)), stop: mean(tied.map(item => item.row.targets.STOP_HIT ? 1 : 0)), mfe: mean(tied.map(item => finite(item.row.targets.MFE))), mae: mean(tied.map(item => finite(item.row.targets.MAE)))}; }).sort((a, b) => a.timestamp - b.timestamp);
}
function drawdown(series) { let equity = 0, peak = 0, worst = 0; for (const value of series) { equity += value; peak = Math.max(peak, equity); worst = Math.min(worst, equity - peak); } return worst; }
function summarise(selected) {
  const r = selected.map(item => item.r), wins = sum(r.filter(value => value > 0)), losses = sum(r.filter(value => value < 0));
  return {n: r.length, meanR: mean(r), medianR: median(r), profitFactor: losses ? wins / Math.abs(losses) : null, maxDrawdownR: drawdown(r), totalR: sum(r), tp1Rate: mean(selected.map(item => item.tp1)), stopRate: mean(selected.map(item => item.stop)), mfe: mean(selected.map(item => item.mfe)), mae: mean(selected.map(item => item.mae))};
}
function blockBootstrap(series, {reps = 2000, block = 5, seed = 11} = {}) {
  const n = series.length; if (n < 5) return {low: null, high: null, pPositive: null};
  const random = rng(seed), stats = [];
  for (let rep = 0; rep < reps; rep++) { let total = 0, count = 0; while (count < n) { const start = Math.floor(random() * n); for (let k = 0; k < block && count < n; k++, count++) total += series[(start + k) % n]; } stats.push(total / n); }
  return {low: quantile(stats, .025), high: quantile(stats, .975), pPositive: mean(stats.map(value => value > 0 ? 1 : 0))};
}
function rankBuckets(rows, scores, cost = BASE_COST) {
  const byScan = new Map(); rows.forEach((row, i) => { const list = byScan.get(row.scan_id) || []; list.push({row, score: scores[i]}); byScan.set(row.scan_id, list); });
  const buckets = {'#1': [], '#2-5': [], '#6-10': [], '#11+': []};
  for (const list of byScan.values()) { if (list.length < 2) continue; list.sort((a, b) => b.score - a.score || String(a.row.candidate_id).localeCompare(String(b.row.candidate_id))).forEach((item, index) => { const rank = index + 1; buckets[rank === 1 ? '#1' : rank <= 5 ? '#2-5' : rank <= 10 ? '#6-10' : '#11+'].push(costR(item.row, cost)); }); }
  return Object.fromEntries(Object.entries(buckets).map(([name, values]) => [name, {n: values.length, meanR: mean(values), medianR: median(values)}]));
}
function spearmanWithin(rows, scores) {
  const byScan = new Map(); rows.forEach((row, i) => { const list = byScan.get(row.scan_id) || []; list.push({r: finite(row.targets.FINAL_R), s: scores[i]}); byScan.set(row.scan_id, list); });
  const rank = values => { const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), out = Array(values.length); order.forEach(([, i], k) => { out[i] = k; }); return out; };
  const rhos = [];
  for (const list of byScan.values()) { if (list.length < 3) { if (list.length === 2 && list[0].r !== list[1].r && list[0].s !== list[1].s) rhos.push(Math.sign(list[0].r - list[1].r) === Math.sign(list[0].s - list[1].s) ? 1 : -1); continue; } const a = rank(list.map(x => x.s)), b = rank(list.map(x => x.r)), ma = mean(a), mb = mean(b), cov = sum(a.map((v, i) => (v - ma) * (b[i] - mb))), den = Math.sqrt(sum(a.map(v => (v - ma) ** 2)) * sum(b.map(v => (v - mb) ** 2))); if (den) rhos.push(cov / den); }
  return {scans: rhos.length, meanSpearman: mean(rhos)};
}

// ------------------------------------------------------------ validation --
// Expanding-window walk-forward over scan groups with purge + embargo.
function walkForwardFolds(groups, {folds = 5, initialFraction = .4, embargoMs = EMBARGO_MS, horizonMs = OUTCOME_HORIZON_MS} = {}) {
  const n = groups.length, start = Math.floor(n * initialFraction), size = Math.floor((n - start) / folds), out = [];
  for (let k = 0; k < folds; k++) {
    const testStart = start + k * size, testEnd = k === folds - 1 ? n : testStart + size, test = groups.slice(testStart, testEnd); if (!test.length) continue;
    const boundary = test[0][0].timestamp, train = groups.slice(0, testStart).filter(group => group[0].timestamp + horizonMs + embargoMs <= boundary);
    out.push({fold: k + 1, train, test, purged: testStart - train.length, testStartMs: boundary, testEndMs: test.at(-1)[0].timestamp});
  }
  return out;
}
// Inner split for tuning: the chronologically last 25% of the training window,
// separated by the same purge + embargo.
function innerSplit(trainGroups, {embargoMs = EMBARGO_MS, horizonMs = OUTCOME_HORIZON_MS} = {}) {
  const cut = Math.floor(trainGroups.length * .75), validation = trainGroups.slice(cut), boundary = validation[0]?.[0]?.timestamp ?? Infinity;
  return {fit: trainGroups.slice(0, cut).filter(group => group[0].timestamp + horizonMs + embargoMs <= boundary), validation};
}

// ------------------------------------------------------------ model suite --
const MODEL_NAMES = ['RANDOM', 'CURRENT_QUANT', 'LOGISTIC_TP1', 'RIDGE_FINAL_R', 'GBM_FINAL_R', 'WITHIN_SCAN_RIDGE', 'LAMBDARANK_GBM_FINAL_R', 'LAMBDARANK_GBM_TP1', 'CONV1D_MTF', 'FUSION'];
const ENGINEERED = FAMILIES;
function prepare(rows, featureRows, cols, scaler) { const X = applyScaler(matrix(featureRows, cols), scaler); return {X, y: rows.map(row => finite(row.targets.FINAL_R)), tp1: rows.map(row => row.targets.TP1_BEFORE_SL ? 1 : 0), groupIds: rows.map(row => row.scan_id)}; }
function trainModel(name, trainRows, trainFeatures, families, options = {}) {
  const cols = columns(trainFeatures, families), scaler = fitScaler(matrix(trainFeatures, cols)), full = prepare(trainRows, trainFeatures, cols, scaler);
  const {fit, validation} = innerSplit(groupByScan(trainRows)), fitIds = new Set(fit.flat().map(row => row.candidate_id)), valIds = new Set(validation.flat().map(row => row.candidate_id));
  const pick = ids => { const idx = trainRows.map((row, i) => ids.has(row.candidate_id) ? i : -1).filter(i => i >= 0); return {rows: idx.map(i => trainRows[i]), X: idx.map(i => full.X[i]), y: idx.map(i => full.y[i]), tp1: idx.map(i => full.tp1[i]), groupIds: idx.map(i => full.groupIds[i])}; };
  const inner = pick(fitIds), outer = pick(valIds), tuned = {};
  const featurePredict = model => rows => model(applyScaler(matrix(rows.features, cols), scaler));
  if (name === 'LOGISTIC_TP1') {
    const lambda = tune([.001, .01, .1], l => { const m = logisticFit(inner.X, inner.tp1, l); return weightedPairAccuracy(outer.X.map(r => linear(m, r)), outer.y, outer.groupIds); }); tuned.lambda = lambda;
    const m = logisticFit(full.X, full.tp1, lambda); return {tuned, cols, predict: featurePredict(X => X.map(r => linear(m, r)))};
  }
  if (name === 'RIDGE_FINAL_R') {
    const lambda = tune([1, 10, 100, 1000], l => { const m = ridgeFit(inner.X, inner.y, l); return weightedPairAccuracy(outer.X.map(r => linear(m, r)), outer.y, outer.groupIds); }); tuned.lambda = lambda;
    const m = ridgeFit(full.X, full.y, lambda); return {tuned, cols, weights: m.weights, predict: featurePredict(X => X.map(r => linear(m, r)))};
  }
  if (name === 'WITHIN_SCAN_RIDGE') {
    const fitWithin = (data, l) => { const {Xd, yd} = demeanWithinGroups(data.X, data.y, data.groupIds); const m = ridgeFit(Xd, yd, l); return {...m, intercept: 0}; };
    const lambda = tune([1, 10, 100, 1000], l => { const m = fitWithin(inner, l); return weightedPairAccuracy(outer.X.map(r => linear(m, r)), outer.y, outer.groupIds); }); tuned.lambda = lambda;
    const m = fitWithin(full, lambda); return {tuned, cols, weights: m.weights, predict: featurePredict(X => X.map(r => linear(m, r)))};
  }
  if (name === 'GBM_FINAL_R' || name.startsWith('LAMBDARANK')) {
    const mode = name === 'GBM_FINAL_R' ? 'regression' : 'lambdarank', target = name.endsWith('TP1') ? 'tp1' : 'y';
    const probe = gbmFit(inner.X, inner[target], inner.groupIds, {mode, rounds: 200, validation: {X: outer.X, y: outer[target], groupIds: outer.groupIds}}); tuned.rounds = probe.rounds;
    const m = gbmFit(full.X, full[target], full.groupIds, {mode, rounds: probe.rounds}); return {tuned, cols, predict: featurePredict(X => m.predict(X))};
  }
  if (name === 'CONV1D_MTF') {
    const withinTarget = data => demeanWithinGroups(data.rows.map(() => [0]), data.y, data.groupIds).yd;
    const innerT = inner.rows.map(sequenceTensor), outerT = outer.rows.map(sequenceTensor);
    const probe = convFit(innerT, withinTarget(inner), {validation: {tensors: outerT, targets: withinTarget(outer)}}); tuned.epochs = Math.max(1, probe.bestEpoch);
    const fullData = {rows: trainRows, y: full.y, groupIds: full.groupIds}, m = convFit(trainRows.map(sequenceTensor), withinTarget(fullData), {epochs: tuned.epochs});
    return {tuned, cols: [], predict: rows => m.predict(rows.rows.map(sequenceTensor))};
  }
  throw new Error(`Unknown model ${name}`);
}
function tune(grid, score) { let best = grid[0], bestScore = -Infinity; for (const value of grid) { const result = score(value); if (result > bestScore + 1e-9) { best = value; bestScore = result; } } return best; }
function zscore(values) { const m = mean(values) ?? 0, d = std(values) || 1; return values.map(value => (value - m) / d); }
function fusionModel(trainRows, trainFeatures, families) {
  // Mixing weight chosen on the inner validation slice only.
  const {fit, validation} = innerSplit(groupByScan(trainRows)), ids = new Set(fit.flat().map(row => row.candidate_id)), vIds = new Set(validation.flat().map(row => row.candidate_id));
  const subset = set => { const idx = trainRows.map((row, i) => set.has(row.candidate_id) ? i : -1).filter(i => i >= 0); return {rows: idx.map(i => trainRows[i]), features: idx.map(i => trainFeatures[i])}; };
  const a = subset(ids), b = subset(vIds), ridgeInner = trainModel('WITHIN_SCAN_RIDGE', a.rows, a.features, families), convInner = trainModel('CONV1D_MTF', a.rows, a.features, families);
  const r1 = zscore(ridgeInner.predict(b)), r2 = zscore(convInner.predict(b)), y = b.rows.map(row => finite(row.targets.FINAL_R)), g = b.rows.map(row => row.scan_id);
  const alpha = tune([0, .25, .5, .75, 1], value => weightedPairAccuracy(r1.map((v, i) => value * v + (1 - value) * r2[i]), y, g));
  const ridge = trainModel('WITHIN_SCAN_RIDGE', trainRows, trainFeatures, families), conv = trainModel('CONV1D_MTF', trainRows, trainFeatures, families);
  return {tuned: {alpha}, predict: data => { const p1 = zscore(ridge.predict(data)), p2 = zscore(conv.predict(data)); return p1.map((v, i) => alpha * v + (1 - alpha) * p2[i]); }};
}
function scoreModel(name, trainRows, trainFeatures, testRows, testFeatures, families) {
  const data = {rows: testRows, features: testFeatures};
  if (name === 'RANDOM') return {scores: testRows.map(() => 0), tuned: {}};        // all tied => exact expected value of a random pick
  if (name === 'CURRENT_QUANT') return {scores: testRows.map(row => row.quant_score), tuned: {}};
  if (name === 'FUSION') { const m = fusionModel(trainRows, trainFeatures, families); return {scores: m.predict(data), tuned: m.tuned}; }
  const m = trainModel(name, trainRows, trainFeatures, families); return {scores: m.predict(data), tuned: m.tuned, weights: m.weights, cols: m.cols};
}
function walkForward(rows, featureRows, {models = MODEL_NAMES, families = ENGINEERED, folds = 5} = {}) {
  const featureById = new Map(rows.map((row, i) => [row.candidate_id, featureRows[i]])), plan = walkForwardFolds(groupByScan(rows), {folds}), result = Object.fromEntries(models.map(name => [name, {oosRows: [], oosScores: [], folds: []}]));
  for (const fold of plan) {
    const trainRows = fold.train.flat(), testRows = fold.test.flat(), trainF = trainRows.map(row => featureById.get(row.candidate_id)), testF = testRows.map(row => featureById.get(row.candidate_id));
    for (const name of models) {
      const {scores, tuned} = scoreModel(name, trainRows, trainF, testRows, testF, families), selected = picks(testRows, scores);
      result[name].oosRows.push(...testRows); result[name].oosScores.push(...scores);
      result[name].folds.push({fold: fold.fold, trainScans: fold.train.length, testScans: fold.test.length, purgedScans: fold.purged, testStart: new Date(fold.testStartMs).toISOString().slice(0, 10), testEnd: new Date(fold.testEndMs).toISOString().slice(0, 10), tuned, meanR016: summarise(selected).meanR});
    }
  }
  return {plan: plan.map(fold => ({fold: fold.fold, train: fold.train.length, test: fold.test.length, purged: fold.purged})), models: result};
}
function evaluateOos(entry, quantEntry, randomEntry) {
  const atCosts = {}; for (const cost of COSTS) atCosts[`${(cost * 100).toFixed(2)}%`] = summarise(picks(entry.oosRows, entry.oosScores, cost));
  const selected = picks(entry.oosRows, entry.oosScores), series = selected.map(item => item.r), quant = picks(quantEntry.oosRows, quantEntry.oosScores), random = picks(randomEntry.oosRows, randomEntry.oosScores);
  const byScan = map => new Map(map.map(item => [item.scan_id, item.r])), q = byScan(quant), rnd = byScan(random);
  const diffQuant = selected.map(item => item.r - q.get(item.scan_id)), diffRandom = selected.map(item => item.r - rnd.get(item.scan_id));
  const choiceOnly = selected.filter(item => item.choices >= 2);
  const assets = {}; for (const item of selected) { const list = assets[item.row.asset] || []; list.push(item.r); assets[item.row.asset] = list; }
  const dominant = Object.entries(assets).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const withoutDominant = selected.filter(item => item.row.asset !== dominant).map(item => item.r);
  return {atCosts, ci95_016: blockBootstrap(series), vsQuant016: {meanDiff: mean(diffQuant), ci95: blockBootstrap(diffQuant, {seed: 13})}, vsRandom016: {meanDiff: mean(diffRandom), ci95: blockBootstrap(diffRandom, {seed: 17})},
    choiceScans: {n: choiceOnly.length, meanR: mean(choiceOnly.map(item => item.r)), vsQuantMeanDiff: mean(choiceOnly.map(item => item.r - q.get(item.scan_id)))},
    folds: entry.folds, foldsPositive016: entry.folds.filter(fold => fold.meanR016 > 0).length, rankBuckets: rankBuckets(entry.oosRows, entry.oosScores), monotonicity: {weightedPairAccuracy: weightedPairAccuracy(entry.oosScores, entry.oosRows.map(row => finite(row.targets.FINAL_R)), entry.oosRows.map(row => row.scan_id)), ...spearmanWithin(entry.oosRows, entry.oosScores)},
    assets: Object.fromEntries(Object.entries(assets).map(([asset, values]) => [asset, {picks: values.length, meanR: mean(values)}])), dominantAsset: dominant, withoutDominantAsset: {n: withoutDominant.length, meanR: mean(withoutDominant)},
    pickProfile: {strategies: countBy(selected, item => item.row.strategy), directions: countBy(selected, item => item.row.direction), medianStopPct: median(selected.map(item => stopFraction(item.row) * 100)), labelSources: countBy(selected, item => item.row.targets.outcome_source || 'COINBASE_CANONICAL')}};
}
function countBy(items, key) { const out = {}; for (const item of items) { const k = String(key(item)); out[k] = (out[k] || 0) + 1; } return out; }
// Acceptance: positive expectancy with CI support, beats Quant with CI
// support, stable across folds, survives 0.25% costs and asset removal.
function acceptance(evaluation) {
  const checks = {positiveAt016: evaluation.atCosts['0.16%'].meanR > 0, ciLowerAbove0: (evaluation.ci95_016.low ?? -Infinity) > 0, beatsQuantWithCi: (evaluation.vsQuant016.ci95.low ?? -Infinity) > 0, foldStability: evaluation.foldsPositive016 >= Math.ceil(evaluation.folds.length * .6), positiveAt025: evaluation.atCosts['0.25%'].meanR > 0, assetRobust: (evaluation.withoutDominantAsset.meanR ?? -Infinity) > 0};
  return {checks, verdict: Object.values(checks).every(Boolean) ? 'SHADOW_CANDIDATE' : 'NO_PROMOTION'};
}
function ablations(rows, featureRows, model, {folds = 5} = {}) {
  const full = walkForward(rows, featureRows, {models: [model, 'CURRENT_QUANT', 'RANDOM'], folds}), base = evaluateOos(full.models[model], full.models.CURRENT_QUANT, full.models.RANDOM), out = {FULL: {meanR016: base.atCosts['0.16%'].meanR, pairAccuracy: base.monotonicity.weightedPairAccuracy}};
  for (const family of FAMILIES) {
    const families = FAMILIES.filter(name => name !== family);
    if (!columns(featureRows, [family]).length) { out[`minus_${family}`] = {status: 'FAMILY_EMPTY'}; continue; }
    const run = walkForward(rows, featureRows, {models: [model, 'CURRENT_QUANT', 'RANDOM'], families, folds}), evaluation = evaluateOos(run.models[model], run.models.CURRENT_QUANT, run.models.RANDOM);
    out[`minus_${family}`] = {meanR016: evaluation.atCosts['0.16%'].meanR, deltaVsFull: evaluation.atCosts['0.16%'].meanR - base.atCosts['0.16%'].meanR, pairAccuracy: evaluation.monotonicity.weightedPairAccuracy};
  }
  for (const family of FAMILIES) {
    if (!columns(featureRows, [family]).length) continue;
    const run = walkForward(rows, featureRows, {models: [model, 'CURRENT_QUANT', 'RANDOM'], families: [family], folds}), evaluation = evaluateOos(run.models[model], run.models.CURRENT_QUANT, run.models.RANDOM);
    out[`only_${family}`] = {meanR016: evaluation.atCosts['0.16%'].meanR, pairAccuracy: evaluation.monotonicity.weightedPairAccuracy};
  }
  return out;
}

// ------------------------------------------------------ dataset audit ------
function datasetAudit(rows, allCandidates = []) {
  const groups = groupByScan(rows), sizes = groups.map(group => group.length), choice = groups.filter(group => group.length >= 2);
  const assets = countBy(rows, row => row.asset), total = rows.length, btcEth = (assets.BTC || 0) + (assets.ETH || 0);
  const singleAsset = choice.filter(group => new Set(group.map(row => row.asset)).size === 1).length;
  const sameAssetOpposite = choice.filter(group => { const byAsset = Object.groupBy(group, row => row.asset); return Object.values(byAsset).some(list => new Set(list.map(row => row.direction)).size === 2); }).length;
  let nearDuplicates = 0; for (const group of groups) for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) { const x = group[a], y = group[b], atr = finite(x.features?.h1?.atr) || Math.abs(x.entry - x.stop); if (x.asset === y.asset && x.direction === y.direction && Math.abs(x.stop - y.stop) <= .25 * atr) nearDuplicates++; }
  const signature = group => group.map(row => `${row.asset}:${row.direction}:${row.strategy}:${row.stop}`).sort().join('|'), signatures = countBy(groups, signature);
  const withinScanSpread = choice.map(group => Math.max(...group.map(row => finite(row.targets.FINAL_R))) - Math.min(...group.map(row => finite(row.targets.FINAL_R))));
  const labelCorrelationBtcEth = (() => { const pairs = choice.map(group => { const btc = group.find(row => row.asset === 'BTC'), eth = group.find(row => row.asset === 'ETH' && row.direction === btc?.direction); return btc && eth ? [finite(btc.targets.FINAL_R), finite(eth.targets.FINAL_R)] : null; }).filter(Boolean); if (pairs.length < 5) return {pairs: pairs.length, correlation: null}; const a = pairs.map(p => p[0]), b = pairs.map(p => p[1]), ma = mean(a), mb = mean(b); return {pairs: pairs.length, correlation: sum(a.map((v, i) => (v - ma) * (b[i] - mb))) / Math.sqrt(sum(a.map(v => (v - ma) ** 2)) * sum(b.map(v => (v - mb) ** 2)))}; })();
  const quantTies = choice.filter(group => { const top = Math.max(...group.map(row => row.quant_score)); return group.filter(row => row.quant_score === top).length > 1; }).length;
  const rankContiguous = groups.every(group => { const ranks = group.map(row => row.candidate_rank).filter(Number.isFinite).sort((a, b) => a - b); return ranks.every((rank, i) => i === 0 || rank > ranks[i - 1]); });
  return {
    resolvedCandidates: total, scanGroups: groups.length, choiceScanGroups: choice.length, singleCandidateScans: groups.length - choice.length,
    firstScan: groups[0] ? new Date(groups[0][0].timestamp).toISOString() : null, lastScan: groups.at(-1) ? new Date(groups.at(-1)[0].timestamp).toISOString() : null,
    candidatesPerScan: {min: Math.min(...sizes), median: median(sizes), mean: mean(sizes), max: Math.max(...sizes), histogram: countBy(sizes, size => size)},
    assets, btcEthShare: total ? btcEth / total : null, strategies: countBy(rows, row => row.strategy), directions: countBy(rows, row => row.direction),
    quantRank: countBy(rows, row => row.candidate_rank), quantTopTiesInChoiceScans: quantTies, rankContiguous,
    choiceScansSingleAsset: singleAsset, choiceScansSameAssetOppositeDirection: sameAssetOpposite, nearDuplicateGeometryPairs: nearDuplicates,
    duplicatedScanSignatures: Object.values(signatures).filter(count => count > 1).length,
    labelSources: countBy(rows, row => row.targets.outcome_source || 'COINBASE_CANONICAL'),
    withinScanFinalRSpread: {median: median(withinScanSpread), mean: mean(withinScanSpread)}, btcEthSameDirectionLabelCorrelation: labelCorrelationBtcEth,
    outcomes: {tp1Rate: mean(rows.map(row => row.targets.TP1_BEFORE_SL ? 1 : 0)), stopRate: mean(rows.map(row => row.targets.STOP_HIT ? 1 : 0)), timeoutRate: mean(rows.map(row => !row.targets.STOP_HIT && !row.targets.TP2_HIT ? 1 : 0)), meanFinalR: mean(rows.map(row => finite(row.targets.FINAL_R))), medianStopPct: median(rows.map(row => stopFraction(row) * 100)), stopPctQuartiles: [quantile(rows.map(row => stopFraction(row) * 100), .25), quantile(rows.map(row => stopFraction(row) * 100), .75)], medianMfe: median(rows.map(row => finite(row.targets.MFE))), medianDurationBars: median(rows.map(row => finite(row.targets.duration_bars)))},
    allCandidateRows: allCandidates.length ? {total: allCandidates.length, byAssetValidity: countBy(allCandidates, row => `${row.asset}:${Number(row.valid_current_geometry) === 1 ? 'valid' : 'invalid'}`), byStatus: countBy(allCandidates, row => parse(row.targets_json).status || 'UNKNOWN')} : null,
    horizon: {outcomeHorizonHours: OUTCOME_HORIZON_MS / HOUR_MS, overlapWithNextScan: groups.length > 1 ? Math.max(0, OUTCOME_HORIZON_MS - median(groups.slice(1).map((group, i) => group[0].timestamp - groups[i][0].timestamp))) / HOUR_MS : null}
  };
}

// ------------------------------------------------------------ holdout ------
// The only way to read holdout rows.  It demands a pre-registered model spec
// hash and a one-shot registry that has never recorded this holdout id.
function consumeHoldout({registry, modelSpec, confirm}) {
  if (confirm !== 'CONSUME_SEALED_HOLDOUT_ONCE') throw new Error('HOLDOUT_SEALED: explicit one-shot confirmation required');
  if (!modelSpec || typeof modelSpec !== 'object' || !modelSpec.name || !modelSpec.families) throw new Error('HOLDOUT_SEALED: a frozen, pre-registered model spec is required');
  if (!registry || typeof registry.has !== 'function' || typeof registry.add !== 'function') throw new Error('HOLDOUT_SEALED: a durable registry is required');
  if (registry.has(HOLDOUT.id)) throw new Error('HOLDOUT_ALREADY_CONSUMED');
  const specHash = hashString(JSON.stringify(modelSpec)); registry.add(HOLDOUT.id, specHash);
  return {holdout: HOLDOUT, specHash, sqlFilter: `s.scan_timestamp >= ${HOLDOUT.startMs}`};
}

module.exports = {VERSION, HOLDOUT, COSTS, FAMILIES, MODEL_NAMES, EMBARGO_MS, OUTCOME_HORIZON_MS, parseRows, groupByScan, costR, stopFraction, extractFeatures, featureTable, columns, matrix, fitScaler, applyScaler, assertPreEntryFeatureNames, ridgeFit, logisticFit, gbmFit, convFit, sequenceTensor, demeanWithinGroups, weightedPairAccuracy, picks, summarise, blockBootstrap, rankBuckets, spearmanWithin, walkForwardFolds, innerSplit, walkForward, evaluateOos, acceptance, ablations, datasetAudit, consumeHoldout, closeAt, realizedVol, hashString};
