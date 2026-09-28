#!/usr/bin/env node
// Dataset expansion v1: runs the FROZEN native-HTF generator for ONE asset
// over the fixed daily scan grid, offline, from a verified Coinbase archive.
// See PREREGISTRATION.md.  Nothing here is written to D1 or the Worker.
//
// - Scan ids use the EXPANDED version, so every candidate id is new; the
//   generator itself (historical-rank-v2-clean.js) is called unmodified.
// - Development scans (< V2.HOLDOUT.devCutoffMs) carry strict labels.
// - Embargo and holdout scans are generated for COUNTS ONLY: their candidates
//   are never stored and never resolved.
// - Point-in-time check: a sample of development scans is regenerated from an
//   archive truncated at the scan timestamp; any difference = lookahead.
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';
import {join} from 'node:path';
import Clean from '../historical-rank-v2-clean.js';
import Rank from '../historical-rank.js';
import V2 from '../rank-research-v2.js';
import X from './expansion.js';

const ASSET = process.env.EXPANSION_ASSET, PRODUCT = process.env.EXPANSION_PRODUCT || `${ASSET}-USD`;
const DIR = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive', OUT = process.env.EXPANSION_OUT || 'expansion-out';
const B = 300_000, HOUR = 3_600_000, DAY = 86_400_000;
const PIT_SAMPLE = Number(process.env.EXPANSION_PIT_SAMPLE ?? 12);
if (!ASSET) throw new Error('EXPANSION_ASSET is required');

function readCsv(path) {
  if (!existsSync(path)) throw new Error(`ARCHIVE_MISSING: ${path}`);
  return gunzipSync(readFileSync(path)).toString().trim().split('\n').filter(Boolean).map(line => { const [time, open, high, low, close, volume] = line.split(',').map(Number); return {time, open, high, low, close, volume}; });
}
const raw = {m5: readCsv(join(DIR, `${ASSET}.csv.gz`)), h1: readCsv(join(DIR, `${ASSET}-1h.csv.gz`)), d1: readCsv(join(DIR, `${ASSET}-1d.csv.gz`))};
function prepare(until = Infinity) {
  const cut = (rows, interval) => rows.filter(row => row.time + interval <= until);
  const prepared = Clean.prepareAsset(ASSET, cut(raw.m5, B), {now: Math.min(until, X.WINDOW.toMs), native: {h1: cut(raw.h1, HOUR), d1: cut(raw.d1, DAY)}});
  prepared.product = PRODUCT;   // assets outside the frozen six have no entry in Archive.PRODUCTS
  return prepared;
}
const prepared = prepare();
if (prepared.htfSource !== 'COINBASE_NATIVE_1H_1D') throw new Error('POLICY_MISMATCH: expansion must use the native-HTF policy');

const {firstScan, lastScan} = X.scanGrid(), devCutoff = V2.HOLDOUT.devCutoffMs, holdoutStart = V2.HOLDOUT.startMs;
const rows = [], exclusions = {}, holdout = {scans: 0, eligibleScans: 0, candidates: 0, rankable: 0, perScan: {}}, embargo = {scans: 0, candidates: 0}, gates = {};
let devEvaluations = 0, devEligible = 0, firstEligible = null;
const eligibleDevScans = [];
for (let ts = firstScan; ts <= lastScan; ts += DAY) {
  const scanId = X.scanId(ts), check = Clean.historyCheck(prepared, ts), dev = ts < devCutoff, isHoldout = ts >= holdoutStart;
  if (dev) devEvaluations++;
  if (!check.ok) { if (dev) exclusions[check.reason] = (exclusions[check.reason] || 0) + 1; continue; }
  const result = Clean.assetCandidates({scanId, timestamp: ts, prepared, check});
  if (result.excluded) { if (dev) exclusions[result.excluded.reason] = (exclusions[result.excluded.reason] || 0) + 1; continue; }
  const rankable = result.candidates.filter(row => row.valid_current_geometry);
  if (isHoldout) { holdout.eligibleScans++; holdout.candidates += result.candidates.length; holdout.rankable += rankable.length; if (rankable.length) holdout.perScan[ts] = rankable.length; continue; }   // counts only; never stored or resolved
  if (!dev) { embargo.scans++; embargo.candidates += result.candidates.length; continue; }
  devEligible++; firstEligible ??= ts; eligibleDevScans.push(ts);
  if (result.diagnostics?.available) for (const [gate, conditions] of Object.entries(result.diagnostics.gates)) { const g = gates[gate] ||= {evaluations: 0, allPass: 0}; g.evaluations++; if (Object.values(conditions).every(Boolean)) g.allPass++; }
  for (const row of result.candidates) {
    // Labels are resolved from the same venue's post-entry path; the whole
    // 24h window sits before the holdout start (devCutoff + 24h < startMs).
    const label = row.valid_current_geometry ? Clean.resolveStrict(row, prepared) : null;
    if (label && ts + Rank.OUTCOME_BARS * B > holdoutStart) throw new Error('HOLDOUT_BREACH: label window reaches the holdout');
    rows.push({...row, label});
  }
}
for (let ts = firstScan; ts <= lastScan; ts += DAY) if (ts >= holdoutStart) holdout.scans++;

// ---- point-in-time invariance on real data (sampled development scans) ----
const candidateScans = [...new Set(rows.filter(row => row.valid_current_geometry).map(row => row.timestamp))];
const sample = candidateScans.filter((_, i) => i % Math.max(1, Math.floor(candidateScans.length / PIT_SAMPLE)) === 0).slice(0, PIT_SAMPLE), pit = {sampled: 0, candidatesCompared: 0, mismatches: []};
for (const ts of sample) {
  const truncated = prepare(ts), check = Clean.historyCheck(truncated, ts); pit.sampled++;
  const again = check.ok ? Clean.assetCandidates({scanId: X.scanId(ts), timestamp: ts, prepared: truncated, check}).candidates : [];
  const stored = rows.filter(row => row.timestamp === ts);
  if (again.length !== stored.length) { pit.mismatches.push({ts, reason: 'COUNT', stored: stored.length, truncated: again.length}); continue; }
  stored.forEach((row, i) => { pit.candidatesCompared++; if (row.candidate_id !== again[i].candidate_id || row.feature_hash !== again[i].feature_hash || row.quant_score !== again[i].quant_score) pit.mismatches.push({ts, candidate_id: row.candidate_id, reason: 'CONTENT'}); });
}

const daily = raw.d1.filter(row => row.time + DAY <= holdoutStart).map(row => [row.time, row.close, row.volume]);
const rankableRows = rows.filter(row => row.valid_current_geometry);
const summary = {asset: ASSET, product: PRODUCT, datasetVersion: X.EXPANDED_VERSION, generatorPolicy: Clean.NATIVE_HTF_VERSION, labelVersion: Clean.LABEL_VERSION, scanGrid: {first: new Date(firstScan).toISOString(), last: new Date(lastScan).toISOString()},
  archive: {m5: raw.m5.length, h1: raw.h1.length, d1: raw.d1.length, first5m: raw.m5[0] ? new Date(raw.m5[0].time).toISOString() : null, issues: prepared.issues, gaps: prepared.gaps},
  development: {evaluations: devEvaluations, eligibleScans: devEligible, firstEligibleScan: firstEligible ? new Date(firstEligible).toISOString() : null, candidates: rows.length, rankable: rankableRows.length, resolved: rankableRows.filter(row => row.label?.status === 'RESOLVED').length, unresolved: X.countBy(rankableRows.filter(row => row.label?.status !== 'RESOLVED'), row => row.label?.reason || 'NONE'), exclusions, gates},
  eligibleDevScans, embargoCountsOnly: embargo, holdoutCountsOnly: holdout, pointInTime: {...pit, pass: pit.mismatches.length === 0}, dailyCloses: daily};
mkdirSync(OUT, {recursive: true});
writeFileSync(join(OUT, `${ASSET}.rows.jsonl.gz`), gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
writeFileSync(join(OUT, `${ASSET}.summary.json`), JSON.stringify(summary) + '\n');
console.log(JSON.stringify({status: 'EXPANSION_ASSET_COMPLETE', asset: ASSET, development: summary.development, holdoutCountsOnly: {scans: holdout.scans, eligibleScans: holdout.eligibleScans, rankable: holdout.rankable}, pointInTime: {sampled: pit.sampled, compared: pit.candidatesCompared, mismatches: pit.mismatches.length}}));
if (pit.mismatches.length) { console.error(JSON.stringify(pit.mismatches.slice(0, 5))); process.exitCode = 1; }
