'use strict';

// Feature research v1: new point-in-time feature families for the
// HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF candidates.  Research only; nothing here
// is reachable from the live scanner, Quant, ranking or execution.
//
// Every family function receives full bar series plus the scan timestamp T and
// must read only bars that have CLOSED at or before T.  The future-invariance
// test (features.test.js) appends random future bars and requires identical
// output.  Definitions are fixed in PREREGISTRATION.md; each family carries a
// definition version recorded as the provenance normalization_version.

const B = 300_000, M15 = 3 * B, H1 = 3_600_000, H4 = 4 * H1, DAY = 24 * H1;
const VERSIONS = Object.freeze({FR_STRUCTURE: 'structure-v1', FR_FVG: 'fvg-v1', FR_CANDLE: 'candle-v1', FR_CROSS_MARKET: 'xmkt-v1', FR_DERIVATIVES: 'deriv-v1'});
const FR_FAMILIES = Object.freeze(Object.keys(VERSIONS));
const ASSETS = Object.freeze(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC']);
const SWING_K = Object.freeze({m15: 3, h1: 3, h4: 2});
const LOOKBACK = 300;

const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
const std = list => { if (list.length < 2) return null; const m = mean(list); return Math.sqrt(mean(list.map(v => (v - m) ** 2))); };
const sign = value => value > 0 ? 1 : value < 0 ? -1 : 0;
const clip = (value, low, high) => Math.max(low, Math.min(high, value));
function corr(a, b) { if (a.length !== b.length || a.length < 3) return null; const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : null; }

// ------------------------------------------------------------------ bars ---
// Aggregate complete, contiguous buckets only (a bucket with any missing
// child bar is absent, never partially built).
function aggregate(rows, from, to) {
  const out = []; let bucket = null;
  const flush = () => { if (bucket && bucket.count === to / from) out.push({time: bucket.time, open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close, volume: bucket.volume}); };
  for (const row of rows) {
    const start = Math.floor(row.time / to) * to;
    if (!bucket || bucket.time !== start) { flush(); bucket = {time: start, next: start, count: 0, open: row.open, high: row.high, low: row.low, close: row.close, volume: 0}; }
    if (row.time !== bucket.next) bucket.count = -Infinity;
    bucket.high = Math.max(bucket.high, row.high); bucket.low = Math.min(bucket.low, row.low); bucket.close = row.close; bucket.volume += row.volume; bucket.next += from; bucket.count++;
  }
  flush(); return out;
}
function lowerBound(rows, time) { let low = 0, high = rows.length; while (low < high) { const mid = (low + high) >> 1; if (rows[mid].time < time) low = mid + 1; else high = mid; } return low; }
// Series for one asset: m5 native, m15 and h1 from complete 5m buckets
// (the dataset's own policy for those frames), h4 from the venue's native 1h
// (NATIVE-HTF policy).  byTime indexes 5m bars for O(1) close lookups.
function buildSeries(m5, nativeH1 = null) {
  const h1 = nativeH1 && nativeH1.length ? nativeH1 : aggregate(m5, B, H1);
  return {m5, m15: aggregate(m5, B, M15), h1, h4: aggregate(h1, H1, H4), byTime: new Map(m5.map(row => [row.time, row]))};
}
// The last `count` bars that have CLOSED at or before T.  Fails closed (null)
// unless the last bar closes exactly at T and the window is contiguous.
function closedWindow(series, interval, T, count) {
  const end = lowerBound(series, T - interval + 1), bars = series.slice(Math.max(0, end - count), end);
  if (bars.length < count || bars.at(-1).time + interval !== T) return null;
  for (let i = 1; i < bars.length; i++) if (bars[i].time - bars[i - 1].time !== interval) return null;
  return bars;
}
// Close of the 5m bar that closes exactly at t.
const closeAt = (asset, t) => { const bar = asset?.byTime.get(t - B); return bar ? bar.close : null; };

function wilderAtr(bars, period = 14) {
  // Seed with the simple mean of the first `period` true ranges, then Wilder.
  const out = Array(bars.length).fill(null); let atr = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= period) { atr += tr / period; if (i === period) out[i] = atr; continue; }
    atr = (atr * (period - 1) + tr) / period; out[i] = atr;
  }
  return out;
}
const meanTrueRange = (bars, n) => { const list = []; for (let i = bars.length - n; i < bars.length; i++) if (i > 0) list.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close))); return mean(list); };

// ------------------------------------------------------------- structure ---
// Swing at i is known only at the close of bar i+k.  BOS is confirmed at the
// close of the first bar that closes beyond the most recent KNOWN, unbroken
// swing.  CHOCH is a BOS against the trend state in force just before it.
function structureEvents(bars, k) {
  const atr = wilderAtr(bars), events = []; let lastHigh = null, lastLow = null, trend = 0;
  const swings = [];
  for (let t = 0; t < bars.length; t++) {
    const i = t - k;
    if (i >= k) {
      let high = true, low = true;
      for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (!(bars[i].high > bars[j].high)) high = false; if (!(bars[i].low < bars[j].low)) low = false; }
      if (high) { lastHigh = {price: bars[i].high, index: i, knownAt: t, broken: false}; swings.push({type: 'high', ...lastHigh}); }
      if (low) { lastLow = {price: bars[i].low, index: i, knownAt: t, broken: false}; swings.push({type: 'low', ...lastLow}); }
    }
    const a = atr[t];
    if (lastHigh && !lastHigh.broken && bars[t].close > lastHigh.price) { events.push({dir: 1, index: t, level: lastHigh.price, strength: a ? (bars[t].close - lastHigh.price) / a : null, choch: trend === -1}); lastHigh.broken = true; trend = 1; }
    if (lastLow && !lastLow.broken && bars[t].close < lastLow.price) { events.push({dir: -1, index: t, level: lastLow.price, strength: a ? (lastLow.price - bars[t].close) / a : null, choch: trend === 1}); lastLow.broken = true; trend = -1; }
  }
  return {atr, events, swings, trend, lastHigh, lastLow};
}
function structureFrame(bars, k, s, price) {
  const {atr, events, trend, lastHigh, lastLow} = structureEvents(bars, k), n = bars.length, a = atr[n - 1];
  if (!a) return null;
  const bos = events.at(-1) || null, choch = [...events].reverse().find(e => e.choch) || null;
  let retest = 0;
  if (bos) for (let t = bos.index + 1; t < n; t++) {
    const bar = bars[t];
    if (bos.dir * (bar.close - bos.level) < 0) { retest = -1; break; }
    const touched = bos.dir > 0 ? bar.low <= bos.level + .25 * a : bar.high >= bos.level - .25 * a;
    if (touched) retest = 1;
  }
  const distances = [lastHigh, lastLow].filter(Boolean).map(level => Math.abs(price - level.price) / a);
  return {
    trend, events, atr: a,
    features: {
      trend_state: trend * s,
      swing_high_distance_atr: lastHigh ? (lastHigh.price - price) / a : null,
      swing_low_distance_atr: lastLow ? (price - lastLow.price) / a : null,
      bos_direction: bos ? bos.dir * s : 0,
      bars_since_bos: bos ? n - 1 - bos.index : null,
      bos_strength_atr: bos ? bos.strength : null,
      choch_direction: choch ? choch.dir * s : 0,
      bars_since_choch: choch ? n - 1 - choch.index : null,
      choch_strength_atr: choch ? choch.strength : null,
      break_retest_state: bos ? retest * bos.dir * s : 0,
      distance_to_structure_atr: distances.length ? Math.min(...distances) : null
    }
  };
}
// frames: {m15, h1, h4} closed windows (or null) for the candidate's asset.
function structureFamily(frames, direction, price) {
  const s = direction === 'long' ? 1 : -1, out = {}, trends = {};
  for (const name of ['m15', 'h1', 'h4']) {
    const bars = frames[name], frame = bars ? structureFrame(bars, SWING_K[name], s, price) : null;
    trends[name] = frame ? frame.trend : null;
    for (const [key, value] of Object.entries(frame?.features || structureFrame.EMPTY)) out[`${name}_${key}`] = frame ? value : null;
  }
  const align = (a, b) => a === null || b === null ? null : a !== 0 && a === b ? a * s : 0;
  out.structure_alignment_15m_1h = align(trends.m15, trends.h1);
  out.structure_alignment_1h_4h = align(trends.h1, trends.h4);
  return out;
}
structureFrame.EMPTY = Object.freeze({trend_state: null, swing_high_distance_atr: null, swing_low_distance_atr: null, bos_direction: null, bars_since_bos: null, bos_strength_atr: null, choch_direction: null, bars_since_choch: null, choch_strength_atr: null, break_retest_state: null, distance_to_structure_atr: null});

// ------------------------------------------------------------------- FVG ---
// Gap at i (3-candle) is known at the close of bar i.  Fill uses bars i+1..T.
function fvgFrame(bars, s, price) {
  const {atr, events, trend} = structureEvents(bars, SWING_K.h1), n = bars.length, a = atr[n - 1];
  if (!a) return null;
  const live = [];
  for (let i = Math.max(2, n - 100); i < n; i++) {
    let gap = null;
    if (bars[i].low > bars[i - 2].high) gap = {dir: 1, low: bars[i - 2].high, high: bars[i].low};
    else if (bars[i].high < bars[i - 2].low) gap = {dir: -1, low: bars[i].high, high: bars[i - 2].low};
    if (!gap) continue;
    const width = gap.high - gap.low; let fill = 0, touched = false;
    for (let j = i + 1; j < n; j++) {
      const depth = gap.dir > 0 ? (gap.high - bars[j].low) / width : (bars[j].high - gap.low) / width;
      if (depth > 0) touched = true; fill = Math.max(fill, clip(depth, 0, 1));
      if (fill >= 1) break;
    }
    if (fill >= 1) continue;
    const after = kind => events.some(e => e.dir === gap.dir && e.index <= i && e.index >= i - 3 && (kind === 'choch' ? e.choch : true));
    live.push({...gap, index: i, width, fill, touched, afterBos: after('bos'), afterChoch: after('choch')});
  }
  const counts = {fvg_live_aligned_count: live.filter(g => g.dir === s).length, fvg_live_opposing_count: live.filter(g => g.dir === -s).length};
  if (!live.length) return {...fvgFrame.EMPTY, ...counts};
  const distanceOf = g => price >= g.low && price <= g.high ? 0 : price > g.high ? price - g.high : g.low - price;
  const nearest = live.slice().sort((x, y) => distanceOf(x) - distanceOf(y) || y.index - x.index)[0], inside = distanceOf(nearest) === 0;
  const below = nearest.high < price, supportive = s > 0 ? below : nearest.low > price;
  return {
    fvg_direction: nearest.dir * s, fvg_width_atr: nearest.width / a, fvg_age_bars: n - 1 - nearest.index, fvg_fill_fraction: nearest.fill,
    distance_to_nearest_fvg_atr: inside ? 0 : (supportive ? 1 : -1) * distanceOf(nearest) / a,
    fvg_midpoint_distance_atr: s * (price - (nearest.low + nearest.high) / 2) / a,
    fvg_with_trend: trend !== 0 && nearest.dir === trend ? 1 : 0, fvg_after_bos: nearest.afterBos ? 1 : 0, fvg_after_choch: nearest.afterChoch ? 1 : 0,
    fvg_retest_state: inside ? 1 : nearest.touched ? .5 : 0, ...counts
  };
}
fvgFrame.EMPTY = Object.freeze({fvg_direction: 0, fvg_width_atr: null, fvg_age_bars: null, fvg_fill_fraction: null, distance_to_nearest_fvg_atr: null, fvg_midpoint_distance_atr: null, fvg_with_trend: 0, fvg_after_bos: 0, fvg_after_choch: 0, fvg_retest_state: 0});
function fvgFamily(frames, direction, price) {
  const s = direction === 'long' ? 1 : -1, out = {};
  for (const name of ['m15', 'h1']) {
    const bars = frames[name], frame = bars ? fvgFrame(bars, s, price) : null;
    for (const key of [...Object.keys(fvgFrame.EMPTY), 'fvg_live_aligned_count', 'fvg_live_opposing_count']) out[`${name}_${key}`] = frame ? frame[key] ?? null : null;
  }
  return out;
}

// ---------------------------------------------------------------- candle ---
function candleFrame(bars, s, price) {
  const atr = wilderAtr(bars), n = bars.length, a = atr[n - 1], bar = bars[n - 1], prev = bars[n - 2];
  if (!a || n < 101) return null;
  const range = bar.high - bar.low, body = bar.close - bar.open, prevBody = prev.close - prev.open;
  const upper = bar.high - Math.max(bar.open, bar.close), lower = Math.min(bar.open, bar.close) - bar.low;
  const ranges = bars.slice(-100).map(b => b.high - b.low), vols = bars.map(b => b.volume);
  const vol20 = mean(vols.slice(-21, -1)), vol50 = vols.slice(-51, -1), v50m = mean(vol50), v50s = std(vol50);
  const last50 = bars.slice(-50), low50 = Math.min(...last50.map(b => b.low)), high50 = Math.max(...last50.map(b => b.high));
  const slope = sign(bar.close - bars[n - 21].close), clv = range > 0 ? (bar.close - bar.low) / range : .5;
  const atr5 = meanTrueRange(bars, 5), atr50 = meanTrueRange(bars, 50);
  return {
    body_atr: s * body / a, upper_wick_atr: upper / a, lower_wick_atr: lower / a, range_atr: range / a,
    body_fraction: range > 0 ? Math.abs(body) / range : 0,
    close_location_value: s > 0 ? clv - .5 : .5 - clv,
    range_percentile: ranges.filter(r => r <= range).length / ranges.length,
    engulfing_strength: sign(body) && sign(prevBody) && sign(body) !== sign(prevBody) ? s * sign(body) * (Math.abs(body) - Math.abs(prevBody)) / a : 0,
    pinbar_strength: range > 0 ? s * (lower - upper) / range : 0,
    compression_score: atr50 ? atr5 / atr50 : null, expansion_score: range / a,
    relative_volume: vol20 ? bar.volume / vol20 : null, volume_zscore: v50s ? (bar.volume - v50m) / v50s : null,
    distance_to_support_atr: (s > 0 ? price - low50 : high50 - price) / a,
    distance_to_resistance_atr: (s > 0 ? high50 - price : price - low50) / a,
    candle_trend_alignment: s * (sign(body) + slope) / 2,
    confirmation_strength: s * bars.slice(-3).reduce((t, b) => t + b.close - b.open, 0) / a
  };
}
function candleFamily(frames, direction, price) {
  const s = direction === 'long' ? 1 : -1, out = {};
  for (const name of ['m15', 'h1']) { const frame = frames[name] ? candleFrame(frames[name], s, price) : null; for (const key of CANDLE_KEYS) out[`${name}_${key}`] = frame ? frame[key] : null; }
  return out;
}
const CANDLE_KEYS = Object.freeze(['body_atr', 'upper_wick_atr', 'lower_wick_atr', 'range_atr', 'body_fraction', 'close_location_value', 'range_percentile', 'engulfing_strength', 'pinbar_strength', 'compression_score', 'expansion_score', 'relative_volume', 'volume_zscore', 'distance_to_support_atr', 'distance_to_resistance_atr', 'candle_trend_alignment', 'confirmation_strength']);

// ---------------------------------------------------------- cross-market ---
// All windows end at T and use the same Coinbase spot 5m archive.  Any
// missing close inside a window nulls that feature (no fill).
function logReturns(asset, T, step, count) {
  const closes = []; for (let k = count; k >= 0; k--) { const c = closeAt(asset, T - k * step); if (!c) return null; closes.push(c); }
  return closes.slice(1).map((c, i) => Math.log(c / closes[i]));
}
const ret = (asset, T, ms) => { const now = closeAt(asset, T), then = closeAt(asset, T - ms); return now && then ? Math.log(now / then) * 100 : null; };
function crossMarketFamily(universe, assetName, direction, T) {
  const s = direction === 'long' ? 1 : -1, btc = universe.BTC, eth = universe.ETH, own = universe[assetName], signed = v => v === null ? null : s * v;
  const r24 = Object.fromEntries(ASSETS.map(name => [name, universe[name] ? ret(universe[name], T, DAY) : null]));
  const present = Object.values(r24).filter(v => v !== null);
  const btcR5 = logReturns(btc, T, B, 12), btcR288 = logReturns(btc, T, B, 288);
  const ownH = logReturns(own, T, H1, 168), btcH = logReturns(btc, T, H1, 168), ethH = logReturns(eth, T, H1, 168);
  let beta = null; if (ownH && btcH) { const v = std(btcH); beta = v ? corr(ownH, btcH) * std(ownH) / v : null; }
  const lead = (step, count) => { const a = logReturns(own, T, step, count), b = logReturns(btc, T, step, count + 1); return a && b ? corr(a, b.slice(0, -1)) : null; };
  const out = {
    btc_return_5m: signed(ret(btc, T, B)), btc_return_1h: signed(ret(btc, T, H1)), btc_return_4h: signed(ret(btc, T, H4)), btc_return_24h: signed(r24.BTC),
    btc_volatility_1h: btcR5 ? std(btcR5) * 100 : null, btc_volatility_24h: btcR288 ? std(btcR288) * 100 : null,
    eth_btc_relative_strength: r24.ETH !== null && r24.BTC !== null ? (assetName === 'ETH' ? s : 1) * (r24.ETH - r24.BTC) : null,
    asset_vs_btc_relative_strength: r24[assetName] !== null && r24.BTC !== null ? s * (r24[assetName] - r24.BTC) : null,
    asset_vs_market_residual_momentum: r24[assetName] !== null && r24.BTC !== null && beta !== null ? s * (r24[assetName] - beta * r24.BTC) : null,
    market_breadth: present.length >= 4 ? s * (present.filter(v => v > 0).length / present.length - .5) : null,
    cross_asset_dispersion: present.length >= 4 ? std(present) : null,
    rolling_corr_btc: ownH && btcH ? corr(ownH, btcH) : null, rolling_corr_eth: ownH && ethH ? corr(ownH, ethH) : null,
    btc_lead_lag_5m: lead(B, 288), btc_lead_lag_15m: lead(M15, 288)
  };
  return {features: out, assetsPresent: present.length};
}

// ----------------------------------------------------------- derivatives ---
// deriv: {funding: [{time, rate}], oi: [{time, oi}], premium: [{closeTime, close}]}
// sorted ascending.  Settlement / snapshot / bar-close time is when a value
// becomes known.  Freshness limits fail closed.
const FUNDING_MAX_AGE = 9 * H1, OI_MAX_AGE = 30 * 60_000, OI_LAG = B, PREMIUM_MAX_AGE = H1;
function lastAtOrBefore(series, key, t) { let low = 0, high = series.length - 1, found = -1; while (low <= high) { const mid = (low + high) >> 1; if (series[mid][key] <= t) { found = mid; low = mid + 1; } else high = mid - 1; } return found; }
function derivativesFamily(deriv, direction, T, price4hReturn) {
  const s = direction === 'long' ? 1 : -1, out = {}, source = {};
  const f = deriv?.funding || [], fi = lastAtOrBefore(f, 'time', T);
  if (fi >= 0 && T - f[fi].time <= FUNDING_MAX_AGE) {
    const window = f.slice(0, fi + 1).filter(x => x.time > T - 30 * DAY).map(x => x.rate), dev = std(window), last = f[fi].rate;
    out.funding_rate = s * last * 1e4; out.funding_zscore = dev ? s * (last - mean(window)) / dev : null;
    out.funding_change = fi > 0 ? s * (last - f[fi - 1].rate) * 1e4 : null; out.funding_extreme_flag = dev ? (Math.abs((last - mean(window)) / dev) > 2 ? 1 : 0) : null;
    source.funding = f[fi].time;
  } else Object.assign(out, {funding_rate: null, funding_zscore: null, funding_change: null, funding_extreme_flag: null});
  const oi = deriv?.oi || [], known = T - OI_LAG, oiIndex = lastAtOrBefore(oi, 'time', known);
  const oiAt = t => { const i = lastAtOrBefore(oi, 'time', t); return i >= 0 && t - oi[i].time <= OI_MAX_AGE ? oi[i].oi : null; };
  if (oiIndex >= 0 && known - oi[oiIndex].time <= OI_MAX_AGE) {
    const now = oi[oiIndex].oi, anchor = oi[oiIndex].time, change = ms => { const then = oiAt(anchor - ms); return then ? (now / then - 1) * 100 : null; };
    out.oi_change_5m = change(B); out.oi_change_1h = change(H1); out.oi_change_4h = change(H4);
    out.price_oi_divergence = out.oi_change_4h !== null && price4hReturn !== null ? s * price4hReturn * sign(out.oi_change_4h) : null;
    out.oi_expansion_state = out.oi_change_4h === null ? null : out.oi_change_4h > 2 ? 1 : 0; out.oi_contraction_state = out.oi_change_4h === null ? null : out.oi_change_4h < -2 ? 1 : 0;
    source.oi = anchor;
  } else Object.assign(out, {oi_change_5m: null, oi_change_1h: null, oi_change_4h: null, price_oi_divergence: null, oi_expansion_state: null, oi_contraction_state: null});
  const p = deriv?.premium || [], pi = lastAtOrBefore(p, 'closeTime', T);
  if (pi >= 0 && T - p[pi].closeTime < PREMIUM_MAX_AGE) {
    out.mark_spot_basis_bps = s * p[pi].close * 1e4;
    const then = lastAtOrBefore(p, 'closeTime', p[pi].closeTime - DAY);
    out.basis_change = then >= 0 && p[pi].closeTime - DAY - p[then].closeTime < PREMIUM_MAX_AGE ? s * (p[pi].close - p[then].close) * 1e4 : null;
    source.premium = p[pi].closeTime;
  } else Object.assign(out, {mark_spot_basis_bps: null, basis_change: null});
  return {features: out, sourceTimes: source};
}

// ----------------------------------------------------------------- driver --
// universe: {ASSET: buildSeries(...)}; derivatives: {ASSET: {...}} or null.
// Returns {FR_*: {feature: value}} plus a provenance record per family.
function computeFamilies(row, universe, derivatives = null, meta = {}) {
  const T = row.timestamp, asset = universe[row.asset], out = {}, provenance = {};
  const price = closeAt(asset, T);
  const frames = asset ? {m15: closedWindow(asset.m15, M15, T, LOOKBACK), h1: closedWindow(asset.h1, H1, T, LOOKBACK), h4: closedWindow(asset.h4, H4, T, LOOKBACK)} : {m15: null, h1: null, h4: null};
  const base = {provider: 'COINBASE_EXCHANGE', venue: 'COINBASE', instrument: asset ? `${row.asset}-USD` : null, instrument_type: 'SPOT', dataset_version: meta.datasetVersion || null, source_version: meta.archiveVersion || null, retrieval: meta.retrieval || null, feature_window_end: T};
  const stamp = (family, sourceTime, extra = {}) => { provenance[family] = {...base, ...extra, normalization_version: VERSIONS[family], source_timestamp: sourceTime ?? null, freshness_ms: sourceTime === null || sourceTime === undefined ? null : T - sourceTime}; };
  const frameEnd = name => frames[name] ? frames[name].at(-1).time + ({m15: M15, h1: H1, h4: H4})[name] : null;
  if (price === null) { for (const family of FR_FAMILIES) { out[family] = {}; stamp(family, null, {status: 'NO_PRICE_AT_SCAN'}); } return {families: out, provenance}; }
  out.FR_STRUCTURE = structureFamily(frames, row.direction, price); stamp('FR_STRUCTURE', frameEnd('h1'), {frames: {m15: frameEnd('m15'), h1: frameEnd('h1'), h4: frameEnd('h4')}});
  out.FR_FVG = fvgFamily(frames, row.direction, price); stamp('FR_FVG', frameEnd('h1'));
  out.FR_CANDLE = candleFamily(frames, row.direction, price); stamp('FR_CANDLE', frameEnd('m15'));
  const xm = crossMarketFamily(universe, row.asset, row.direction, T); out.FR_CROSS_MARKET = xm.features; stamp('FR_CROSS_MARKET', T, {instrument: ASSETS.map(a => `${a}-USD`).join(','), assets_present: xm.assetsPresent});
  if (derivatives) {
    const d = derivativesFamily(derivatives[row.asset], row.direction, T, ret(asset, T, H4)); out.FR_DERIVATIVES = d.features;
    const times = Object.values(d.sourceTimes);
    stamp('FR_DERIVATIVES', times.length ? Math.min(...times) : null, {provider: meta.derivativesProvider || 'BINANCE_PUBLIC_DATA', venue: 'BINANCE_USDM', instrument: `${row.asset}USDT`, instrument_type: 'PERPETUAL', source_times: d.sourceTimes});
  } else { out.FR_DERIVATIVES = {}; stamp('FR_DERIVATIVES', null, {status: 'DERIVATIVES_NOT_LOADED'}); }
  return {families: out, provenance};
}

module.exports = {VERSIONS, FR_FAMILIES, ASSETS, SWING_K, LOOKBACK, B, M15, H1, H4, DAY, aggregate, buildSeries, closedWindow, closeAt, wilderAtr, structureEvents, structureFrame, structureFamily, fvgFrame, fvgFamily, candleFrame, candleFamily, crossMarketFamily, derivativesFamily, computeFamilies, logReturns, corr, lastAtOrBefore};
