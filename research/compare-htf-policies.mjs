#!/usr/bin/env node
// Does the native-HTF policy merely fill coverage gaps, or does it change the
// feature definition?  For every development (scan, asset) where BOTH the
// strict (5m-aggregated) and the native (venue 1h/1d) policies pass their
// integrity gates, feed each to the shared Quant engine and compare:
// the 4h/1d bars themselves, trend direction, regime, qualifying setups,
// candidate scores and the scan's #1 pick.  Archive only; no D1, no holdout.
import {readFileSync, writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import Clean from './historical-rank-v2-clean.js';
import Quant from '../quant-engine.js';
import Rank from './historical-rank.js';
import V2 from './rank-research-v2.js';

const DIR = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive', REPORT = process.env.HTF_COMPARE_REPORT || 'htf-policy-comparison.json', DAY = 86_400_000;
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC'];
const readCsv = path => gunzipSync(readFileSync(path)).toString().trim().split('\n').filter(Boolean).map(line => { const [time, open, high, low, close, volume] = line.split(',').map(Number); return {time, open, high, low, close, volume}; });
const strict = {}, native = {};
for (const asset of ASSETS) { const base = readCsv(join(DIR, `${asset}.csv.gz`)); strict[asset] = Clean.prepareAsset(asset, base); native[asset] = Clean.prepareAsset(asset, base, {native: {h1: readCsv(join(DIR, `${asset}-1h.csv.gz`)), d1: readCsv(join(DIR, `${asset}-1d.csv.gz`))}}); }
const bias = f => f?.available ? (f.price > f.ema20 && f.ema20 > f.ema50 ? 'long' : f.price < f.ema20 && f.ema20 < f.ema50 ? 'short' : 'neutral') : 'UNAVAILABLE';
const rate = (a, b) => b ? a / b : null;
const median = values => { const s = values.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const counts = {pairs: 0, coverage: {bothPass: 0, strictOnly: 0, nativeOnly: 0, neither: 0}, h4TrendDiff: 0, h4BiasDiff: 0, d1TrendDiff: 0, d1BiasDiff: 0, h4RegimeDiff: 0, d1RegimeDiff: 0, setupSetDiff: 0, anySetupStrict: 0, anySetupNative: 0, commonCandidates: 0, scoreDiffNonZero: 0, scoreAbsDiff: [], lastH4CloseRelDiff: [], lastD1CloseRelDiff: [], d1VolumeRelDiff: [], h4BarsIdentical: 0, d1BarsIdentical: 0};
const top = {scans: 0, sameTop: 0}, transitions = {};
const first = Math.max(...ASSETS.map(a => native[a].rows[0].time)) + Clean.HISTORY_MS + DAY, last = V2.HOLDOUT.devCutoffMs - DAY;
for (let ts = Math.ceil(first / DAY) * DAY; ts < last; ts += DAY) {
  const scanStrict = [], scanNative = [];
  for (const asset of ASSETS) {
    const cs = Clean.historyCheck(strict[asset], ts), cn = Clean.historyCheck(native[asset], ts);
    counts.coverage[cs.ok && cn.ok ? 'bothPass' : cs.ok ? 'strictOnly' : cn.ok ? 'nativeOnly' : 'neither']++;
    if (!(cs.ok && cn.ok)) continue;
    counts.pairs++;
    const fs = {h4: Quant.features(cs.timeframes.h4, 6), d1: Quant.features(cs.timeframes.d1, 1)}, fn = {h4: Quant.features(cn.timeframes.h4, 6), d1: Quant.features(cn.timeframes.d1, 1)};
    if (fs.h4.structure?.trend !== fn.h4.structure?.trend) counts.h4TrendDiff++;
    if (bias(fs.h4) !== bias(fn.h4)) counts.h4BiasDiff++;
    if (fs.d1.structure?.trend !== fn.d1.structure?.trend) counts.d1TrendDiff++;
    if (bias(fs.d1) !== bias(fn.d1)) counts.d1BiasDiff++;
    const rs = Quant.classifyRegime(fs.h4), rn = Quant.classifyRegime(fn.h4), ds = Quant.classifyRegime(fs.d1), dn = Quant.classifyRegime(fn.d1);
    if (rs !== rn) { counts.h4RegimeDiff++; transitions[`h4:${rs}->${rn}`] = (transitions[`h4:${rs}->${rn}`] || 0) + 1; }
    if (ds !== dn) { counts.d1RegimeDiff++; transitions[`d1:${ds}->${dn}`] = (transitions[`d1:${ds}->${dn}`] || 0) + 1; }
    const lastS = cs.timeframes.d1.at(-1), lastN = cn.timeframes.d1.at(-1), h4S = cs.timeframes.h4.at(-1), h4N = cn.timeframes.h4.at(-1);
    counts.lastD1CloseRelDiff.push(Math.abs(lastS.close / lastN.close - 1)); counts.lastH4CloseRelDiff.push(Math.abs(h4S.close / h4N.close - 1)); counts.d1VolumeRelDiff.push(Math.abs(lastS.volume / lastN.volume - 1));
    const same = (a, b) => a.length === b.length && a.every((bar, i) => bar.time === b[i].time && Math.abs(bar.open / b[i].open - 1) < 1e-9 && Math.abs(bar.high / b[i].high - 1) < 1e-9 && Math.abs(bar.low / b[i].low - 1) < 1e-9 && Math.abs(bar.close / b[i].close - 1) < 1e-9);
    if (same(cs.timeframes.h4, cn.timeframes.h4)) counts.h4BarsIdentical++; if (same(cs.timeframes.d1, cn.timeframes.d1)) counts.d1BarsIdentical++;
    const key = row => `${row.strategy}|${row.direction}`, valid = list => list.filter(row => Rank.geometry(row).valid).map(row => ({...row, key: key(row), score: Number(row.setupQuality ?? row.quality)}));
    const es = valid(Quant.evaluateSetupCandidates({timeframes: cs.timeframes, settings: Rank.SETTINGS})), en = valid(Quant.evaluateSetupCandidates({timeframes: cn.timeframes, settings: Rank.SETTINGS}));
    if (es.length) counts.anySetupStrict++; if (en.length) counts.anySetupNative++;
    const ks = new Set(es.map(r => r.key)), kn = new Set(en.map(r => r.key));
    if (ks.size !== kn.size || [...ks].some(k => !kn.has(k))) counts.setupSetDiff++;
    for (const row of es) { const other = en.find(r => r.key === row.key); if (!other) continue; counts.commonCandidates++; const diff = Math.abs(row.score - other.score); counts.scoreAbsDiff.push(diff); if (diff > 0) counts.scoreDiffNonZero++; }
    scanStrict.push(...es.map(r => ({...r, asset}))); scanNative.push(...en.map(r => ({...r, asset})));
  }
  if (scanStrict.length >= 2 && scanNative.length >= 2) { top.scans++; const best = list => list.slice().sort((a, b) => b.score - a.score || a.asset.localeCompare(b.asset) || a.key.localeCompare(b.key))[0]; const a = best(scanStrict), b = best(scanNative); if (a.asset === b.asset && a.key === b.key) top.sameTop++; }
}
const p = counts.pairs, report = {
  scope: 'development scans only (< holdout dev cutoff), (scan, asset) pairs where BOTH policies pass integrity gates', pairs: p, coverage: counts.coverage,
  bars: {h4WindowIdentical: rate(counts.h4BarsIdentical, p), d1WindowIdentical: rate(counts.d1BarsIdentical, p), lastH4CloseRelDiffMedian: median(counts.lastH4CloseRelDiff), lastH4CloseRelDiffMax: Math.max(...counts.lastH4CloseRelDiff), lastD1CloseRelDiffMedian: median(counts.lastD1CloseRelDiff), lastD1CloseRelDiffMax: Math.max(...counts.lastD1CloseRelDiff), lastD1VolumeRelDiffMedian: median(counts.d1VolumeRelDiff)},
  disagreement: {h4StructureTrend: rate(counts.h4TrendDiff, p), h4EmaBias: rate(counts.h4BiasDiff, p), d1StructureTrend: rate(counts.d1TrendDiff, p), d1EmaBias: rate(counts.d1BiasDiff, p), h4Regime: rate(counts.h4RegimeDiff, p), d1MacroRegime: rate(counts.d1RegimeDiff, p), setupSet: rate(counts.setupSetDiff, p), candidateScoreChanged: rate(counts.scoreDiffNonZero, counts.commonCandidates), candidateScoreMeanAbsDiff: counts.scoreAbsDiff.length ? counts.scoreAbsDiff.reduce((a, b) => a + b, 0) / counts.scoreAbsDiff.length : null, scanTopPickChanged: top.scans ? 1 - top.sameTop / top.scans : null},
  denominators: {pairs: p, commonCandidates: counts.commonCandidates, scansWithTwoPlusCandidatesUnderBoth: top.scans, pairsWithAnySetupStrict: counts.anySetupStrict, pairsWithAnySetupNative: counts.anySetupNative},
  regimeTransitions: Object.fromEntries(Object.entries(transitions).sort((a, b) => b[1] - a[1]).slice(0, 12))
};
writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report));
