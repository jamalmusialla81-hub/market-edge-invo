#!/usr/bin/env node
// Dataset expansion v1: assemble HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED
// from per-asset generator outputs, then measure OLD vs EXPANDED with the
// frozen instruments only (PREREGISTRATION.md §4–§9).
//
// Read-only: D1 is queried with single SELECT statements for the OLD dataset
// (development rows only, filtered in SQL).  Nothing is written to D1, the
// Worker, production code, or a model registry.  Holdout: counts only.
// EXPANSION_SYNTHETIC=1 skips D1 and treats the regenerated old-asset rows as
// OLD, to exercise the code path; its numbers mean nothing.
import {readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync} from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import V2 from '../rank-research-v2.js';
import Rank from '../historical-rank.js';
import Clean from '../historical-rank-v2-clean.js';
import D from '../feature-research/diagnostics.js';
import X from './expansion.js';

const IN = process.env.EXPANSION_IN || 'expansion-out', MANIFESTS = process.env.EXPANSION_MANIFESTS || 'expansion-manifests';
const SCREEN = process.env.EXPANSION_SCREEN_REPORT || 'research/dataset-expansion/reports/screen-report.json';
const OUT_DATA = process.env.EXPANSION_DATASET_DIR || 'expanded-dataset', REPORT = process.env.EXPANSION_REPORT || 'expansion-report.json';
const SYNTHETIC = process.env.EXPANSION_SYNTHETIC === '1', PLACEBO_K = Number(process.env.EXPANSION_PLACEBO_K ?? 19);
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '', DATABASE = process.env.MARKET_EDGE_D1_DATABASE_ID || '';
const HOLDOUT = V2.HOLDOUT, BASE_FAMILIES = Object.freeze(['BASE', 'SETUP', 'STRUCTURE', 'VOLATILITY', 'MOMENTUM', 'LIQUIDITY', 'REGIME']);
const REG = 'GBM_FINAL_R', RANK = 'LAMBDARANK_GBM_TP1', LEARNED = [REG, RANK], MODELS = ['RANDOM', 'CURRENT_QUANT', ...LEARNED], COSTS = [0, .0008, .0016, .0025];
const FROZEN_FILES = ['quant-engine.js', 'replay-engine.js', 'research/historical-rank.js', 'research/historical-rank-v2-clean.js', 'research/candle-sequence.js', 'research/rank-research-v2.js'];
const log = message => console.error(`[${new Date().toISOString()}] ${message}`);
const round = value => typeof value === 'number' ? Math.round(value * 10000) / 10000 : value;
const compact = value => JSON.parse(JSON.stringify(value, (key, item) => round(item)));
const sha = text => createHash('sha256').update(text).digest('hex');
let rowsRead = 0;

async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('READ_ONLY_VIOLATION');
  if (!CF_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required for the read-only OLD dataset');
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF_TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
    if (response.ok && body.success !== false) { rowsRead += Number(body.result?.[0]?.meta?.rows_read || 0); return body.result?.[0]?.results || []; }
    if (attempt === 3 || (response.status < 500 && response.status !== 429)) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}
// Identical to the model-research / feature-research loader.
const loadOld = () => d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.quant_score,c.candidate_rank,c.regime,c.feature_json,c.targets_json,c.valid_current_geometry,s.scan_timestamp,seq.sequence_json FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id LEFT JOIN historical_candidate_sequences seq ON seq.candidate_id=c.candidate_id WHERE c.valid_current_geometry=1 AND json_extract(c.targets_json,'$.status')='RESOLVED' AND s.engine_version=? AND s.scan_timestamp<? ORDER BY s.scan_timestamp,c.candidate_id`, [X.OLD_VERSION, HOLDOUT.devCutoffMs]);
const oldScanCounts = async () => (await d1(`SELECT COUNT(*) AS total,SUM(CASE WHEN scan_timestamp<? THEN 1 ELSE 0 END) AS development,SUM(CASE WHEN scan_timestamp>=? THEN 1 ELSE 0 END) AS holdout FROM historical_scan_snapshots WHERE engine_version=?`, [HOLDOUT.devCutoffMs, HOLDOUT.startMs, X.OLD_VERSION]))[0];

// ------------------------------------------------------------ baselines ----
function baselines(rows, label) {
  const featureRows = rows.map(row => V2.extractFeatures(row, {}));   // BASE families need no external context
  const run = V2.walkForward(rows, featureRows, {models: MODELS, families: BASE_FAMILIES, folds: 5}), quant = run.models.CURRENT_QUANT, random = run.models.RANDOM;
  const out = {folds: run.plan, models: {}};
  for (const name of MODELS) {
    const entry = run.models[name], e = V2.evaluateOos(entry, quant, random), selected = V2.picks(entry.oosRows, entry.oosScores);
    const qp = new Map(V2.picks(quant.oosRows, quant.oosScores).map(p => [p.scan_id, p.r])), rp = new Map(V2.picks(random.oosRows, random.oosScores).map(p => [p.scan_id, p.r]));
    out.models[name] = {meanR: Object.fromEntries(COSTS.map(c => [`${(c * 100).toFixed(2)}%`, V2.summarise(V2.picks(entry.oosRows, entry.oosScores, c)).meanR])), ci95_016: [e.ci95_016.low, e.ci95_016.high],
      vsRandom016: {meanDiff: e.vsRandom016.meanDiff, ci95: [e.vsRandom016.ci95.low, e.vsRandom016.ci95.high], winPct: e.vsRandom016.ci95.pPositive * 100}, vsQuant016: {meanDiff: e.vsQuant016.meanDiff, ci95: [e.vsQuant016.ci95.low, e.vsQuant016.ci95.high], winPct: e.vsQuant016.ci95.pPositive * 100},
      oosScans: selected.length, oosChoiceScans: selected.filter(p => p.choices >= 2).length, choiceScansOnly: e.choiceScans,
      folds: entry.folds.map(f => ({fold: f.fold, testStart: f.testStart, testEnd: f.testEnd, testScans: f.testScans, meanR016: f.meanR016, vsQuant: X.mean(selected.filter(p => p.timestamp >= Date.parse(f.testStart) && p.timestamp < Date.parse(f.testEnd) + 86_400_000).map(p => p.r - qp.get(p.scan_id)))})),
      foldsPositive016: e.foldsPositive016, rankPositions: D.rankPositions(entry.oosRows, entry.oosScores), pairAccuracy: e.monotonicity.weightedPairAccuracy, spearman: e.monotonicity.meanSpearman, assets: e.assets, withoutDominantAsset: e.withoutDominantAsset, pickProfile: e.pickProfile,
      pairedSeriesVsQuant: selected.map(p => p.r - qp.get(p.scan_id)), pairedSeriesVsQuantChoice: selected.filter(p => p.choices >= 2).map(p => p.r - qp.get(p.scan_id)), pairedSeriesVsRandomChoice: selected.filter(p => p.choices >= 2).map(p => p.r - rp.get(p.scan_id))};
  }
  // Mandatory placebo gate: all BASE columns permuted jointly across rows.
  const placebo = {};
  for (const name of LEARNED) placebo[name] = [];
  for (let seed = 1; seed <= PLACEBO_K; seed++) {
    let state = seed * 7919; const rand = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const order = rows.map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const shuffled = featureRows.map((_, i) => featureRows[order[i]]), p = V2.walkForward(rows, shuffled, {models: LEARNED, families: BASE_FAMILIES, folds: 5});
    for (const name of LEARNED) placebo[name].push(V2.summarise(V2.picks(p.models[name].oosRows, p.models[name].oosScores)).meanR);
    log(`${label} placebo ${seed}/${PLACEBO_K}`);
  }
  out.placeboGate = Object.fromEntries(LEARNED.map(name => {
    const real = out.models[name].meanR['0.16%'], list = placebo[name].slice().sort((a, b) => a - b), p = (1 + list.filter(v => v >= real).length) / (list.length + 1), m = out.models[name];
    const checks = {placeboP005: p <= .05, beatsRandomCi: m.vsRandom016.ci95[0] > 0, beatsQuantCi: m.vsQuant016.ci95[0] > 0};
    return [name, {k: list.length, real016: real, placeboMean: X.mean(list), placeboMax: list.at(-1), p, checks, verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'}];
  }));
  return out;
}

async function run() {
  const started = Date.now(), meta = {synthetic: SYNTHETIC, ciRunId: process.env.GITHUB_RUN_ID || null, gitSha: process.env.GITHUB_SHA || null, generatedAt: new Date().toISOString(), frozenFiles: Object.fromEntries(FROZEN_FILES.filter(existsSync).map(f => [f, sha(readFileSync(f))]))};
  // ---- inputs ----
  const summaries = Object.fromEntries(readdirSync(IN).filter(f => f.endsWith('.summary.json')).map(f => { const s = JSON.parse(readFileSync(join(IN, f), 'utf8')); return [s.asset, s]; }));
  const rowsOf = asset => gunzipSync(readFileSync(join(IN, `${asset}.rows.jsonl.gz`))).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const screen = existsSync(SCREEN) ? JSON.parse(readFileSync(SCREEN, 'utf8')) : null;
  const newAssets = Object.keys(summaries).filter(a => !X.OLD_ASSETS.includes(a)).sort();
  const missingOld = X.OLD_ASSETS.filter(a => !summaries[a]); if (missingOld.length) throw new Error(`OLD_ASSET_OUTPUT_MISSING: ${missingOld}`);
  const manifests = Object.fromEntries(newAssets.map(a => { const p = join(MANIFESTS, `${a}.manifest.json`); return [a, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).assets.find(e => e.asset === a) : null]; }));
  const oldManifest = JSON.parse(readFileSync('research/data/v2-clean/candle-manifest.json', 'utf8'));

  // ---- Phase 2 usability + Phase 3/4 inclusion (outcome-free) ----
  const universe = {};
  for (const a of [...X.OLD_ASSETS, ...newAssets]) {
    const s = summaries[a], m = X.OLD_ASSETS.includes(a) ? oldManifest.assets.find(e => e.asset === a) : manifests[a], u = m ? X.usability(m) : {usable: false, failed: ['MANIFEST_MISSING']};
    const screenEntry = screen?.products?.find(p => p.symbol === a) || null;
    const include = X.OLD_ASSETS.includes(a) ? true : u.usable && s.development.rankable >= X.MIN_DEV_CANDIDATES && s.pointInTime.pass;
    universe[a] = {symbol: a, product: s.product, firstValidDate: screenEntry?.firstValidDate ?? (m?.first || '').slice(0, 10), lastValidDate: m?.last?.slice(0, 10) ?? null, coverage5m: u.coverage5m, coverageNative1h: u.coverage1h, coverageDaily: u.coverage1d, missingMonths: u.missingMonths, majorGaps: u.majorGaps, liquidity: screenEntry ? {medianDailyNotionalUsd: screenEntry.medianDailyNotionalUsd, lowNotionalDayShare: screenEntry.lowNotionalDayShare} : null, listing: s.development.firstEligibleScan ? `joins at first eligible scan ${s.development.firstEligibleScan.slice(0, 10)}` : 'never eligible in development', archiveIssues: m?.issues ?? null, usable: u.usable, usabilityFailed: u.failed, devCandidates: s.development.rankable, devEligibleScans: s.development.eligibleScans, pointInTime: s.pointInTime.pass, included: include, reason: X.OLD_ASSETS.includes(a) ? 'EXISTING_UNIVERSE' : include ? 'USABLE_AND_MIN_HISTORY' : !u.usable ? `NOT_USABLE: ${u.failed.join(', ')}` : !s.pointInTime.pass ? 'POINT_IN_TIME_FAIL' : `BELOW_MIN_DEV_CANDIDATES (${s.development.rankable} < ${X.MIN_DEV_CANDIDATES})`};
  }
  const included = Object.keys(universe).filter(a => universe[a].included), usableNew = newAssets.filter(a => universe[a].usable);
  log(`included ${included.length} assets: ${included.join(',')}`);

  // Phase 4: labels stripped before the check.
  const raw = Object.fromEntries([...new Set([...included, ...usableNew])].map(a => [a, rowsOf(a)]));
  const unlabeled = Object.values(raw).flat().filter(r => r.valid_current_geometry).map(({asset, direction, strategy, timestamp}) => ({asset, direction, strategy, timestamp}));
  const diversityValue = X.diversityValue(unlabeled, usableNew);

  // ---- Phase 5: assemble the expanded dataset ----
  const byScan = new Map();
  for (const a of included) for (const row of raw[a]) { const list = byScan.get(row.timestamp) || []; list.push(row); byScan.set(row.timestamp, list); }
  const datasetRows = [], snapshots = [];
  for (const ts of [...byScan.keys()].sort((a, b) => a - b)) {
    const list = byScan.get(ts).map(({label, ...row}) => { const features = {...row.feature_json, provenance: {...row.feature_json.provenance, dataset_version: X.EXPANDED_VERSION, generator_policy_version: Clean.NATIVE_HTF_VERSION}}; return {row: {...row, feature_json: features, feature_hash: Rank.hash(features), targets: {status: 'PENDING_OUTCOME'}}, label}; });
    const labels = new Map(list.map(({row, label}) => [row.candidate_id, label]));
    const finalized = Rank.finalizeCandidates(list.map(item => item.row));
    for (const row of finalized) { const label = labels.get(row.candidate_id); row.targets = label ? {...label, dataset_version: X.EXPANDED_VERSION} : {status: 'NOT_RANKABLE'}; row.scan_id = X.scanId(ts); row.scan_timestamp = ts; row.dataset_version = X.EXPANDED_VERSION; datasetRows.push(row); }
    const snap = {scan_id: X.scanId(ts), scan_timestamp: ts, engine_version: X.EXPANDED_VERSION, assets: [...new Set(finalized.map(r => r.asset))].sort(), candidate_count: finalized.length}; snapshots.push({...snap, snapshot_hash: Rank.hash(snap)});
  }
  mkdirSync(OUT_DATA, {recursive: true});
  const dataText = datasetRows.map(row => JSON.stringify(row)).join('\n') + '\n', snapText = snapshots.map(s => JSON.stringify(s)).join('\n') + '\n';
  writeFileSync(join(OUT_DATA, 'candidates.jsonl.gz'), gzipSync(dataText)); writeFileSync(join(OUT_DATA, 'snapshots.jsonl.gz'), gzipSync(snapText));
  const datasetManifest = {dataset_version: X.EXPANDED_VERSION, generator_policy: Clean.NATIVE_HTF_VERSION, label_version: Clean.LABEL_VERSION, holdout: HOLDOUT, development_only: true, assets: included, candidates: datasetRows.length, scans: snapshots.length, candidates_sha256: sha(dataText), snapshots_sha256: sha(snapText), per_asset: X.countBy(datasetRows, r => r.asset), frozen_files_sha256: meta.frozenFiles, archive: {old: {artifact_run: '36313185824', manifest: 'research/data/v2-clean/candle-manifest.json'}, new: Object.fromEntries(included.filter(a => !X.OLD_ASSETS.includes(a)).map(a => [a, {months: manifests[a]?.months?.length, content_sha256: manifests[a]?.content_sha256}]))}};
  writeFileSync(join(OUT_DATA, 'dataset-manifest.json'), JSON.stringify(datasetManifest, null, 1) + '\n');
  log(`dataset: ${datasetRows.length} rows, ${snapshots.length} scans`);

  // ---- OLD (D1, read-only) and EXPANDED as parsed development rows ----
  const expanded = V2.parseRows(datasetRows);
  let oldParsed, oldCounts = null;
  if (SYNTHETIC) oldParsed = V2.parseRows(X.OLD_ASSETS.flatMap(a => raw[a]).map(({label, ...row}) => ({...row, scan_id: `old-${row.timestamp}`, targets: label || {status: 'NOT_RANKABLE'}})));
  else { oldCounts = await oldScanCounts(); oldParsed = V2.parseRows(await loadOld()); }
  if (oldParsed.excludedHoldoutOrEmbargo || expanded.excludedHoldoutOrEmbargo) throw new Error('HOLDOUT_BREACH: development loader returned rows beyond the cutoff');
  const OLD = oldParsed.rows, NEW = expanded.rows; log(`OLD ${OLD.length} rows, EXPANDED ${NEW.length} rows`);

  // ---- reproduction gate ----
  const key = r => `${r.timestamp}|${r.asset}|${r.strategy}|${r.direction}`, newIndex = new Map(NEW.filter(r => X.OLD_ASSETS.includes(r.asset)).map(r => [key(r), r])), mism = [];
  let matched = 0; const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(a)));
  for (const r of OLD) { const n = newIndex.get(key(r)); if (!n) { mism.push({key: key(r), reason: 'MISSING_IN_EXPANDED'}); continue; } const bad = ['entry', 'stop', 'quant_score'].filter(f => !close(r[f], n[f])).concat(close(r.targets.FINAL_R, n.targets.FINAL_R) ? [] : ['FINAL_R']); if (bad.length) mism.push({key: key(r), fields: bad}); else matched++; newIndex.delete(key(r)); }
  const reproduction = {oldRows: OLD.length, matched, mismatches: mism.length, extraInExpanded: newIndex.size, examples: mism.slice(0, 10).concat([...newIndex.keys()].slice(0, 5).map(k => ({key: k, reason: 'EXTRA_IN_EXPANDED'}))), pass: mism.length === 0 && newIndex.size === 0};
  log(`reproduction: ${JSON.stringify({matched, mismatches: mism.length, extra: newIndex.size})}`);

  // ---- leakage checks ----
  const devRows = datasetRows.filter(r => r.valid_current_geometry);
  const leakage = {noRowAtOrAfterDevCutoff: datasetRows.every(r => r.scan_timestamp < HOLDOUT.devCutoffMs), featuresCloseAtScan: devRows.every(r => r.feature_json.provenance.latest_feature_candle_close === r.scan_timestamp && Object.values(r.feature_json.provenance.history_window.frames).every(f => f.last_close === r.scan_timestamp)),
    labelWindowStartsAtScan: devRows.every(r => r.targets.status !== 'RESOLVED' || r.targets.entry_timestamp === r.scan_timestamp), labelWindowBeforeHoldout: devRows.every(r => r.scan_timestamp + Rank.OUTCOME_BARS * 300_000 <= HOLDOUT.startMs),
    featureNamesPreEntry: (() => { try { NEW.slice(0, 200).forEach(r => V2.assertPreEntryFeatureNames(V2.extractFeatures(r, {}))); return true; } catch { return false; } })(),
    pointInTimeRegeneration: Object.fromEntries(included.map(a => [a, {sampled: summaries[a].pointInTime.sampled, compared: summaries[a].pointInTime.candidatesCompared, mismatches: summaries[a].pointInTime.mismatches.length}])),
    holdoutNeverResolved: 'holdout and embargo scans are counted in the generator and never stored or resolved', d1: SYNTHETIC ? 'SKIPPED_SYNTHETIC' : 'SELECT-only, scan_timestamp < devCutoff in SQL'};
  leakage.pass = leakage.noRowAtOrAfterDevCutoff && leakage.featuresCloseAtScan && leakage.labelWindowStartsAtScan && leakage.labelWindowBeforeHoldout && leakage.featureNamesPreEntry && Object.values(leakage.pointInTimeRegeneration).every(p => p.mismatches === 0);
  log(`leakage: ${leakage.pass ? 'PASS' : 'FAIL'}`);
  if (!reproduction.pass || !leakage.pass) { const report = compact({status: !leakage.pass ? 'LEAKAGE_FAIL_STOPPED' : 'REPRODUCTION_FAIL_STOPPED', meta, reproduction, leakage, universe}); writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n'); console.log(JSON.stringify(report).slice(0, 4000)); process.exitCode = 1; return; }

  // ---- Phases 7–10 ----
  const diversity = {OLD: X.diversityMetrics(OLD), EXPANDED: X.diversityMetrics(NEW)};
  const daily = Object.fromEntries(included.map(a => [a, summaries[a].dailyCloses]));
  const redundancy = X.redundancy(NEW, daily, included);
  const regimeOf = X.regimeClassifier(summaries.BTC.dailyCloses, [...new Set(NEW.map(r => r.timestamp))]);
  const temporal = {OLD: X.temporal(OLD, regimeOf), EXPANDED: X.temporal(NEW, regimeOf)};
  const holdoutCounts = (() => { const per = {}; for (const a of included) for (const [ts, n] of Object.entries(summaries[a].holdoutCountsOnly.perScan)) per[ts] = (per[ts] || 0) + n; const v = Object.values(per); return {scansWithCandidates: v.length, choiceScans: v.filter(n => n >= 2).length, rankableCandidates: v.reduce((x, y) => x + y, 0), gridScans: summaries.BTC.holdoutCountsOnly.scans, outcomesRead: 0}; })();
  log('diversity/redundancy/temporal done');

  // ---- Phase 11/12 ----
  const base = {OLD: baselines(OLD, 'OLD'), EXPANDED: baselines(NEW, 'EXPANDED')}; log('baselines done');

  // ---- Phase 13 ----
  const pw = Object.fromEntries(Object.entries(base).map(([k, b]) => [k, X.power(b.models[REG].pairedSeriesVsQuantChoice, b.models[REG].oosChoiceScans)]));
  for (const b of Object.values(base)) for (const m of Object.values(b.models)) { delete m.pairedSeriesVsQuant; delete m.pairedSeriesVsQuantChoice; delete m.pairedSeriesVsRandomChoice; }

  const dev = rows => ({scanGroups: V2.groupByScan(rows).length, choiceScans: V2.groupByScan(rows).filter(g => g.length >= 2).length, candidates: rows.length});
  const report = {status: 'DATASET_EXPANSION_V1_COMPLETE', meta, readOnly: true, productionInfluence: 'NONE', preregistration: 'research/dataset-expansion/PREREGISTRATION.md',
    holdout: {...HOLDOUT, moved: false, outcomesRead: false, oldCountsOnly: oldCounts, expandedCountsOnly: holdoutCounts},
    universe: {oldAssets: X.OLD_ASSETS, newCandidatesFetched: newAssets, included, added: included.filter(a => !X.OLD_ASSETS.includes(a)), rejected: newAssets.filter(a => !universe[a].included).map(a => ({asset: a, reason: universe[a].reason})), perAsset: universe, screen: screen ? {usdProducts: screen.usdProducts, passed: screen.passed, failureCounts: screen.failureCounts} : null},
    diversityValue, dataset: {...datasetManifest, generation: {candidatesAll: datasetRows.length, rankable: devRows.length, resolved: devRows.filter(r => r.targets.status === 'RESOLVED').length, unresolved: X.countBy(devRows.filter(r => r.targets.status !== 'RESOLVED'), r => r.targets.reason || r.targets.status), scansWithCandidate: snapshots.length}, parse: {OLD: {...dev(OLD), droppedStale: oldParsed.droppedStaleInputs, droppedOther: oldParsed.droppedOther}, EXPANDED: {...dev(NEW), droppedStale: expanded.droppedStaleInputs, droppedOther: expanded.droppedOther}}},
    reproduction, leakage, diversity, redundancy, temporal, baselines: base, power: pw, d1RowsRead: rowsRead, runtimeSeconds: (Date.now() - started) / 1000};
  writeFileSync(REPORT, JSON.stringify(compact(report), null, 1) + '\n');
  const line = (k, m) => `| ${k} | ${['0.00%', '0.08%', '0.16%', '0.25%'].map(c => round(m.meanR[c])).join(' | ')} | ${round(m.vsQuant016.meanDiff)} [${m.vsQuant016.ci95.map(round).join(', ')}] | ${m.rankPositions.flag} |`;
  const summary = `## Dataset expansion v1\n\nIncluded ${included.length} assets (${report.universe.added.length} new). Dev choice scans OLD ${diversity.OLD.choiceScans} → EXPANDED ${diversity.EXPANDED.choiceScans}.\n\n| model | 0.00% | 0.08% | 0.16% | 0.25% | vs Quant @0.16 [CI] | monotonicity |\n|---|---|---|---|---|---|---|\n${Object.entries(base).flatMap(([k, b]) => Object.entries(b.models).map(([n, m]) => line(`${k} ${n}`, m))).join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify(compact({status: report.status, included, added: report.universe.added, rejected: report.universe.rejected, reproduction: {matched, pass: reproduction.pass}, leakage: leakage.pass, choiceScans: {OLD: diversity.OLD.choiceScans, EXPANDED: diversity.EXPANDED.choiceScans}, at016: Object.fromEntries(Object.entries(base).map(([k, b]) => [k, Object.fromEntries(Object.entries(b.models).map(([n, m]) => [n, m.meanR['0.16%']]))])), placebo: Object.fromEntries(Object.entries(base).map(([k, b]) => [k, Object.fromEntries(Object.entries(b.placeboGate).map(([n, g]) => [n, g.verdict + ' p=' + round(g.p)]))])), power: pw})));
}
run().catch(error => { console.error(`dataset expansion failed: ${error.stack || error.message}`); process.exitCode = 1; });
