'use strict';

// Feature-research diagnostics (Phases 11-15).  Pure functions over
// development rows and OOS scores.  Nothing here selects a model, a label, a
// horizon or a threshold: it only describes.

const V2 = require('../rank-research-v2.js');
const B = 300_000, HOUR = 3_600_000;

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const mean = list => { const xs = list.filter(Number.isFinite); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
const sd = list => { const xs = list.filter(Number.isFinite); if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((t, v) => t + (v - m) ** 2, 0) / (xs.length - 1)); };
function median(values) { const s = values.filter(Number.isFinite).sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; }
const countBy = (items, key) => { const out = {}; for (const item of items) { const k = String(key(item)); out[k] = (out[k] || 0) + 1; } return out; };
const share = (items, test) => items.length ? items.filter(test).length / items.length : null;
function byScan(rows, scores) { const map = new Map(); rows.forEach((row, i) => { const list = map.get(row.scan_id) || []; list.push({row, score: scores ? scores[i] : 0}); map.set(row.scan_id, list); }); return [...map.values()]; }
const R = row => finite(row.targets.FINAL_R);

// ---------------------------------------------------- paired feature value --
// picks: V2.picks() output.  Paired per scan, identical OOS scans required.
function pairedDelta(armPicks, basePicks, {folds = null} = {}) {
  const base = new Map(basePicks.map(p => [p.scan_id, p])), pairs = armPicks.filter(p => base.has(p.scan_id)).map(p => ({scan_id: p.scan_id, timestamp: p.timestamp, delta: p.r - base.get(p.scan_id).r, asset: p.row.asset, direction: p.row.direction, strategy: p.row.strategy, choices: p.choices}));
  if (pairs.length !== armPicks.length || pairs.length !== basePicks.length) throw new Error('PAIRING_MISMATCH: arm and base were not evaluated on identical OOS scans');
  const series = pairs.map(p => p.delta), ci = V2.blockBootstrap(series, {seed: 29});
  const group = key => Object.fromEntries(Object.entries(Object.groupBy(pairs, key)).map(([k, list]) => [k, {n: list.length, meanDelta: mean(list.map(p => p.delta))}]));
  const assets = [...new Set(pairs.map(p => p.asset))], leaveOneAssetOut = Object.fromEntries(assets.map(a => [a, mean(pairs.filter(p => p.asset !== a).map(p => p.delta))]));
  const foldDelta = folds ? folds.map(f => ({fold: f.fold, meanDelta: mean(pairs.filter(p => p.timestamp >= f.startMs && p.timestamp <= f.endMs).map(p => p.delta))})) : null;
  return {n: pairs.length, choiceScans: pairs.filter(p => p.choices >= 2).length, changedPicks: pairs.filter(p => p.delta !== 0).length, meanDelta: mean(series), ci95: [ci.low, ci.high], bootstrapWinPct: ci.pPositive === null ? null : ci.pPositive * 100, folds: foldDelta, foldsPositive: foldDelta ? foldDelta.filter(f => f.meanDelta > 0).length : null, byAssetOfArmPick: group(p => p.asset), byDirection: group(p => p.direction), byStrategy: group(p => p.strategy), leaveOneAssetOut};
}
// Pre-registered classification (PREREGISTRATION.md §2).
// Amendment A1: placebo p (regression model) gates RETAIN (<= .05) and
// PROMISING (<= .20); a family that fails it is downgraded one level.
const LEVELS = ['NO EVIDENCE', 'WEAK SIGNAL', 'PROMISING', 'RETAIN'];
function classify({reg, rank, pairAccDrop, maxSplitShare, leakagePass, placeboP = null}) {
  const bothPositive = reg.meanDelta > 0 && rank.meanDelta > 0, looPositive = Object.values(reg.leaveOneAssetOut).every(v => v > 0);
  const checks = {bothModelsPositive: bothPositive, winPct90: reg.bootstrapWinPct >= 90, folds4of5: reg.foldsPositive >= 4, leaveOneAssetOutAllPositive: looPositive, pairAccuracyNotDegraded: pairAccDrop <= .01, noFeatureDominance: maxSplitShare <= .4, leakagePass};
  let original = 'NO EVIDENCE';
  if (Object.values(checks).every(Boolean)) original = 'RETAIN';
  else if (bothPositive && reg.bootstrapWinPct >= 75 && reg.foldsPositive >= 3) original = 'PROMISING';
  else if ((reg.meanDelta > 0 && reg.bootstrapWinPct >= 60) || (rank.meanDelta > 0 && rank.bootstrapWinPct >= 60)) original = 'WEAK SIGNAL';
  let classification = original;
  // Step down until the level's own placebo requirement holds.
  while (placeboP !== null && ((classification === 'RETAIN' && placeboP > .05) || (classification === 'PROMISING' && placeboP > .2))) classification = LEVELS[LEVELS.indexOf(classification) - 1];
  return {classification, beforePlacebo: original, placeboP, checks};
}

// --------------------------------------------------- rank monotonicity ------
function rankPositions(rows, scores, {cost = .0016} = {}) {
  const buckets = {'#1': [], '#2': [], '#3': [], '#4': [], '#5+': []};
  for (const list of byScan(rows, scores)) {
    if (list.length < 2) continue;
    list.slice().sort((a, b) => b.score - a.score || String(a.row.candidate_id).localeCompare(String(b.row.candidate_id))).forEach((item, i) => buckets[i < 4 ? `#${i + 1}` : '#5+'].push(item.row));
  }
  const out = Object.fromEntries(Object.entries(buckets).map(([k, list]) => [k, {n: list.length, meanR: mean(list.map(row => V2.costR(row, cost))), tp1Rate: mean(list.map(row => row.targets.TP1_BEFORE_SL ? 1 : 0)), stopRate: mean(list.map(row => row.targets.STOP_HIT ? 1 : 0))}]));
  const order = ['#1', '#2', '#3', '#4', '#5+'].filter(k => out[k].n >= 10).map(k => out[k].meanR), steps = order.slice(1).map((v, i) => order[i] - v);
  const flag = steps.length && steps.every(d => d > 0) ? 'MONOTONIC' : steps.length && out['#1'].meanR > mean(order.slice(1)) && steps.filter(d => d > 0).length >= steps.length / 2 ? 'WEAKLY MONOTONIC' : 'NON-MONOTONIC';
  return {buckets: out, flag};
}
function monotonicityDiagnosis(rows, models) {
  const scans = byScan(rows).filter(list => list.length >= 2), outcomes = scans.map(list => list.map(item => R(item.row)));
  const disp = outcomes.map(list => ({sd: sd(list), range: Math.max(...list) - Math.min(...list)}));
  // #1 vs #2 by each model's own ranking.
  const topTwoGap = scores => byScan(rows, scores).filter(l => l.length >= 2).map(l => { const s = l.slice().sort((a, b) => b.score - a.score || String(a.row.candidate_id).localeCompare(String(b.row.candidate_id))); return Math.abs(R(s[0].row) - R(s[1].row)); });
  const perModel = {};
  for (const [name, {rows: mRows, scores}] of Object.entries(models)) {
    const gaps = topTwoGap(scores), y = mRows.map(R), g = mRows.map(r => r.scan_id);
    const sameStrategy = [], crossStrategy = [];
    for (const list of byScan(mRows, scores)) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) { const x = list[a], z = list[b], dy = R(x.row) - R(z.row); if (!dy) continue; const correct = x.score === z.score ? .5 : Math.sign(x.score - z.score) === Math.sign(dy) ? 1 : 0; (x.row.strategy === z.row.strategy ? sameStrategy : crossStrategy).push(correct); }
    perModel[name] = {positions: rankPositions(mRows, scores), weightedPairAccuracy: V2.weightedPairAccuracy(scores, y, g), unweightedPairAccuracy: mean([...sameStrategy, ...crossStrategy]), pairwiseRankingLoss: 1 - mean([...sameStrategy, ...crossStrategy]), sameStrategyPairAccuracy: {pairs: sameStrategy.length, accuracy: mean(sameStrategy)}, crossStrategyPairAccuracy: {pairs: crossStrategy.length, accuracy: mean(crossStrategy)}, top2Indistinguishable010: share(gaps, v => v < .1), top2Indistinguishable025: share(gaps, v => v < .25),
      regressionMae: name.includes('REGRESSION') ? mean(mRows.map((row, i) => Math.abs(scores[i] - R(row)))) : null, meanPredictionMae: name.includes('REGRESSION') ? mean(mRows.map(row => Math.abs(mean(y) - R(row)))) : null};
  }
  // Variance decomposition: how much of FINAL_R variance is common to the scan?
  const all = rows.map(R), grand = mean(all), groups = byScan(rows);
  let between = 0, within = 0; for (const list of groups) { const m = mean(list.map(i => R(i.row))); for (const item of list) { between += (m - grand) ** 2; within += (R(item.row) - m) ** 2; } }
  const choiceGroups = groups.filter(l => l.length >= 2); let wb = 0, ww = 0, gm = mean(choiceGroups.flatMap(l => l.map(i => R(i.row)))); for (const list of choiceGroups) { const m = mean(list.map(i => R(i.row))); for (const item of list) { wb += (m - gm) ** 2; ww += (R(item.row) - m) ** 2; } }
  const tp1VsR = (() => { const a = rows.map(r => r.targets.TP1_BEFORE_SL ? 1 : 0), b = all, ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; a.forEach((v, i) => { c += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; }); return c / Math.sqrt(va * vb); })();
  const stopMass = share(rows, row => row.targets.STOP_HIT && !row.targets.TP1_BEFORE_SL);
  return {
    choiceScans: scans.length, candidatesPerScan: countBy(groups, l => l.length), shareScansWithExactly2: share(scans, l => l.length === 2),
    withinScanOutcomeDispersion: {medianSd: median(disp.map(d => d.sd)), meanSd: mean(disp.map(d => d.sd)), medianRange: median(disp.map(d => d.range))},
    oracleTop2Gap: {shareBelow010: share(outcomes, l => { const s = l.slice().sort((a, b) => b - a); return s[0] - s[1] < .1; }), shareBelow025: share(outcomes, l => { const s = l.slice().sort((a, b) => b - a); return s[0] - s[1] < .25; })},
    varianceShare: {allScans: {betweenScan: between / (between + within), withinScan: within / (between + within)}, choiceScans: {betweenScan: wb / (wb + ww), withinScan: ww / (wb + ww)}},
    labelShape: {fullStopLossShare: stopMass, tp1Rate: mean(rows.map(r => r.targets.TP1_BEFORE_SL ? 1 : 0)), finalRSd: sd(all), correlationTp1VsFinalR: tp1VsR},
    perModel
  };
}

// ------------------------------------------------------ horizon (Phase 13) --
// The frozen strict label (historical-rank-v2-clean.js resolveStrict) with the
// horizon as a parameter.  At 288 bars it must reproduce the stored label.
function resolveAtHorizon(candidate, byTime, bars) {
  const timestamp = Number(candidate.timestamp), first = byTime.get(timestamp);
  if (!first) return {status: 'UNRESOLVED_DATA_GAP'};
  const rawEntry = first.open, plannedStop = Number(candidate.stop), direction = candidate.direction, distance = Math.abs(rawEntry - plannedStop), rr = Number(candidate.rr);
  if (!(distance > 0) || !(rr > 0)) return {status: 'UNRESOLVED_DATA_GAP'};
  if ((direction === 'long' && rawEntry <= plannedStop) || (direction === 'short' && rawEntry >= plannedStop)) return {status: 'UNRESOLVED_DATA_GAP'};
  const s = direction === 'long' ? 1 : -1, entry = rawEntry * (1 + s * .0003), tp1 = entry + s * distance * rr, tp2Mult = Math.max(rr + 1, 3), tp2 = entry + s * distance * tp2Mult, stop = entry - s * distance;
  let tp1Hit = false, tp2Hit = false, stopHit = false, finalR = 0, exit = 'TIMEOUT';
  for (let k = 0; k < bars; k++) {
    const candle = byTime.get(timestamp + k * B);
    if (!candle) return {status: 'UNRESOLVED_DATA_GAP'};
    const touches = level => s > 0 ? candle.low <= level : candle.high >= level, reaches = level => s > 0 ? candle.high >= level : candle.low <= level;
    if (touches(tp1Hit ? entry : stop)) { stopHit = true; finalR = tp1Hit ? rr * .5 : -1; exit = tp1Hit ? 'BREAKEVEN_AFTER_TP1' : 'STOP'; break; }
    if (!tp1Hit && reaches(tp1)) { tp1Hit = true; if (touches(entry)) { stopHit = true; finalR = rr * .5; exit = 'BREAKEVEN_SAME_CANDLE_AS_TP1'; break; } }
    if (tp1Hit && reaches(tp2)) { tp2Hit = true; finalR = rr * .5 + tp2Mult * .5; exit = 'TP2'; break; }
    finalR = tp1Hit ? rr * .5 + .5 * s * (candle.close - entry) / distance : s * (candle.close - entry) / distance;
  }
  return {status: 'RESOLVED', FINAL_R: finalR - .0016 / (distance / entry), TP1_BEFORE_SL: tp1Hit, STOP_HIT: stopHit, TP2_HIT: tp2Hit, exit};
}
const HORIZONS = Object.freeze({'6h': 72, '12h': 144, '24h': 288, '48h': 576, '72h': 864});
function horizonDiagnostic(rows, byTimeOf, models, {holdoutStartMs}) {
  const out = {}, reproduction = {checked: 0, matched: 0, maxAbsDiff: 0};
  const labels = {};
  for (const [name, bars] of Object.entries(HORIZONS)) {
    if (Math.max(...rows.map(r => r.timestamp)) + bars * B > holdoutStartMs) throw new Error(`HOLDOUT_BREACH: ${name} horizon would read candles at or after the holdout start`);
    labels[name] = rows.map(row => { const byTime = byTimeOf(row.asset); return byTime ? resolveAtHorizon(row, byTime, bars) : {status: 'UNRESOLVED_DATA_GAP'}; });
  }
  labels['24h'].forEach((label, i) => { if (label.status !== 'RESOLVED') return; reproduction.checked++; const d = Math.abs(label.FINAL_R - R(rows[i])); reproduction.maxAbsDiff = Math.max(reproduction.maxAbsDiff, d); if (d < 1e-6 && label.TP1_BEFORE_SL === Boolean(rows[i].targets.TP1_BEFORE_SL)) reproduction.matched++; });
  for (const [name, list] of Object.entries(labels)) {
    const idx = list.map((l, i) => l.status === 'RESOLVED' ? i : -1).filter(i => i >= 0), res = idx.map(i => list[i]);
    const withLabel = idx.map(i => ({...rows[i], targets: {...rows[i].targets, FINAL_R: list[i].FINAL_R, TP1_BEFORE_SL: list[i].TP1_BEFORE_SL, STOP_HIT: list[i].STOP_HIT}}));
    const signal = {};
    for (const [model, {rows: mRows, scores}] of Object.entries(models)) {
      const pos = new Map(mRows.map((r, i) => [r.candidate_id, scores[i]])), keep = withLabel.filter(r => pos.has(r.candidate_id)), s = keep.map(r => pos.get(r.candidate_id));
      const pk = V2.picks(keep, s), choice = pk.filter(p => p.choices >= 2);
      signal[model] = {oosCandidates: keep.length, weightedPairAccuracy: V2.weightedPairAccuracy(s, keep.map(R), keep.map(r => r.scan_id)), spearman: V2.spearmanWithin(keep, s).meanSpearman, pick1MeanR016: mean(pk.map(p => p.r)), pick1MeanR016ChoiceScans: mean(choice.map(p => p.r))};
    }
    out[name] = {bars: HORIZONS[name], resolvedFraction: idx.length / rows.length, naturalExitFraction: mean(res.map(l => l.exit === 'TIMEOUT' ? 0 : 1)), meanR016: mean(res.map(l => l.FINAL_R)), tp1Rate: mean(res.map(l => l.TP1_BEFORE_SL ? 1 : 0)), stopRate: mean(res.map(l => l.STOP_HIT && !l.TP1_BEFORE_SL ? 1 : 0)), breakevenAfterTp1Rate: mean(res.map(l => l.STOP_HIT && l.TP1_BEFORE_SL ? 1 : 0)), tp2Rate: mean(res.map(l => l.TP2_HIT ? 1 : 0)), timeoutRate: mean(res.map(l => l.exit === 'TIMEOUT' ? 1 : 0)), signal};
  }
  return {horizons: out, reproduction24h: reproduction, note: 'Descriptive only. Scores are the frozen 24h-trained OOS scores re-evaluated against each horizon label; no horizon is selected here.'};
}

// ------------------------------------------ effective sample (Phase 14) ------
function autocorrEss(series, maxLag = 10) {
  const n = series.length, m = mean(series), v = series.reduce((t, x) => t + (x - m) ** 2, 0) / n; if (!v || n < 20) return {n, ess: null, rho: []};
  const rho = []; for (let k = 1; k <= maxLag; k++) { let c = 0; for (let i = k; i < n; i++) c += (series[i] - m) * (series[i - k] - m); rho.push(c / n / v); }
  let s = 0; for (const r of rho) { if (r <= 0) break; s += r; }       // initial positive sequence
  return {n, ess: n / (1 + 2 * s), rho: rho.slice(0, 5)};
}
function effectiveSample(rows, {scanCounts = null, deltaSeries = null, randomPickSeries = null} = {}) {
  const groups = byScan(rows), choice = groups.filter(l => l.length >= 2), times = groups.map(l => l[0].row.timestamp).sort((a, b) => a - b), gaps = times.slice(1).map((t, i) => (t - times[i]) / HOUR);
  const overlap = h => share(gaps, g => g < h);
  const ess = deltaSeries ? autocorrEss(deltaSeries) : null, essRandom = randomPickSeries ? autocorrEss(randomPickSeries) : null;
  const sdDelta = deltaSeries ? sd(deltaSeries) : null, detect = effect => sdDelta ? Math.ceil((1.96 * sdDelta / effect) ** 2) : null;
  return {
    scanCounts, developmentScanGroups: groups.length, choiceScans: choice.length, candidatesPerScan: countBy(groups, l => l.length),
    medianHoursBetweenScans: median(gaps), overlapShare: {'24h': overlap(24), '48h': overlap(48), '72h': overlap(72)},
    effectiveIndependentScanGroups: {pairedDeltaGbmVsQuant: ess, randomPickR: essRandom},
    strategyCounts: countBy(rows, r => r.strategy), assetCounts: countBy(rows, r => r.asset), annualCounts: countBy(rows, r => new Date(r.timestamp).getUTCFullYear()), annualChoiceScans: countBy(choice, l => new Date(l[0].row.timestamp).getUTCFullYear()),
    uncertainty: {pairedDeltaSd: sdDelta, scansNeededFor95Ci: {'0.04R': detect(.04), '0.08R': detect(.08)}, pickRSd: randomPickSeries ? sd(randomPickSeries) : null}
  };
}

// --------------------------------------------- candidate diversity (Phase 15)
function candidateDiversity(rows) {
  const choice = byScan(rows, rows.map(r => r.quant_score)).filter(l => l.length >= 2);
  const top2 = choice.map(l => l.slice().sort((a, b) => b.score - a.score || String(a.row.candidate_id).localeCompare(String(b.row.candidate_id))).slice(0, 2).map(i => i.row));
  const sameDirPairs = []; for (const l of choice) for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) if (l[a].row.asset !== l[b].row.asset && l[a].row.direction === l[b].row.direction) sameDirPairs.push([R(l[a].row), R(l[b].row)]);
  const corrOf = pairs => { if (pairs.length < 5) return null; const a = pairs.map(p => p[0]), b = pairs.map(p => p[1]), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; a.forEach((v, i) => { c += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; }); return c / Math.sqrt(va * vb); };
  return {
    choiceScans: choice.length,
    candidatesPerChoiceScan: {median: median(choice.map(l => l.length)), mean: mean(choice.map(l => l.length)), histogram: countBy(choice, l => l.length)},
    assetsPerChoiceScan: countBy(choice, l => new Set(l.map(i => i.row.asset)).size),
    shareWithBothDirections: share(choice, l => new Set(l.map(i => i.row.direction)).size === 2),
    strategiesPerChoiceScan: countBy(choice, l => new Set(l.map(i => i.row.strategy)).size),
    shareAllSameStrategy: share(choice, l => new Set(l.map(i => i.row.strategy)).size === 1),
    top2NearIdentical: {sameAssetSameDirection: share(top2, ([a, b]) => a.asset === b.asset && a.direction === b.direction), sameDirectionAnyAsset: share(top2, ([a, b]) => a.direction === b.direction), sameStrategySameDirection: share(top2, ([a, b]) => a.strategy === b.strategy && a.direction === b.direction)},
    top2OutcomesDifferMaterially: {'>=0.5R': share(top2, ([a, b]) => Math.abs(R(a) - R(b)) >= .5), '>=1R': share(top2, ([a, b]) => Math.abs(R(a) - R(b)) >= 1)},
    crossAssetSameDirectionOutcomeCorrelation: {pairs: sameDirPairs.length, correlation: corrOf(sameDirPairs)}
  };
}

module.exports = {pairedDelta, classify, rankPositions, monotonicityDiagnosis, resolveAtHorizon, HORIZONS, horizonDiagnostic, autocorrEss, effectiveSample, candidateDiversity};
