#!/usr/bin/env node
// Read-only runner for the V2 rank research suite.  It issues SELECT queries
// only (enforced below), never calls the Worker ingest endpoint, never writes
// to D1, and never reads a row at or after the sealed holdout's development
// cutoff.  Output is a local JSON report plus a compact stdout summary.
import {writeFileSync, appendFileSync} from 'node:fs';
import V2 from './rank-research-v2.js';
import Quant from '../quant-engine.js';
import Replay from '../replay-engine.js';
import Rank from './historical-rank.js';
import {archiveCsv} from './recover-historical-rank-outcomes.mjs';
import Registry from './dataset-registry.js';

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8ea7796a8fb13ffb612245e8a08a55d6', DATABASE = process.env.MARKET_EDGE_D1_DATABASE_ID || '39a4082e-41a4-45e9-9b76-99cf10eaca01';
const ENGINE = process.env.HISTORICAL_RANK_ENGINE_VERSION || 'HISTORICAL-RANK-V1', REPORT = process.env.RANK_V2_REPORT || 'rank-research-v2-report.json';
const CROSS_MARKET = process.env.RANK_V2_CROSS_MARKET !== '0', DERIVATIVES = process.env.RANK_V2_DERIVATIVES !== '0', GENERATOR_DIAGNOSIS = process.env.RANK_V2_GENERATOR_DIAGNOSIS !== '0';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC'], HOUR = 3_600_000, BASE_MS = 300_000;
if (!/^[A-Z0-9-]+$/.test(ENGINE)) throw new Error('Invalid engine generation');
let rowsRead = 0;
const MIN_CHOICE_SCANS = Math.max(30, Number(process.env.RANK_V2_MIN_CHOICE_SCANS) || 60);
const READ_BUDGET = Math.max(1000, Number(process.env.RANK_V2_D1_READ_BUDGET) || 300_000);

async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('READ_ONLY_VIOLATION: only single SELECT statements are permitted');
  if (!CF_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required for read-only research');
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF_TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
    if (response.ok && body.success !== false) { rowsRead += Number(body.result?.[0]?.meta?.rows_read || 0); if (rowsRead > READ_BUDGET) throw new Error(`D1_READ_BUDGET_EXCEEDED: ${rowsRead} rows read; aborting to protect the production quota`); return body.result?.[0]?.results || []; }
    if (attempt === 3 || (response.status < 500 && response.status !== 429)) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}

async function loadCandidates() {
  return d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.quant_score,c.candidate_rank,c.regime,c.feature_json,c.targets_json,c.valid_current_geometry,s.scan_timestamp,seq.sequence_json FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id LEFT JOIN historical_candidate_sequences seq ON seq.candidate_id=c.candidate_id WHERE c.valid_current_geometry=1 AND json_extract(c.targets_json,'$.status')='RESOLVED' AND s.engine_version=? AND s.scan_timestamp<? ORDER BY s.scan_timestamp,c.candidate_id`, [ENGINE, V2.HOLDOUT.devCutoffMs]);
}
async function loadAllCandidateMeta() {
  return d1(`SELECT c.candidate_id,c.asset,c.valid_current_geometry,json_extract(c.targets_json,'$.status') AS status FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id WHERE s.engine_version=? AND s.scan_timestamp<?`, [ENGINE, V2.HOLDOUT.devCutoffMs]).then(rows => rows.map(row => ({...row, targets_json: JSON.stringify({status: row.status})})));
}
async function scanCounts() {
  const [row = {}] = await d1(`SELECT COUNT(*) AS total,SUM(CASE WHEN scan_timestamp<? THEN 1 ELSE 0 END) AS development,SUM(CASE WHEN scan_timestamp>=? AND scan_timestamp<? THEN 1 ELSE 0 END) AS embargo,SUM(CASE WHEN scan_timestamp>=? THEN 1 ELSE 0 END) AS holdout,MIN(scan_timestamp) AS first,MAX(scan_timestamp) AS last FROM historical_scan_snapshots WHERE engine_version=?`, [V2.HOLDOUT.devCutoffMs, V2.HOLDOUT.devCutoffMs, V2.HOLDOUT.startMs, V2.HOLDOUT.startMs, ENGINE]);
  return row;
}
// Cross-market context comes from Binance USD-M public monthly 1h archives, not
// D1, so this research never consumes the production database's read quota.
// A 1h bar is usable only once it has closed (closeTime <= scan timestamp).
async function archiveMonths(kind, symbol, from, to, suffix) {
  const rows = [], missing = [];
  for (let date = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1)); date.getTime() <= to; date.setUTCMonth(date.getUTCMonth() + 1)) {
    const month = date.toISOString().slice(0, 7), response = await fetch(`https://data.binance.vision/data/futures/um/monthly/${kind}/${symbol}/${suffix ? `${suffix}/` : ''}${symbol}-${suffix || kind}-${month}.zip`);
    if (!response.ok) { missing.push(month); continue; }
    rows.push(...archiveCsv(await response.arrayBuffer()));
  }
  return {rows, missing};
}
const msTime = value => { const time = Number(value); return time > 1e14 ? Math.floor(time / 1000) : time; };
async function hourlyCloses(asset, from, to) {
  const {rows, missing} = await archiveMonths('klines', `${asset}USDT`, from, to, '1h');
  const series = rows.map(row => ({closeTime: msTime(row[0]) + HOUR, close: Number(row[4])})).filter(row => Number.isFinite(row.closeTime) && row.close > 0).sort((a, b) => a.closeTime - b.closeTime);
  return {series, missing};
}
// Binance USD-M funding: each rate is known at its settlement time.
async function funding(asset, from, to) {
  const {rows, missing} = await archiveMonths('fundingRate', `${asset}USDT`, from, to, null);
  return {series: rows.map(row => ({time: msTime(row[0]), rate: Number(row[2])})).filter(row => Number.isFinite(row.time) && Number.isFinite(row.rate)).sort((a, b) => a.time - b.time), missing};
}
// Why is the generator narrow?  Re-evaluate the shared quant gates for every
// asset at a few consecutive development scans, read-only, and record which
// strategy preconditions fail.  Nothing is persisted.
async function generatorDiagnosis(timestamps) {
  const first = timestamps[0], last = timestamps.at(-1), start = first - (17568 + 300) * BASE_MS, stats = {};
  for (const asset of ASSETS) {
    const raw = []; let cursor = start - 1;
    for (;;) { const rows = await d1(`SELECT open_time,open,high,low,close,volume FROM canonical_candles WHERE asset=? AND exchange='COINBASE' AND interval='5m' AND open_time>? AND open_time<? ORDER BY open_time LIMIT 10000`, [asset, cursor, last + BASE_MS]); raw.push(...rows.map(row => ({time: Number(row.open_time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume)}))); if (rows.length < 10000) break; cursor = Number(rows.at(-1).open_time); }
    const derived = Replay.derived(raw), entry = stats[asset] = {canonicalCandlesLoaded: raw.length, canonicalFirst: raw[0] ? new Date(raw[0].time).toISOString() : null, canonicalLast: raw.at(-1) ? new Date(raw.at(-1).time).toISOString() : null, evaluations: 0, emitted: 0, readinessFailures: 0, volumeAvailable: 0, relativeVolume: [], upTrend: 0, downTrend: 0, extended: 0, trendRsiBand: 0, retest: 0, sweep: 0, regimes: {}, gates: {TREND_CONTINUATION: 0, BREAKOUT_RETEST: 0, MOMENTUM_CONTINUATION: 0, MEAN_REVERSION: 0, LIQUIDITY_SWEEP: 0}};
    for (const timestamp of timestamps) {
      const snapshot = Replay.cachedSnapshot(derived, timestamp); if (!Replay.readiness(snapshot).ready) { entry.readinessFailures++; continue; }
      const evaluated = Quant.evaluateSetup({timeframes: snapshot.timeframes, settings: Rank.SETTINGS}), f = evaluated.timeframes?.h1; if (!f?.available) { entry.readinessFailures++; continue; }
      entry.evaluations++; entry.emitted += Quant.strategyCandidates(f).length;
      const vr = f.volumeAvailable ? f.relativeVolume : .75, up = f.price > f.ema20 && f.ema20 > f.ema50 && f.ema20Slope > 0 && f.structure.trend !== 'short', down = f.price < f.ema20 && f.ema20 < f.ema50 && f.ema20Slope < 0 && f.structure.trend !== 'long', extended = Math.abs(f.price - f.ema20) > f.atr * 2.2, regime = Quant.classifyRegime(f);
      entry.volumeAvailable += f.volumeAvailable ? 1 : 0; entry.relativeVolume.push(vr); entry.upTrend += up ? 1 : 0; entry.downTrend += down ? 1 : 0; entry.extended += extended ? 1 : 0; entry.retest += f.structure.retest ? 1 : 0; entry.sweep += f.structure.liquiditySweep ? 1 : 0; entry.regimes[regime] = (entry.regimes[regime] || 0) + 1;
      entry.trendRsiBand += (up && f.rsi >= 48 && f.rsi <= 68) || (down && f.rsi >= 32 && f.rsi <= 52) ? 1 : 0;
      entry.gates.TREND_CONTINUATION += ((up && f.rsi >= 48 && f.rsi <= 68) || (down && f.rsi >= 32 && f.rsi <= 52)) && !extended && !f.structure.exhaustion && vr >= .8 ? 1 : 0;
      entry.gates.BREAKOUT_RETEST += f.structure.retest && vr >= 1 ? 1 : 0;
      entry.gates.MOMENTUM_CONTINUATION += ((up && f.roc5 > 2 && f.acceleration > 0 && f.rsi >= 55 && f.rsi <= 70 && f.macd > f.macdSignal) || (down && f.roc5 < -2 && f.acceleration < 0 && f.rsi >= 30 && f.rsi <= 45 && f.macd < f.macdSignal)) && vr >= 1.1 && !extended ? 1 : 0;
      entry.gates.MEAN_REVERSION += ['RANGE', 'HIGH-VOLATILITY RANGE'].includes(regime) && (f.rsi < 30 || f.rsi > 70) ? 1 : 0;
      entry.gates.LIQUIDITY_SWEEP += f.structure.liquiditySweep && (f.structure.choch === f.structure.liquiditySweep || f.structure.rejection === f.structure.liquiditySweep) ? 1 : 0;
    }
    entry.relativeVolume = {median: median(entry.relativeVolume), below08: entry.relativeVolume.filter(v => v < .8).length};
  }
  return {scanTimestamps: timestamps.map(t => new Date(t).toISOString()), perAsset: stats};
}
function median(values) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), m = Math.floor(sorted.length / 2); return sorted.length ? (sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) : null; }
const round = value => typeof value === 'number' ? Math.round(value * 10000) / 10000 : value;
const compact = value => JSON.parse(JSON.stringify(value, (key, item) => round(item)));

// Signal/label integrity audit.  Uses an independent venue (Binance 1h) to
// check that frozen entries sit at the real market price and that stored
// MFE/MAE are consistent with the realised 24h range.  Audit only: the
// forward-looking range is never used as a feature or for model selection.
function integrityAudit(rows, market) {
  const byAsset = Object.groupBy(rows, row => row.asset), geometry = {};
  for (const [asset, list] of Object.entries(byAsset)) geometry[asset] = {candidates: list.length, distinctStopPct: new Set(list.map(row => (V2.stopFraction(row) * 100).toFixed(4))).size, distinctEntry: new Set(list.map(row => row.entry)).size, distinctSequenceTail: new Set(list.map(row => JSON.stringify((row.sequence?.timeframes?.h1?.rows || []).slice(-3).map(item => item.close_to_close)))).size, topStopPct: Object.entries(Object.groupBy(list, row => (V2.stopFraction(row) * 100).toFixed(4))).sort((a, b) => b[1].length - a[1].length).slice(0, 3).map(([pct, items]) => [pct, items.length])};
  const price = [], label = [];
  for (const row of rows) {
    const series = market?.[row.asset]; if (!series) continue;
    const ref = V2.closeAt(series, row.timestamp); if (ref) price.push({asset: row.asset, date: new Date(row.timestamp).toISOString().slice(0, 10), ratio: row.entry / ref, entry: row.entry, binance: ref, source: row.targets.outcome_source || 'COINBASE_CANONICAL'});
    const path = series.filter(item => item.closeTime > row.timestamp && item.closeTime <= row.timestamp + V2.OUTCOME_HORIZON_MS).map(item => item.close);
    if (path.length >= 20 && ref) { const s = row.direction === 'long' ? 1 : -1, distance = Math.abs(row.entry - row.stop), fav = Math.max(0, ...path.map(close => s * (close - ref) / distance)), adv = Math.min(0, ...path.map(close => s * (close - ref) / distance)); label.push({source: row.targets.outcome_source || 'COINBASE_CANONICAL', storedMfe: Number(row.targets.MFE), closeMfeLowerBound: fav, storedMae: Number(row.targets.MAE), closeMaeUpperBound: adv, stopHit: row.targets.STOP_HIT, candidate_id: row.candidate_id, asset: row.asset, date: new Date(row.timestamp).toISOString().slice(0, 10)}); }
  }
  const off = price.filter(item => Math.abs(item.ratio - 1) > .02), inconsistent = label.filter(item => item.closeMfeLowerBound > item.storedMfe + .25 || item.closeMaeUpperBound < item.storedMae - .25 || (item.closeMaeUpperBound <= -1.05 && !item.stopHit));
  const summary = list => Object.fromEntries(Object.entries(Object.groupBy(list, item => item.source)).map(([k, v]) => [k, v.length]));
  return {geometry, priceVsBinance: {checked: price.length, medianRatio: median(price.map(item => item.ratio)), offBy2pct: off.length, offBySource: summary(off), examples: off.slice(0, 6)}, labelVsRealisedRange: {checked: label.length, inconsistent: inconsistent.length, inconsistentBySource: summary(inconsistent), checkedBySource: summary(label), medianStoredMfe: median(label.map(item => item.storedMfe)), medianCloseMfeLowerBound: median(label.map(item => item.closeMfeLowerBound)), examples: inconsistent.slice(0, 6)}};
}
async function run() {
  // Invalid generations may only be audited, never used as model evidence.
  const registry = Registry.status(ENGINE), auditOnly = !registry.trainable;
  const started = Date.now(), counts = await scanCounts(), raw = await loadCandidates(), {rows, excludedHoldoutOrEmbargo, droppedOther, droppedStaleInputs, staleByLabelSource} = V2.parseRows(raw), allDev = V2.parseRows(raw, {includeStale: true}).rows;
  if (excludedHoldoutOrEmbargo) throw new Error('HOLDOUT_BREACH: loader returned rows beyond the development cutoff');
  if (!allDev.length) { const empty = {version: V2.VERSION, engine: ENGINE, status: 'NO_RESOLVED_DEVELOPMENT_ROWS', scanCounts: counts, readOnly: true, productionInfluence: 'NONE', d1RowsRead: rowsRead}; writeFileSync(REPORT, JSON.stringify(empty, null, 2) + '\n'); console.log(JSON.stringify(empty)); return; }
  const meta = await loadAllCandidateMeta(), audit = V2.datasetAudit(rows, meta), auditIncludingStale = V2.datasetAudit(allDev), first = allDev[0].timestamp, last = allDev.at(-1).timestamp, context = {}, contextStatus = {};
  const validity = {rawResolvedDevelopmentRows: allDev.length, freshRows: rows.length, droppedStaleInputs, staleByLabelSource, freshScanGroups: audit.scanGroups, freshChoiceScanGroups: audit.choiceScanGroups, freshWindow: rows.length ? [new Date(rows[0].timestamp).toISOString(), new Date(rows.at(-1).timestamp).toISOString()] : null};
  for (const [enabled, key, loader, from] of [[CROSS_MARKET, 'crossMarket', hourlyCloses, first - 5 * 24 * HOUR], [DERIVATIVES, 'funding', funding, first - 35 * 24 * HOUR]]) {
    if (!enabled) { contextStatus[key] = 'DISABLED'; continue; }
    try { const loaded = {}, status = {}; for (const asset of ASSETS) { const {series, missing} = await loader(asset, from, last); if (series.length) loaded[asset] = series; status[asset] = {points: series.length, missingMonths: missing}; } if (!Object.keys(loaded).length) throw new Error('no archive data'); context[key] = loaded; contextStatus[key] = status; }
    catch (error) { contextStatus[key] = `UNAVAILABLE: ${error.message}`; }
  }
  const integrity = integrityAudit(allDev, context.crossMarket);
  if (auditOnly || audit.choiceScanGroups < MIN_CHOICE_SCANS) {
    const report = {version: V2.VERSION, engine: ENGINE, status: auditOnly ? `AUDIT_ONLY_${registry.status}` : 'INSUFFICIENT_VALID_DATA', reason: auditOnly ? registry.reason : `Only ${audit.choiceScanGroups} fresh choice scan groups (< ${MIN_CHOICE_SCANS}); no model is trained on stale or invalid rows`, readOnly: true, productionInfluence: 'NONE', holdout: V2.HOLDOUT, scanCounts: counts, validity, audit, auditIncludingStale, contextStatus, integrity, d1RowsRead: rowsRead};
    writeFileSync(REPORT, JSON.stringify(compact(report), null, 2) + '\n'); console.log(JSON.stringify(compact(report))); return;
  }
  const features = V2.featureTable(rows, context), coverage = Object.fromEntries(V2.FAMILIES.map(family => { const cols = V2.columns(features, [family]); return [family, {columns: cols.length, nonNullShare: cols.length ? V2.matrix(features, cols).flat().filter(Number.isFinite).length / (cols.length * features.length) : 0}]; }));
  const wf = V2.walkForward(rows, features, {folds: 5}), evaluations = {};
  for (const name of V2.MODEL_NAMES) evaluations[name] = V2.evaluateOos(wf.models[name], wf.models.CURRENT_QUANT, wf.models.RANDOM);
  const oracle = V2.summarise(V2.picks(wf.models.RANDOM.oosRows, wf.models.RANDOM.oosRows.map(row => Number(row.targets.FINAL_R))));
  const challengers = V2.MODEL_NAMES.filter(name => !['RANDOM', 'CURRENT_QUANT'].includes(name)), ranked = challengers.slice().sort((a, b) => evaluations[b].atCosts['0.16%'].meanR - evaluations[a].atCosts['0.16%'].meanR);
  const featureModels = ['WITHIN_SCAN_RIDGE', 'LAMBDARANK_GBM_FINAL_R', 'RIDGE_FINAL_R', 'GBM_FINAL_R', 'LOGISTIC_TP1', 'LAMBDARANK_GBM_TP1'], ablationModel = featureModels.slice().sort((a, b) => evaluations[b].atCosts['0.16%'].meanR - evaluations[a].atCosts['0.16%'].meanR)[0];
  const ablation = V2.ablations(rows, features, ablationModel, {folds: 5});
  let diagnosis = null;
  if (GENERATOR_DIAGNOSIS) { try { const groups = V2.groupByScan(rows), middle = Math.floor(groups.length / 2); diagnosis = await generatorDiagnosis(groups.slice(middle, middle + 5).map(group => group[0].timestamp)); } catch (error) { diagnosis = {status: `UNAVAILABLE: ${error.message}`}; } }
  const implausible = rows.filter(row => Number(row.targets.MFE) < .1 && Number(row.targets.MAE) > -.1);
  const labelDiagnostics = {implausibleFlat24hLabels: implausible.length, bySource: Object.fromEntries(Object.entries(Object.groupBy(implausible, row => row.targets.outcome_source || 'COINBASE_CANONICAL')).map(([k, v]) => [k, v.length])), byAsset: Object.fromEntries(Object.entries(Object.groupBy(implausible, row => row.asset)).map(([k, v]) => [k, v.length])), examples: implausible.slice(0, 5).map(row => ({candidate_id: row.candidate_id, asset: row.asset, date: new Date(row.timestamp).toISOString().slice(0, 10), stopPct: V2.stopFraction(row) * 100, mfe: row.targets.MFE, mae: row.targets.MAE, finalR: row.targets.FINAL_R, bars: row.targets.duration_bars, source: row.targets.outcome_source || 'COINBASE_CANONICAL'}))};
  const report = {version: V2.VERSION, engine: ENGINE, generatedAt: new Date().toISOString(), readOnly: true, productionInfluence: 'NONE', holdout: V2.HOLDOUT, scanCounts: counts, validity, droppedOther, audit, auditIncludingStale, contextStatus, featureCoverage: coverage, walkForwardPlan: wf.plan, evaluations, oracleUpperBound016: oracle, challengerOrderByOos016: ranked, acceptance: Object.fromEntries(challengers.map(name => [name, V2.acceptance(evaluations[name])])), ablationModel, ablation, generatorDiagnosis: diagnosis, labelDiagnostics, integrity, gru: 'NOT_RUN: no audited tensor backend; a hand-written recurrent backprop would be unaudited code on ~300 scan groups', multiTask: 'NOT_RUN: fewer than 200 choice scans cannot support separate FINAL_R/TP1/MFE/MAE heads without overfitting', d1RowsRead: rowsRead, runtimeSeconds: (Date.now() - started) / 1000};
  writeFileSync(REPORT, JSON.stringify(compact(report), null, 2) + '\n');
  const line = name => { const e = evaluations[name], c = e.atCosts; return {model: name, '0.08%': c['0.08%'].meanR, '0.16%': c['0.16%'].meanR, ci016: [e.ci95_016.low, e.ci95_016.high], median016: c['0.16%'].medianR, pf016: c['0.16%'].profitFactor, dd016: c['0.16%'].maxDrawdownR, '0.25%': c['0.25%'].meanR, '0.40%': c['0.40%'].meanR, tp1: c['0.16%'].tp1Rate, stop: c['0.16%'].stopRate, mfe: c['0.16%'].mfe, mae: c['0.16%'].mae, vsQuant: [e.vsQuant016.meanDiff, e.vsQuant016.ci95.low, e.vsQuant016.ci95.high], folds016: e.folds.map(f => f.meanR016), pairAcc: e.monotonicity.weightedPairAccuracy, spearman: e.monotonicity.meanSpearman, buckets: Object.fromEntries(Object.entries(e.rankBuckets).map(([k, v]) => [k, [v.n, v.meanR]])), assets: e.assets, withoutDominant: e.withoutDominantAsset, choiceScans: e.choiceScans, picks: e.pickProfile, verdict: V2.acceptance(e).verdict}; };
  const summary = {status: 'RANK_RESEARCH_V2_COMPLETE', scanCounts: counts, validity, audit, contextStatus, featureCoverage: coverage, walkForwardPlan: wf.plan, oracle016: oracle.meanR, models: V2.MODEL_NAMES.map(line), ablationModel, ablation, generatorDiagnosis: diagnosis, labelDiagnostics, integrity, d1RowsRead: rowsRead};
  console.log(JSON.stringify(compact(summary)));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Rank research V2 (read-only)\n\n| model | 0.16% mean R | 95% CI | vs Quant | pair acc | verdict |\n|---|---|---|---|---|---|\n${summary.models.map(m => `| ${m.model} | ${round(m['0.16%'])} | ${round(m.ci016[0])} … ${round(m.ci016[1])} | ${round(m.vsQuant[0])} | ${round(m.pairAcc)} | ${m.verdict} |`).join('\n')}\n`);
}
run().catch(error => { console.error(`rank research v2 failed: ${error.message}`); process.exitCode = 1; });
