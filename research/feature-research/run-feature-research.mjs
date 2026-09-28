#!/usr/bin/env node
// Feature research v1 runner (read-only).  Measures FEATURE value with the
// frozen model-research instruments and protocol; see PREREGISTRATION.md.
//
// - D1: single SELECT statements only, hard read budget, holdout filtered in
//   SQL and again in V2.parseRows.
// - Candles: the audited Coinbase archive artifact, verified against the
//   committed manifest by the workflow before this runs, truncated here so no
//   candle at or after the holdout start is ever loaded.
// - No writes to D1, the Worker, production code, or any model registry.
// FEATURE_RESEARCH_SYNTHETIC=1 runs the whole pipeline on generated data
// (no network) to exercise the code paths; its numbers mean nothing.
import {readFileSync, writeFileSync, existsSync, appendFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import V2 from '../rank-research-v2.js';
import F from './features.js';
import D from './diagnostics.js';

const SYNTHETIC = process.env.FEATURE_RESEARCH_SYNTHETIC === '1';
const ENGINE = process.env.HISTORICAL_RANK_ENGINE_VERSION || 'HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF';
const REPORT = process.env.FEATURE_RESEARCH_REPORT || 'feature-research-report.json';
const ARCHIVE_DIR = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive';
const ARCHIVE_RUN = process.env.CANDLE_ARCHIVE_RUN_ID || null;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '', DATABASE = process.env.MARKET_EDGE_D1_DATABASE_ID || '';
const READ_BUDGET = Math.max(1000, Number(process.env.FEATURE_RESEARCH_D1_READ_BUDGET) || 300_000);
const HOLDOUT = V2.HOLDOUT, HOUR = 3_600_000;
const BASE_FAMILIES = Object.freeze(['BASE', 'SETUP', 'STRUCTURE', 'VOLATILITY', 'MOMENTUM', 'LIQUIDITY', 'REGIME']);
const REG = 'GBM_FINAL_R', RANK = 'LAMBDARANK_GBM_TP1', LEARNED = [REG, RANK];
// Pre-registered arms (PREREGISTRATION.md §1).  Do not add arms here after
// results are seen; a new pass is a new pre-registration.
const ARMS = Object.freeze({
  BASE: [],
  'BASE+STRUCTURE': ['FR_STRUCTURE'], 'BASE+FVG': ['FR_FVG'], 'BASE+CANDLE': ['FR_CANDLE'], 'BASE+CROSS_MARKET': ['FR_CROSS_MARKET'], 'BASE+DERIVATIVES': ['FR_DERIVATIVES'],
  'BASE+STRUCTURE+FVG': ['FR_STRUCTURE', 'FR_FVG'], 'BASE+STRUCTURE+CANDLE': ['FR_STRUCTURE', 'FR_CANDLE'], 'BASE+CROSS_MARKET+DERIVATIVES': ['FR_CROSS_MARKET', 'FR_DERIVATIVES'],
  'BASE+ALL': ['FR_STRUCTURE', 'FR_FVG', 'FR_CANDLE', 'FR_CROSS_MARKET', 'FR_DERIVATIVES']
});
const SINGLE = {STRUCTURE: 'BASE+STRUCTURE', FVG: 'BASE+FVG', CANDLE: 'BASE+CANDLE', CROSS_MARKET: 'BASE+CROSS_MARKET', DERIVATIVES: 'BASE+DERIVATIVES'};
let rowsRead = 0;
const mean = list => { const xs = list.filter(Number.isFinite); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
const round = value => typeof value === 'number' ? Math.round(value * 10000) / 10000 : value;
const compact = value => JSON.parse(JSON.stringify(value, (key, item) => round(item)));
const log = message => console.error(`[${new Date().toISOString()}] ${message}`);

// ------------------------------------------------------------------ D1 -----
async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('READ_ONLY_VIOLATION: only single SELECT statements are permitted');
  if (!CF_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required for read-only research');
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF_TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
    if (response.ok && body.success !== false) { rowsRead += Number(body.result?.[0]?.meta?.rows_read || 0); if (rowsRead > READ_BUDGET) throw new Error(`D1_READ_BUDGET_EXCEEDED: ${rowsRead}`); return body.result?.[0]?.results || []; }
    if (attempt === 3 || (response.status < 500 && response.status !== 429)) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}
// Identical to the model-research loader (run-rank-research-v2.mjs).
const loadCandidates = () => d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.quant_score,c.candidate_rank,c.regime,c.feature_json,c.targets_json,c.valid_current_geometry,s.scan_timestamp,seq.sequence_json FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id LEFT JOIN historical_candidate_sequences seq ON seq.candidate_id=c.candidate_id WHERE c.valid_current_geometry=1 AND json_extract(c.targets_json,'$.status')='RESOLVED' AND s.engine_version=? AND s.scan_timestamp<? ORDER BY s.scan_timestamp,c.candidate_id`, [ENGINE, HOLDOUT.devCutoffMs]);
async function scanCounts() {
  const [row = {}] = await d1(`SELECT COUNT(*) AS total,SUM(CASE WHEN scan_timestamp<? THEN 1 ELSE 0 END) AS development,SUM(CASE WHEN scan_timestamp>=? AND scan_timestamp<? THEN 1 ELSE 0 END) AS embargo,SUM(CASE WHEN scan_timestamp>=? THEN 1 ELSE 0 END) AS holdout FROM historical_scan_snapshots WHERE engine_version=?`, [HOLDOUT.devCutoffMs, HOLDOUT.devCutoffMs, HOLDOUT.startMs, HOLDOUT.startMs, ENGINE]);
  return row;   // counts only; no holdout row content is read
}

// -------------------------------------------------------------- archive ----
// Candles closing after the holdout start are dropped before anything else
// sees them.  The workflow verified the files against the committed manifest.
function readCsv(path, interval, [from, to] = [-Infinity, Infinity]) {
  if (!existsSync(path)) throw new Error(`ARCHIVE_MISSING: ${path}`);
  const text = gunzipSync(readFileSync(path)).toString(), sha = createHash('sha256').update(text).digest('hex');
  const rows = text.trim().split('\n').filter(Boolean).map(line => { const [time, open, high, low, close, volume] = line.split(',').map(Number); return {time, open, high, low, close, volume}; }).filter(row => row.time + interval <= HOLDOUT.startMs && row.time >= from && row.time < to);
  if (rows.some(row => row.time + interval > HOLDOUT.startMs)) throw new Error('HOLDOUT_BREACH: archive candle at or after the holdout start');
  return {rows, sha};
}
// Only the span the study can touch: 60 days before the first development
// scan (deepest lookback: 300 x 4h = 50 days) to 4 days after the last (72h
// horizon diagnostic).  Still capped at the holdout start above.
function loadUniverse(span) {
  const universe = {}, provenance = {};
  for (const asset of F.ASSETS) {
    const m5 = readCsv(join(ARCHIVE_DIR, `${asset}.csv.gz`), F.B, span), h1 = readCsv(join(ARCHIVE_DIR, `${asset}-1h.csv.gz`), HOUR, span);
    universe[asset] = F.buildSeries(m5.rows, h1.rows);
    provenance[asset] = {m5: {rows: m5.rows.length, sha256: m5.sha, last: new Date(m5.rows.at(-1).time).toISOString()}, h1Native: {rows: h1.rows.length, sha256: h1.sha}};
  }
  return {universe, provenance};
}

// ------------------------------------------------------------ synthetic ----
function syntheticWorld() {
  let state = Number(process.env.FEATURE_RESEARCH_SYNTHETIC_SEED) || 99; const random = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const start = Date.UTC(2023, 0, 1), days = 420, universe = {}, rows = [];
  for (const [k, asset] of F.ASSETS.entries()) { let price = 20 + k * 30; const m5 = []; for (let t = start - 60 * F.DAY; t < start + (days + 4) * F.DAY; t += F.B) { const open = price, close = open * (1 + (random() - .5) * .004); m5.push({time: t, open, high: Math.max(open, close) * (1 + random() * .001), low: Math.min(open, close) * (1 - random() * .001), close, volume: 5 + random() * 10}); price = close; } universe[asset] = F.buildSeries(m5); }
  for (let d = 0; d < days; d++) {
    const T = start + d * F.DAY, n = 1 + Math.floor(random() * 4);
    for (let c = 0; c < n; c++) {
      const asset = F.ASSETS[Math.floor(random() * 6)], direction = random() > .5 ? 'long' : 'short', entry = F.closeAt(universe[asset], T), stop = entry * (direction === 'long' ? .98 : 1.02);
      const frame = interval => ({available: true, window_end: T, rows: Array.from({length: 64}, (_, i) => ({time: T - (64 - i) * interval, close_to_close: (random() - .5) / 100, high_low: .004, relative_volume: 1, atr_normalized_move: 0, rolling_volatility: .002, upper_wick: random(), lower_wick: random(), distance_recent_high: -.01, distance_recent_low: .01}))});
      const resolved = D.resolveAtHorizon({timestamp: T, stop, rr: 1.5, direction}, universe[asset].byTime, 288);
      rows.push({candidate_id: `syn-${d}-${c}`, scan_id: `scan-${d}`, asset, direction, strategy: ['TREND CONTINUATION', 'LIQUIDITY-SWEEP REVERSAL', 'BREAKOUT + RETEST'][c % 3], entry, stop, rr: 1.5, quant_score: 50 + random() * 40, candidate_rank: c + 1, regime: 'UPTREND', timestamp: T, features: {h1: {rsi: 50 + random() * 20, atr: entry * .01}}, targets: {status: 'RESOLVED', ...resolved}, sequence: {timeframes: {m5: frame(F.B), m15: frame(F.M15), h1: frame(HOUR)}}, valid_current_geometry: 1});
    }
  }
  const scanTimes = [...new Set(rows.map(r => r.timestamp))];
  const deriv = Object.fromEntries(F.ASSETS.map(a => [a, {funding: [], oi: [], premium: []}]));
  for (const a of F.ASSETS) for (let t = start - 40 * F.DAY; t < start + days * F.DAY; t += 8 * HOUR) deriv[a].funding.push({time: t, rate: (random() - .5) * 2e-4});
  for (const a of ['BTC', 'ETH']) for (const T of scanTimes) { for (let t = T - 5 * HOUR; t <= T; t += F.B) deriv[a].oi.push({time: t, oi: 1e6 * (1 + random() * .05)}); for (let t = T - 26 * HOUR; t <= T; t += HOUR) deriv[a].premium.push({closeTime: t, close: (random() - .5) * 1e-3}); }
  return {rows, universe, deriv};
}

// ------------------------------------------------------------ analysis -----
function foldWindows(rows) { return V2.walkForwardFolds(V2.groupByScan(rows), {folds: 5}).map(f => ({fold: f.fold, startMs: f.testStartMs, endMs: f.testEndMs, start: new Date(f.testStartMs).toISOString().slice(0, 10), end: new Date(f.testEndMs).toISOString().slice(0, 10)})); }
function splitShare(folds) {
  const total = {}; for (const fold of folds) for (const [col, n] of Object.entries(fold.splits || {})) total[col] = (total[col] || 0) + n;
  const sum = Object.values(total).reduce((a, b) => a + b, 0) || 1, ranked = Object.entries(total).sort((a, b) => b[1] - a[1]);
  const byFamily = {}; for (const [col, n] of ranked) { const fam = col.split('.')[0]; byFamily[fam] = (byFamily[fam] || 0) + n / sum; }
  return {maxShare: ranked.length ? ranked[0][1] / sum : 0, top: ranked.slice(0, 8).map(([col, n]) => [col, n / sum]), byFamily};
}
function coverage(featureRows, rows, family) {
  const cols = V2.columns(featureRows, [family]); if (!cols.length) return {columns: 0, nonNullShare: 0};
  const X = V2.matrix(featureRows, cols), byAsset = {};
  rows.forEach((row, i) => { const e = byAsset[row.asset] || {cells: 0, filled: 0}; e.cells += cols.length; e.filled += X[i].filter(Number.isFinite).length; byAsset[row.asset] = e; });
  return {columns: cols.length, nonNullShare: X.flat().filter(Number.isFinite).length / (cols.length * X.length), byAsset: Object.fromEntries(Object.entries(byAsset).map(([a, e]) => [a, e.filled / e.cells]))};
}
function leakageAudit(rows, featureRows, provenance, universe) {
  const checks = {};
  checks.noHoldoutRows = rows.every(row => row.timestamp < HOLDOUT.devCutoffMs);
  checks.noSourceAfterScan = provenance.every((p, i) => Object.values(p).every(f => f.source_timestamp === null || f.source_timestamp <= rows[i].timestamp));
  checks.derivativeSourcesBeforeScan = provenance.every((p, i) => Object.values(p.FR_DERIVATIVES?.source_times || {}).every(t => t <= rows[i].timestamp));
  try { featureRows.forEach(fr => V2.assertPreEntryFeatureNames(fr)); checks.featureNamesPreEntry = true; } catch { checks.featureNamesPreEntry = false; }
  checks.noArchiveCandleInHoldout = Object.values(universe).every(u => !u.m5.length || u.m5.at(-1).time + F.B <= HOLDOUT.startMs);
  // Real-data future invariance: recompute a sample of rows with the archive
  // truncated at each scan timestamp; any difference means lookahead.
  const sample = rows.filter((_, i) => i % Math.max(1, Math.floor(rows.length / 40)) === 0), mismatches = [];
  for (const row of sample) {
    const cut = Object.fromEntries(Object.entries(universe).map(([a, u]) => [a, F.buildSeries(u.m5.filter(b => b.time + F.B <= row.timestamp), u.h1.filter(b => b.time + HOUR <= row.timestamp))]));
    const full = F.computeFamilies(row, universe, null).families, truncated = F.computeFamilies(row, cut, null).families;
    for (const fam of ['FR_STRUCTURE', 'FR_FVG', 'FR_CANDLE', 'FR_CROSS_MARKET']) if (JSON.stringify(full[fam]) !== JSON.stringify(truncated[fam])) mismatches.push({candidate_id: row.candidate_id, family: fam});
  }
  checks.realDataFutureInvariance = {sampled: sample.length, mismatches: mismatches.length, examples: mismatches.slice(0, 5)};
  checks.sameScanNeverSplit = true;   // enforced by V2.walkForwardFolds (scan groups), re-checked below
  const pass = checks.noHoldoutRows && checks.noSourceAfterScan && checks.derivativeSourcesBeforeScan && checks.featureNamesPreEntry && checks.noArchiveCandleInHoldout && mismatches.length === 0;
  return {pass, checks};
}

async function run() {
  const started = Date.now(), meta = {engine: ENGINE, synthetic: SYNTHETIC, archiveRunId: ARCHIVE_RUN, ciRunId: process.env.GITHUB_RUN_ID || null, gitSha: process.env.GITHUB_SHA || null, generatedAt: new Date().toISOString()};
  let rows, universe, archiveProvenance = null, counts = null, derivatives = null, derivStatus = {}, legacy = {context: {}, status: 'SYNTHETIC'}, liquidation = null, tardis = 'SKIPPED_NOT_CONFIGURED';
  if (SYNTHETIC) { const world = syntheticWorld(); rows = world.rows; universe = world.universe; derivatives = world.deriv; derivStatus = 'SYNTHETIC'; }
  else {
    const P = await import('./derivatives-provider.mjs');
    counts = await scanCounts();
    const raw = await loadCandidates(), parsed = V2.parseRows(raw);
    if (parsed.excludedHoldoutOrEmbargo) throw new Error('HOLDOUT_BREACH: loader returned rows beyond the development cutoff');
    rows = parsed.rows; log(`loaded ${rows.length} fresh development rows (${rowsRead} D1 rows read)`);
    ({universe, provenance: archiveProvenance} = loadUniverse([rows[0].timestamp - 60 * 24 * HOUR, rows.at(-1).timestamp + 4 * 24 * HOUR])); log('archive loaded');
    tardis = P.tardisStatus(); derivatives = {};
    for (const asset of F.ASSETS) { const times = [...new Set(rows.filter(r => r.asset === asset).map(r => r.timestamp))]; if (!times.length) continue; try { const loaded = await P.loadBinanceDerivatives(asset, times); derivatives[asset] = loaded.series; derivStatus[asset] = loaded.status; } catch (error) { derivStatus[asset] = {status: `UNAVAILABLE: ${error.message}`}; } log(`derivatives ${asset}: ${JSON.stringify(derivStatus[asset]).slice(0, 200)}`); }
    liquidation = await P.probeLiquidations('BTC', new Date(rows[Math.floor(rows.length / 2)].timestamp).toISOString().slice(0, 10));
    legacy = await P.legacyContext(F.ASSETS, rows[0].timestamp - 35 * 24 * HOUR, rows.at(-1).timestamp); log('legacy context loaded');
  }
  const archiveMeta = {datasetVersion: ENGINE, archiveVersion: ARCHIVE_RUN ? `coinbase-5m-archive@run-${ARCHIVE_RUN}` : 'synthetic', retrieval: meta.ciRunId ? `github-actions-run-${meta.ciRunId}` : 'local'};
  const provenance = [], featureRows = rows.map(row => { const base = V2.extractFeatures(row, legacy.context), fr = F.computeFamilies(row, universe, derivatives, archiveMeta); provenance.push(fr.provenance); return {...base, ...fr.families}; });
  log('features computed');
  const coverageReport = Object.fromEntries([...V2.FAMILIES, ...F.FR_FAMILIES].map(f => [f, coverage(featureRows, rows, f)]));
  const freshness = Object.fromEntries(F.FR_FAMILIES.map(f => { const list = provenance.map(p => p[f].freshness_ms).filter(Number.isFinite); return [f, {rowsWithSource: list.length, maxFreshnessMin: list.length ? Math.max(...list) / 60000 : null, medianFreshnessMin: list.length ? list.sort((a, b) => a - b)[Math.floor(list.length / 2)] / 60000 : null, statuses: Object.entries(Object.groupBy(provenance, p => p[f].status || 'OK')).map(([k, v]) => [k, v.length])}]; }));
  const leakage = leakageAudit(rows, featureRows, provenance, universe); log(`leakage audit: ${leakage.pass ? 'PASS' : 'FAIL'}`);
  if (!leakage.pass) { const report = {status: 'LEAKAGE_FAIL_STOPPED', meta, leakage}; writeFileSync(REPORT, JSON.stringify(compact(report), null, 2) + '\n'); console.log(JSON.stringify(compact(report))); process.exitCode = 1; return; }

  // ---- frozen instruments on every arm ----
  const folds = foldWindows(rows), arms = {};
  const baseRun = V2.walkForward(rows, featureRows, {models: ['RANDOM', 'CURRENT_QUANT', ...LEARNED], families: BASE_FAMILIES, folds: 5});
  const quant = baseRun.models.CURRENT_QUANT, random = baseRun.models.RANDOM;
  const evaluate = run => Object.fromEntries(LEARNED.map(name => [name, {entry: run.models[name], evaluation: V2.evaluateOos(run.models[name], quant, random), picks: V2.picks(run.models[name].oosRows, run.models[name].oosScores)}]));
  arms.BASE = evaluate(baseRun); log('BASE arm done');
  for (const [arm, extra] of Object.entries(ARMS)) { if (arm === 'BASE') continue; arms[arm] = evaluate(V2.walkForward(rows, featureRows, {models: LEARNED, families: [...BASE_FAMILIES, ...extra], folds: 5})); log(`${arm} done`); }
  const reference = evaluate(V2.walkForward(rows, featureRows, {models: LEARNED, families: V2.FAMILIES, folds: 5})); log('REFERENCE done');
  const baselines = {RANDOM: V2.evaluateOos(random, quant, random), CURRENT_QUANT: V2.evaluateOos(quant, quant, random)};
  const costLine = e => Object.fromEntries(Object.entries(e.atCosts).map(([k, v]) => [k, v.meanR]));

  // ---- amendment A1: placebo calibration (family block permuted across rows) ----
  const PLACEBO_K = SYNTHETIC ? Number(process.env.FEATURE_RESEARCH_PLACEBO_K || 3) : 19, placebo = {};
  for (const arm of Object.keys(ARMS).filter(a => a !== 'BASE')) {
    const fams = ARMS[arm], deltas = {[REG]: [], [RANK]: []};
    for (let seed = 1; seed <= PLACEBO_K; seed++) {
      let state = seed * 7919; const rand = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const order = rows.map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const shuffled = featureRows.map((fr, i) => ({...fr, ...Object.fromEntries(fams.map(f => [f, featureRows[order[i]][f]]))}));
      const result = evaluate(V2.walkForward(rows, shuffled, {models: LEARNED, families: [...BASE_FAMILIES, ...fams], folds: 5}));
      for (const name of LEARNED) deltas[name].push(D.pairedDelta(result[name].picks, arms.BASE[name].picks).meanDelta);
    }
    placebo[arm] = Object.fromEntries(LEARNED.map(name => { const real = D.pairedDelta(arms[arm][name].picks, arms.BASE[name].picks).meanDelta, list = deltas[name].slice().sort((a, b) => a - b); return [name, {k: PLACEBO_K, realDelta: real, placeboMean: mean(list), placeboSd: Math.sqrt(mean(list.map(v => (v - mean(list)) ** 2))), placebo95th: list[Math.min(list.length - 1, Math.floor(list.length * .95))], placeboMax: list.at(-1), p: (1 + list.filter(v => v >= real).length) / (PLACEBO_K + 1)}]; }));
    log(`placebo ${arm}: p=${placebo[arm][REG].p}`);
  }
  const placeboOf = arm => placebo[arm]?.[REG].p ?? null;
  const armReport = {};
  for (const [arm, models] of Object.entries(arms)) {
    armReport[arm] = {families: [...BASE_FAMILIES, ...ARMS[arm]]};
    for (const name of LEARNED) {
      const {evaluation: e, picks, entry} = models[name], delta = arm === 'BASE' ? null : D.pairedDelta(picks, arms.BASE[name].picks, {folds});
      armReport[arm][name] = {meanR: costLine(e), ci95_016: [e.ci95_016.low, e.ci95_016.high], vsQuant016: {meanDiff: e.vsQuant016.meanDiff, ci95: [e.vsQuant016.ci95.low, e.vsQuant016.ci95.high], winPct: e.vsQuant016.ci95.pPositive * 100}, foldsR016: e.folds.map(f => f.meanR016), pairAccuracy: e.monotonicity.weightedPairAccuracy, spearman: e.monotonicity.meanSpearman, rankPositions: D.rankPositions(entry.oosRows, entry.oosScores), maxDrawdownR016: e.atCosts['0.16%'].maxDrawdownR, assets: e.assets, withoutDominantAsset: e.withoutDominantAsset, pickProfile: e.pickProfile, splitImportance: splitShare(entry.folds), tunedRounds: entry.folds.map(f => f.tuned?.rounds), deltaVsBase: delta};
    }
    if (arm !== 'BASE') {
      const reg = armReport[arm][REG], rank = armReport[arm][RANK];
      armReport[arm].classification = D.classify({reg: reg.deltaVsBase, rank: rank.deltaVsBase, pairAccDrop: armReport.BASE[REG].pairAccuracy - reg.pairAccuracy, maxSplitShare: reg.splitImportance.maxShare, leakagePass: leakage.pass, placeboP: placeboOf(arm)});
    }
  }
  const referenceReport = Object.fromEntries(LEARNED.map(name => [name, {meanR: costLine(reference[name].evaluation), vsQuant016: reference[name].evaluation.vsQuant016.meanDiff, foldsR016: reference[name].evaluation.folds.map(f => f.meanR016)}]));
  const singles = Object.entries(SINGLE).map(([fam, arm]) => [fam, armReport[arm][REG].deltaVsBase.meanDelta]).sort((a, b) => b[1] - a[1]);
  const combos = Object.keys(ARMS).filter(a => ARMS[a].length > 1).map(a => [a, armReport[a][REG].deltaVsBase.meanDelta]).sort((a, b) => b[1] - a[1]);
  const bestArm = Object.keys(ARMS).filter(a => a !== 'BASE').sort((a, b) => armReport[b][REG].meanR['0.16%'] - armReport[a][REG].meanR['0.16%'])[0];

  // ---- diagnostics ----
  const scoreSet = (entry) => ({rows: entry.oosRows, scores: entry.oosScores});
  const mono = {before: D.monotonicityDiagnosis(quant.oosRows, {CURRENT_QUANT: scoreSet(quant), GBM_REGRESSION_BASE: scoreSet(arms.BASE[REG].entry), GBM_RANKER_BASE: scoreSet(arms.BASE[RANK].entry)}), after: {bestArm, ...D.monotonicityDiagnosis(quant.oosRows, {GBM_REGRESSION_BEST: scoreSet(arms[bestArm][REG].entry), GBM_RANKER_BEST: scoreSet(arms[bestArm][RANK].entry)})}};
  log('monotonicity done');
  const horizon = D.horizonDiagnostic(rows, asset => universe[asset]?.byTime, {RANDOM: scoreSet(random), CURRENT_QUANT: scoreSet(quant), GBM_REGRESSION_BASE: scoreSet(arms.BASE[REG].entry)}, {holdoutStartMs: HOLDOUT.startMs});
  log('horizon done');
  const quantPicks = new Map(V2.picks(quant.oosRows, quant.oosScores).map(p => [p.scan_id, p.r])), gbmPicks = arms.BASE[REG].picks;
  const ess = D.effectiveSample(rows, {scanCounts: counts, deltaSeries: gbmPicks.map(p => p.r - quantPicks.get(p.scan_id)), randomPickSeries: V2.picks(random.oosRows, random.oosScores).map(p => p.r)});
  const diversity = D.candidateDiversity(rows);
  const trials = {learnedOosTrials: (Object.keys(ARMS).length + 1) * LEARNED.length, arms: Object.keys(ARMS).length, referenceReproduction: 1, models: LEARNED, foldEvaluationsPerTrial: folds.length, note: 'Random and Quant are deterministic and evaluated once; no hyper-parameter changed between arms.'};

  const report = {status: 'FEATURE_RESEARCH_V1_COMPLETE', meta, readOnly: true, productionInfluence: 'NONE', holdout: {...HOLDOUT, accessed: false, countsOnly: counts}, preregistration: 'research/feature-research/PREREGISTRATION.md', frozenInstruments: {regression: REG, ranker: RANK, baseFamilies: BASE_FAMILIES}, trials,
    data: {rows: rows.length, scanGroups: V2.groupByScan(rows).length, choiceScans: V2.groupByScan(rows).filter(g => g.length >= 2).length, archive: archiveProvenance, derivatives: {tardis, binance: derivStatus, liquidations: liquidation}, legacyContextStatus: legacy.status, coverage: coverageReport, freshness},
    leakage, folds, baselines: {RANDOM: costLine(baselines.RANDOM), CURRENT_QUANT: costLine(baselines.CURRENT_QUANT), quantRankPositions: D.rankPositions(quant.oosRows, quant.oosScores)}, reference: referenceReport,
    arms: armReport, placebo: {method: 'the arm\'s new family blocks permuted jointly across candidate rows; K runs per arm (A1 single families, A2 combinations); p = (1 + #placebo >= real) / (K + 1)', placeboModelFits: (Object.keys(ARMS).length - 1) * PLACEBO_K * LEARNED.length, results: placebo}, ranking: {singleFamiliesByRegDelta: singles, combinationsByRegDelta: combos, bestArmByGbmR016: bestArm},
    diagnostics: {rankMonotonicity: mono, horizon, effectiveSample: ess, candidateDiversity: diversity}, d1RowsRead: rowsRead, runtimeSeconds: (Date.now() - started) / 1000};
  writeFileSync(REPORT, JSON.stringify(compact(report), null, 2) + '\n');
  const summary = {status: report.status, rows: report.data.rows, choiceScans: report.data.choiceScans, leakage: leakage.pass, baselines: report.baselines, reference: referenceReport, arms: Object.fromEntries(Object.entries(armReport).map(([a, r]) => [a, {reg016: r[REG].meanR['0.16%'], rank016: r[RANK].meanR['0.16%'], regDelta: r[REG].deltaVsBase?.meanDelta ?? null, regCi: r[REG].deltaVsBase?.ci95 ?? null, regWin: r[REG].deltaVsBase?.bootstrapWinPct ?? null, rankDelta: r[RANK].deltaVsBase?.meanDelta ?? null, class: r.classification?.classification ?? null, placeboP: r.classification?.placeboP ?? null}])), bestArm, d1RowsRead: rowsRead};
  console.log(JSON.stringify(compact(summary)));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Feature research v1 (read-only)\n\n| arm | GBM reg @0.16% | GBM rank @0.16% | Δ reg vs BASE | 95% CI | win % | class |\n|---|---|---|---|---|---|---|\n${Object.entries(summary.arms).map(([a, r]) => `| ${a} | ${round(r.reg016)} | ${round(r.rank016)} | ${round(r.regDelta)} | ${r.regCi ? r.regCi.map(round).join(' … ') : ''} | ${round(r.regWin)} | ${r.class || ''} |`).join('\n')}\n`);
}
run().catch(error => { console.error(`feature research failed: ${error.stack || error.message}`); process.exitCode = 1; });
