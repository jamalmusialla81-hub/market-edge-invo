'use strict';

// Dataset expansion v1 (research only).  Pure, outcome-aware-where-stated
// helpers for PREREGISTRATION.md: the universe screen, usability, the
// outcome-free diversity-value check, OLD vs EXPANDED diversity metrics,
// redundancy flags, regimes and scan-level power.  Nothing here selects a
// model, a feature, a threshold, a label or a horizon.

const Clean = require('../historical-rank-v2-clean.js');
const Rank = require('../historical-rank.js');
const V2 = require('../rank-research-v2.js');

const EXPANDED_VERSION = `${Clean.NATIVE_HTF_VERSION}-EXPANDED`;
const OLD_VERSION = Clean.NATIVE_HTF_VERSION;
const OLD_ASSETS = Object.freeze(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC']);
const B = 300_000, DAY = 86_400_000;
// Identical to the committed candle manifest window.
const WINDOW = Object.freeze({from: '2021-09-01T00:00:00Z', to: '2026-09-27T00:00:00Z', fromMs: Date.UTC(2021, 8, 1), toMs: Date.UTC(2026, 8, 27)});
const SCREEN = Object.freeze({
  excludedBases: ['USDT', 'USDC', 'DAI', 'PYUSD', 'GUSD', 'EURC', 'PAX', 'PAXG', 'XAUT', 'TUSD', 'BUSD', 'USDS', 'RLUSD', 'FDUSD', 'USD1', 'WBTC', 'CBBTC', 'CBETH', 'WETH', 'STETH', 'WSTETH', 'LSETH', 'RETH', 'MSOL', 'JITOSOL'],
  minPriceCv: .05, lookbackDays: 261, minEligibleDevDays: 365, minDailyCoverage: .99, minMedianNotionalUsd: 5e6, lowNotionalUsd: 5e5, maxLowNotionalShare: .05, maxAbsLogReturn: Math.log(3), maxOpenGap: .5, fetchCap: 40
});
const USABLE = Object.freeze({min5mCoverage: .99, min1hCoverage: .99});
const MIN_DEV_CANDIDATES = 30;

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const mean = list => { const xs = list.filter(Number.isFinite); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
const sd = list => { const xs = list.filter(Number.isFinite); if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((t, v) => t + (v - m) ** 2, 0) / (xs.length - 1)); };
function quantile(values, q) { const s = values.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); }
const median = values => quantile(values, .5);
const countBy = (items, key) => { const out = {}; for (const item of items) { const k = String(key(item)); out[k] = (out[k] || 0) + 1; } return out; };
const share = (items, test) => items.length ? items.filter(test).length / items.length : null;
function corr(a, b) { const n = Math.min(a.length, b.length); if (n < 5) return null; const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return va && vb ? c / Math.sqrt(va * vb) : null; }

function scanGrid() {
  const firstScan = Math.ceil((WINDOW.fromMs + Clean.HISTORY_MS + DAY) / DAY) * DAY, lastScan = Math.floor((WINDOW.toMs - Rank.OUTCOME_BARS * B - B) / DAY) * DAY;
  return {firstScan, lastScan};
}
const scanId = timestamp => `hrp-${EXPANDED_VERSION}-${DAY}-${timestamp}`;

// --------------------------------------------------------- Phase 2 screen --
// product: Coinbase /products entry; daily: [{time, open, high, low, close, volume}] native daily.
function screenProduct(product, daily, {devCutoffMs = V2.HOLDOUT.devCutoffMs} = {}) {
  const base = String(product.base_currency || '').toUpperCase(), rows = daily.filter(row => row.time >= WINDOW.fromMs && row.time + DAY <= devCutoffMs).sort((a, b) => a.time - b.time);
  const first = rows[0]?.time ?? null, eligibleDevDays = first === null ? 0 : Math.floor((devCutoffMs - first) / DAY) - SCREEN.lookbackDays;
  const expectedDays = first === null ? 0 : Math.floor((devCutoffMs - first) / DAY), coverage = expectedDays ? rows.length / expectedDays : 0;
  const notional = rows.map(row => row.volume * row.close), closes = rows.map(row => row.close), cv = closes.length > 1 ? sd(closes) / mean(closes) : 0;
  const logReturns = rows.slice(1).map((row, i) => Math.abs(Math.log(row.close / rows[i].close)));
  const openGapList = []; for (let i = 1; i < rows.length; i++) if (rows[i].time - rows[i - 1].time === DAY) openGapList.push(Math.abs(rows[i].open / rows[i - 1].close - 1));
  const checks = {
    S1_activeSpot: product.quote_currency === 'USD' && product.status === 'online' && !product.trading_disabled && !product.cancel_only && !product.limit_only && !product.post_only && !product.auction_mode,
    S2_notPeggedOrWrapped: !SCREEN.excludedBases.includes(base) && !base.includes('USD') && !product.fx_stablecoin && cv >= SCREEN.minPriceCv,
    S3_history: eligibleDevDays >= SCREEN.minEligibleDevDays,
    S4_dailyCoverage: coverage >= SCREEN.minDailyCoverage,
    S5_liquidity: (median(notional) ?? 0) >= SCREEN.minMedianNotionalUsd && (share(notional, v => v < SCREEN.lowNotionalUsd) ?? 1) <= SCREEN.maxLowNotionalShare,
    S6_noStructuralBreak: logReturns.every(v => v <= SCREEN.maxAbsLogReturn) && openGapList.every(v => v <= SCREEN.maxOpenGap)
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {symbol: base, product: product.id, firstValidDate: first === null ? null : new Date(first).toISOString().slice(0, 10), lastValidDate: rows.at(-1) ? new Date(rows.at(-1).time).toISOString().slice(0, 10) : null, eligibleDevDays, dailyCoverage: coverage, medianDailyNotionalUsd: median(notional), lowNotionalDayShare: share(notional, v => v < SCREEN.lowNotionalUsd), priceCv: cv, maxAbsDailyLogReturn: logReturns.length ? Math.max(...logReturns) : null, maxOpenGap: openGapList.length ? Math.max(...openGapList) : null, listedBeforeWindow: first === WINDOW.fromMs, checks, failed, pass: failed.length === 0};
}
function shortlist(screened) { return screened.filter(s => s.pass).sort((a, b) => b.medianDailyNotionalUsd - a.medianDailyNotionalUsd).slice(0, SCREEN.fetchCap); }

// ---------------------------------------------------- Phase 2 usability ----
// entry: fetch-coinbase-candles manifest asset entry.
function usability(entry) {
  const firstMs = entry.first ? Date.parse(entry.first) : null, toMs = Date.parse(entry.to);
  const expected5m = firstMs === null ? 0 : (toMs - firstMs) / B, cov5m = expected5m ? entry.present / expected5m : 0;
  const h1 = entry.native?.['1h'] || {}, expected1h = firstMs === null ? 0 : Math.ceil((toMs - firstMs) / 3_600_000), cov1h = expected1h ? h1.present / expected1h : 0;
  const d1 = entry.native?.['1d'] || {}, expected1d = firstMs === null ? 0 : Math.ceil((toMs - firstMs) / DAY), cov1d = expected1d ? d1.present / expected1d : 0;
  const i = entry.issues || {}, invalid = (i.invalidOhlc || 0) + (i.conflictingDuplicates || 0) + (i.future || 0);
  const months = entry.months || [], missingMonths = months.filter(m => m.start >= (firstMs ?? Infinity) && m.coverage < .95).map(m => m.month);
  const checks = {F1_5mCoverage: cov5m >= USABLE.min5mCoverage, F2_noInvalidDuplicateFuture: invalid === 0 && (i.duplicates || 0) === 0 && (h1.issues?.future || 0) === 0 && (d1.issues?.future || 0) === 0, F3_1hCoverage: cov1h >= USABLE.min1hCoverage};
  return {coverage5m: cov5m, coverage1h: cov1h, coverage1d: cov1d, missingMonths, majorGaps: (entry.missingPeriodsOver1h || []).filter(p => p.hours >= 6 && Date.parse(p.from) >= (firstMs ?? 0)).map(p => `${p.from.slice(0, 16)} ${p.hours.toFixed(1)}h`), issues: i, checks, failed: Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k), usable: Object.values(checks).every(Boolean)};
}

// ------------------------------------------ Phase 4 diversity value (no R) --
// rows: development candidate rows WITHOUT labels; only asset/direction/strategy/timestamp used.
function diversityValue(rows, newAssets, oldAssets = OLD_ASSETS) {
  const byScan = new Map(); for (const row of rows) { const list = byScan.get(row.timestamp) || []; list.push(row); byScan.set(row.timestamp, list); }
  const out = {};
  for (const asset of newAssets) {
    const mine = rows.filter(row => row.asset === asset), scans = [...new Set(mine.map(row => row.timestamp))];
    let newChoice = 0, createsScan = 0, turnsIntoChoice = 0, newDirection = 0, newStrategy = 0, sameDirOverlap = 0, anyOldOverlap = 0;
    for (const ts of scans) {
      const all = byScan.get(ts), old = all.filter(row => oldAssets.includes(row.asset)), own = all.filter(row => row.asset === asset);
      // A new choice needs a choice to exist (>= 2 candidates) and the asset to
      // add something: the second option, or a direction / strategy absent among the old six.
      const isChoice = old.length + own.length >= 2, a = old.length <= 1 && isChoice, d = old.length > 0 && own.some(r => !old.some(o => o.direction === r.direction)), s = old.length > 0 && own.some(r => !old.some(o => o.strategy === r.strategy));
      if (!old.length) createsScan++; if (a) turnsIntoChoice++; if (d) newDirection++; if (s) newStrategy++; if (isChoice && (a || d || s)) newChoice++;
      if (old.length) anyOldOverlap++; if (own.some(r => old.some(o => o.direction === r.direction))) sameDirOverlap++;
    }
    out[asset] = {candidates: mine.length, candidateScans: scans.length, newChoiceScans: newChoice, newChoiceShare: scans.length ? newChoice / scans.length : null, scansWithNoOldCandidate: createsScan, turnsIntoChoice, addsNewDirection: newDirection, addsNewStrategy: newStrategy, overlapWithOldAnyCandidate: share(scans, ts => byScan.get(ts).some(r => oldAssets.includes(r.asset))), overlapWithOldSameDirection: scans.length ? sameDirOverlap / scans.length : null, directions: countBy(mine, r => r.direction), strategies: countBy(mine, r => r.strategy)};
  }
  return out;
}

// ------------------------------------------------- Phase 7/8 diversity -----
// rows: parsed development rows (V2.parseRows output), outcomes used only for
// the outcome-correlation / dispersion lines.
const R = row => finite(row.targets.FINAL_R);
function groups(rows) { return V2.groupByScan(rows); }
function diversityMetrics(rows) {
  const all = groups(rows), choice = all.filter(g => g.length >= 2), sizes = choice.map(g => g.length);
  const top2 = choice.map(g => g.slice().sort((a, b) => b.quant_score - a.quant_score || String(a.candidate_id).localeCompare(String(b.candidate_id))).slice(0, 2));
  const pairs = [], sameDir = [];
  for (const g of choice) for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) { if (g[a].asset === g[b].asset) continue; pairs.push([R(g[a]), R(g[b])]); if (g[a].direction === g[b].direction) sameDir.push([R(g[a]), R(g[b])]); }
  const pc = list => corr(list.map(p => p[0]), list.map(p => p[1]));
  let between = 0, within = 0; const gm = mean(choice.flat().map(R)); for (const g of choice) { const m = mean(g.map(R)); for (const row of g) { between += (m - gm) ** 2; within += (R(row) - m) ** 2; } }
  return {
    developmentScans: all.length, choiceScans: choice.length, candidates: rows.length, candidatesInChoiceScans: sizes.reduce((a, b) => a + b, 0), assets: countBy(rows, r => r.asset),
    candidatesPerChoiceScan: {median: median(sizes), p25: quantile(sizes, .25), p75: quantile(sizes, .75), max: sizes.length ? Math.max(...sizes) : null, mean: mean(sizes), histogram: countBy(sizes, v => v >= 8 ? '8+' : v), shareExactly2: share(sizes, v => v === 2)},
    assetsPerChoiceScan: {mean: mean(choice.map(g => new Set(g.map(r => r.asset)).size)), median: median(choice.map(g => new Set(g.map(r => r.asset)).size))},
    directionsPerChoiceScan: {mean: mean(choice.map(g => new Set(g.map(r => r.direction)).size)), shareBothDirections: share(choice, g => new Set(g.map(r => r.direction)).size === 2)},
    strategiesPerChoiceScan: {mean: mean(choice.map(g => new Set(g.map(r => r.strategy)).size)), shareOneStrategyOnly: share(choice, g => new Set(g.map(r => r.strategy)).size === 1)},
    top2: {sameDirection: share(top2, ([a, b]) => a.direction === b.direction), sameAsset: share(top2, ([a, b]) => a.asset === b.asset), sameStrategy: share(top2, ([a, b]) => a.strategy === b.strategy)},
    withinScanOutcomeCorrelation: {crossAssetAllPairs: {pairs: pairs.length, correlation: pc(pairs)}, crossAssetSameDirection: {pairs: sameDir.length, correlation: pc(sameDir)}, betweenScanVarianceShare: between + within ? between / (between + within) : null},
    withinScanOutcomeDispersion: {medianSd: median(choice.map(g => sd(g.map(R)))), medianRange: median(choice.map(g => Math.max(...g.map(R)) - Math.min(...g.map(R))))}
  };
}

// ------------------------------------------------ Phase 9 redundancy -------
// dailyByAsset: {asset: [[time, close, volume], ...]} native daily (development window).
function logReturnMap(series) { const out = new Map(); for (let i = 1; i < series.length; i++) if (series[i][0] - series[i - 1][0] === DAY) out.set(series[i][0], Math.log(series[i][1] / series[i - 1][1])); return out; }
function redundancy(rows, dailyByAsset, assets, {devCutoffMs = V2.HOLDOUT.devCutoffMs} = {}) {
  const ret = Object.fromEntries(assets.map(a => [a, logReturnMap((dailyByAsset[a] || []).filter(r => r[0] + DAY <= devCutoffMs))]));
  const activation = Object.fromEntries(assets.map(a => [a, new Set(rows.filter(r => r.asset === a).map(r => r.timestamp))]));
  const byScan = groups(rows), pair = {};
  for (const a of assets) for (const b of assets) { if (a >= b) continue; pair[`${a}|${b}`] = {any: [], same: []}; }
  for (const g of byScan) for (let i = 0; i < g.length; i++) for (let k = i + 1; k < g.length; k++) { const [x, y] = [g[i], g[k]].sort((p, q) => p.asset < q.asset ? -1 : 1); if (x.asset === y.asset) continue; const p = pair[`${x.asset}|${y.asset}`]; if (!p) continue; p.any.push([R(x), R(y)]); if (x.direction === y.direction) p.same.push([R(x), R(y)]); }
  const matrix = {};
  for (const [key, p] of Object.entries(pair)) {
    const [a, b] = key.split('|'), days = [...ret[a].keys()].filter(t => ret[b].has(t)), inter = [...activation[a]].filter(t => activation[b].has(t)).length, union = new Set([...activation[a], ...activation[b]]).size;
    matrix[key] = {dailyReturnCorr: corr(days.map(t => ret[a].get(t)), days.map(t => ret[b].get(t))), overlapDays: days.length, candidateOutcomeCorr: p.any.length >= 20 ? corr(p.any.map(v => v[0]), p.any.map(v => v[1])) : null, candidatePairs: p.any.length, sameDirectionOutcomeCorr: p.same.length >= 20 ? corr(p.same.map(v => v[0]), p.same.map(v => v[1])) : null, sameDirectionPairs: p.same.length, activationJaccard: union ? inter / union : null};
  }
  const get = (a, b) => matrix[a < b ? `${a}|${b}` : `${b}|${a}`];
  const perAsset = {};
  for (const a of assets) {
    const others = assets.filter(b => b !== a).map(b => ({asset: b, ...get(a, b)}));
    const nearest = others.filter(o => o.dailyReturnCorr !== null).sort((x, y) => y.dailyReturnCorr - x.dailyReturnCorr)[0] || null;
    const maxSameDir = others.filter(o => o.sameDirectionOutcomeCorr !== null).sort((x, y) => y.sameDirectionOutcomeCorr - x.sameDirectionOutcomeCorr)[0] || null;
    const dc = nearest?.dailyReturnCorr ?? 0, nearestSame = nearest?.sameDirectionOutcomeCorr ?? null, anySame = maxSameDir?.sameDirectionOutcomeCorr ?? 0;
    const level = dc >= .85 && (nearestSame ?? 0) >= .5 ? 'HIGH' : dc >= .75 || anySame >= .4 ? 'MEDIUM' : 'LOW';
    perAsset[a] = {level, nearestByDailyReturn: nearest ? {asset: nearest.asset, dailyReturnCorr: nearest.dailyReturnCorr, sameDirectionOutcomeCorr: nearestSame, activationJaccard: nearest.activationJaccard} : null, maxSameDirectionOutcomeCorr: maxSameDir ? {asset: maxSameDir.asset, corr: maxSameDir.sameDirectionOutcomeCorr, pairs: maxSameDir.sameDirectionPairs} : null, meanDailyReturnCorr: mean(others.map(o => o.dailyReturnCorr)), meanActivationJaccard: mean(others.map(o => o.activationJaccard))};
  }
  return {perAsset, pairs: matrix, clusters: clusterByDailyCorr(assets, (a, b) => get(a, b)?.dailyReturnCorr ?? 0)};
}
// Average-linkage agglomerative clustering on 1 - daily return correlation,
// cut at distance 0.2 (correlation 0.8).  Descriptive grouping only.
function clusterByDailyCorr(assets, corrOf, cut = .2) {
  let clusters = assets.map(a => [a]);
  const dist = (x, y) => mean(x.flatMap(a => y.map(b => 1 - corrOf(a, b))));
  for (;;) { let best = null; for (let i = 0; i < clusters.length; i++) for (let k = i + 1; k < clusters.length; k++) { const d = dist(clusters[i], clusters[k]); if (!best || d < best.d) best = {i, k, d}; } if (!best || best.d > cut) break; clusters = clusters.filter((_, j) => j !== best.i && j !== best.k).concat([[...clusters[best.i], ...clusters[best.k]]]); }
  return clusters.sort((a, b) => b.length - a.length);
}

// ------------------------------------------------ Phase 10 regimes ---------
// btcDaily: [[time, close, volume]] native daily.  Point-in-time: only bars
// that closed at or before the scan timestamp are used.
function regimeClassifier(btcDaily, devTimestamps) {
  const closes = btcDaily.slice().sort((a, b) => a[0] - b[0]), times = closes.map(r => r[0]);
  const upTo = ts => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] + DAY <= ts) lo = m + 1; else hi = m; } return lo; };   // count of closed bars
  const state = ts => { const n = upTo(ts); if (n < 61) return null; const r60 = Math.log(closes[n - 1][1] / closes[n - 61][1]); const rets = []; for (let i = n - 30; i < n; i++) rets.push(Math.log(closes[i][1] / closes[i - 1][1])); return {r60, vol30: sd(rets)}; };
  const volMedian = median(devTimestamps.map(ts => state(ts)?.vol30).filter(Number.isFinite));
  return ts => { const s = state(ts); if (!s) return {trend: 'UNKNOWN', vol: 'UNKNOWN'}; return {trend: s.r60 > .15 ? 'BULL' : s.r60 < -.15 ? 'BEAR' : 'SIDEWAYS', vol: s.vol30 > volMedian ? 'HIGH_VOL' : 'LOW_VOL', r60: s.r60, vol30: s.vol30, volMedian}; };
}
function temporal(rows, regimeOf) {
  const choice = groups(rows).filter(g => g.length >= 2), all = groups(rows), q = ts => { const d = new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
  const tag = g => ({ts: g[0].timestamp, ...regimeOf(g[0].timestamp)});
  const c = choice.map(tag), a = all.map(tag);
  return {choiceScansByYear: countBy(c, x => new Date(x.ts).getUTCFullYear()), choiceScansByQuarter: countBy(c, x => q(x.ts)), choiceScansByTrend: countBy(c, x => x.trend), choiceScansByVol: countBy(c, x => x.vol), choiceScansByTrendVol: countBy(c, x => `${x.trend}/${x.vol}`), scansByTrend: countBy(a, x => x.trend), scansByVol: countBy(a, x => x.vol)};
}

// ------------------------------------------------ Phase 13 power -----------
function power(pairedDeltaSeries, achievedOosChoiceScans, effects = [.02, .04, .06, .08]) {
  const sigma = sd(pairedDeltaSeries), n = pairedDeltaSeries.length, m = mean(pairedDeltaSeries);
  let rho1 = 0; if (n > 20) { let c = 0, v = 0; for (let i = 0; i < n; i++) { v += (pairedDeltaSeries[i] - m) ** 2; if (i) c += (pairedDeltaSeries[i] - m) * (pairedDeltaSeries[i - 1] - m); } rho1 = v ? c / v : 0; }
  const inflation = rho1 > 0 ? (1 + rho1) / (1 - rho1) : 1, s2 = sigma * sigma * inflation;
  return {sigmaPerScan: sigma, lag1Autocorrelation: rho1, varianceInflation: inflation, achievedOosChoiceScans, effects: Object.fromEntries(effects.map(d => { const ci = Math.ceil(1.96 ** 2 * s2 / (d * d)), p80 = Math.ceil((1.96 + .8416) ** 2 * s2 / (d * d)); return [`+${d.toFixed(2)}R`, {scansForCiExcludingZero: ci, scansFor80Power: p80, achievedFractionCi: achievedOosChoiceScans / ci, achievedFraction80: achievedOosChoiceScans / p80}]; }))};
}

module.exports = {EXPANDED_VERSION, OLD_VERSION, OLD_ASSETS, WINDOW, SCREEN, USABLE, MIN_DEV_CANDIDATES, scanGrid, scanId, screenProduct, shortlist, usability, diversityValue, diversityMetrics, redundancy, clusterByDailyCorr, regimeClassifier, temporal, power, countBy, corr, median, quantile, mean, sd};
