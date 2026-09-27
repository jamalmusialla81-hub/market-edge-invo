#!/usr/bin/env node
// Generates HISTORICAL-RANK-V2-CLEAN from the verified Coinbase spot archive.
// HISTORICAL-RANK-V1 is never read or written.  Each scan is frozen (snapshot
// commit) before its outcome is attached, both through the existing research
// ingest endpoint.  Holdout scans (>= 2025-12-01) are generated but this report
// prints only their counts — never outcome statistics.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import Clean from './historical-rank-v2-clean.js';
import Rank from './historical-rank.js';
import V2 from './rank-research-v2.js';
import Registry from './dataset-registry.js';

const API = (process.env.MARKET_EDGE_API || 'https://market-edge-ai.jakob-market-edge.workers.dev').replace(/\/$/, ''), TOKEN = process.env.MARKET_EDGE_RESEARCH_TOKEN || '', CF = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8ea7796a8fb13ffb612245e8a08a55d6', DB = process.env.MARKET_EDGE_D1_DATABASE_ID || '39a4082e-41a4-45e9-9b76-99cf10eaca01';
const DIR = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive', REPORT = process.env.V2_CLEAN_REPORT || 'v2-clean-generation-report.json', DRY = process.argv.includes('--dry-run') || process.env.V2_CLEAN_DRY_RUN === '1';
const HTF = process.env.V2_CLEAN_HTF_SOURCE || 'aggregated';
if (!['aggregated', 'native'].includes(HTF)) throw new Error(`Unknown HTF policy ${HTF}`);
const DATASET = HTF === 'native' ? Clean.NATIVE_HTF_VERSION : Clean.VERSION;
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC'], DAY = 86_400_000, B = 300_000, MAX_SCANS = Number(process.env.V2_CLEAN_MAX_SCANS) || Infinity;
Registry.assertTrainable(DATASET);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('READ_ONLY_VIOLATION');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
  return body.result?.[0]?.results || [];
}
async function ingest(payload) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${API}/v1/research/ingest`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify(payload)}), body = await response.json().catch(() => ({}));
    if (response.ok) { await sleep(600); return body; }
    if (response.status !== 429 && response.status < 500) throw new Error(`Ingest ${payload.operation} failed: ${response.status} ${body?.error?.code || ''} ${body?.error?.message || ''}`);
    await sleep(4000 * (attempt + 1));
  }
  throw new Error(`Ingest ${payload.operation} failed after retries`);
}
function readCsv(path) { if (!existsSync(path)) throw new Error(`ARCHIVE_MISSING: ${path}`); return gunzipSync(readFileSync(path)).toString().trim().split('\n').filter(Boolean).map(line => { const [time, open, high, low, close, volume] = line.split(',').map(Number); return {time, open, high, low, close, volume}; }); }
function loadAsset(asset) {
  const native = HTF === 'native' ? {h1: readCsv(join(DIR, `${asset}-1h.csv.gz`)), d1: readCsv(join(DIR, `${asset}-1d.csv.gz`))} : null;
  return Clean.prepareAsset(asset, readCsv(join(DIR, `${asset}.csv.gz`)), {native});
}
const inc = (object, key, by = 1) => { object[key] = (object[key] || 0) + by; };

async function run() {
  if (!DRY && (!TOKEN || !CF)) throw new Error('MARKET_EDGE_RESEARCH_TOKEN and CLOUDFLARE_API_TOKEN are required');
  // Scans start once the EARLIEST-listed asset has production-depth history.
  // Assets listed later (e.g. XRP-USD relisted 2023-07-13) fail their own
  // history check until they have it; nothing is fabricated for them.
  const assets = ASSETS.map(loadAsset), archiveStart = Math.min(...assets.map(a => a.rows[0].time)), archiveEnd = Math.min(...assets.map(a => a.rows.at(-1).time + B));
  const firstScan = Math.ceil((archiveStart + Clean.HISTORY_MS + DAY) / DAY) * DAY, lastScan = Math.floor((archiveEnd - Rank.OUTCOME_BARS * B - B) / DAY) * DAY;
  const existing = DRY ? new Map() : new Map((await d1(`SELECT s.scan_id AS scan_id,SUM(CASE WHEN c.valid_current_geometry=1 AND c.targets_json LIKE '%PENDING_OUTCOME%' THEN 1 ELSE 0 END) AS pending FROM historical_scan_snapshots s LEFT JOIN historical_scan_candidates c ON c.scan_id=s.scan_id WHERE s.engine_version=? GROUP BY s.scan_id`, [DATASET])).map(row => [row.scan_id, Number(row.pending) || 0]));
  const report = {dataset_version: DATASET, htf_source: HTF, frame_sources: Clean.frameSources(assets[0]), label_version: Clean.LABEL_VERSION, generated_at: new Date().toISOString(), dry_run: DRY, archive: {start: new Date(archiveStart).toISOString(), firstCandleByAsset: Object.fromEntries(assets.map(a => [a.asset, new Date(a.rows[0].time).toISOString()])), end: new Date(archiveEnd).toISOString(), issues: Object.fromEntries(assets.map(a => [a.asset, a.issues])), gaps: Object.fromEntries(assets.map(a => [a.asset, a.gaps]))}, production_bars: Clean.PRODUCTION_BARS, scan_window: {first: new Date(firstScan).toISOString(), last: new Date(lastScan).toISOString()}, holdout: V2.HOLDOUT,
    development: {scans: 0, skippedNoEligibleAsset: 0, candidates: 0, rankable: 0, resolved: 0, unresolved: {}, choiceScans: 0, assets: {}, strategies: {}, directions: {}, strategyDirection: {}, exclusions: {}, exclusionsByAsset: {}, labelSources: {}, exits: {}, perScanCandidates: {}},
    holdout_counts_only: {scans: 0, candidates: 0, rankable: 0, resolvedOrUnresolved: 0},
    diversity: {evaluations: {}, emitted: {}, regimes: {}, trendState: {}, gates: {}},
    ingest: {committedScans: 0, skippedAlreadyComplete: 0, outcomeCommits: 0}};
  let processed = 0;
  for (let timestamp = firstScan; timestamp <= lastScan && processed < MAX_SCANS; timestamp += DAY) {
    const built = Clean.buildScan({timestamp, assets}), holdout = timestamp >= V2.HOLDOUT.startMs, dev = timestamp < V2.HOLDOUT.devCutoffMs, section = report.development;
    for (const item of built.excluded || []) { if (dev) { inc(section.exclusions, item.reason); section.exclusionsByAsset[item.asset] ||= {}; inc(section.exclusionsByAsset[item.asset], item.reason); } }
    if (built.skipped) { if (dev) section.skippedNoEligibleAsset++; continue; }
    const rankable = built.candidates.filter(row => row.valid_current_geometry);
    const outcomes = rankable.map(row => { const target = Clean.resolveStrict(row, assets.find(a => a.asset === row.asset)); return {candidate_id: row.candidate_id, targets: target, outcome_hash: Rank.hash({candidate_id: row.candidate_id, targets: target}), row}; });
    // Diversity diagnostics (all non-holdout scans; no outcomes involved).
    if (!holdout) for (const [asset, diag] of Object.entries(built.diagnostics || {})) {
      if (!diag?.available) continue; inc(report.diversity.evaluations, asset); report.diversity.regimes[asset] ||= {}; inc(report.diversity.regimes[asset], diag.regime);
      report.diversity.trendState[asset] ||= {}; inc(report.diversity.trendState[asset], diag.upTrend ? 'UP' : diag.downTrend ? 'DOWN' : 'NEITHER');
      for (const [gate, conditions] of Object.entries(diag.gates)) { const g = report.diversity.gates[gate] ||= {evaluations: 0, allPass: 0, pass: {}, soleBlocker: {}}; g.evaluations++; const failed = Object.entries(conditions).filter(([, v]) => !v).map(([k]) => k); if (!failed.length) g.allPass++; for (const [k, v] of Object.entries(conditions)) if (v) inc(g.pass, k); if (failed.length === 1) inc(g.soleBlocker, failed[0]); }
    }
    if (!holdout) for (const row of rankable) inc(report.diversity.emitted, `${row.asset}|${row.strategy}|${row.direction}`);
    if (dev) {
      section.scans++; section.candidates += built.candidates.length; section.rankable += rankable.length; inc(section.perScanCandidates, rankable.length); if (rankable.length >= 2) section.choiceScans++;
      for (const row of rankable) { inc(section.assets, row.asset); inc(section.strategies, row.strategy); inc(section.directions, row.direction); inc(section.strategyDirection, `${row.strategy}|${row.direction}`); }
      for (const {targets} of outcomes) { if (targets.status === 'RESOLVED') { section.resolved++; inc(section.exits, targets.exit_reason); inc(section.labelSources, `${targets.outcome_venue}:${targets.outcome_instrument_type}`); } else inc(section.unresolved, targets.reason); }
    } else if (holdout) { const h = report.holdout_counts_only; h.scans++; h.candidates += built.candidates.length; h.rankable += rankable.length; h.resolvedOrUnresolved += outcomes.length; }
    if (built.candidates.length > 96) throw new Error(`Scan ${built.scanId} exceeds the 96-candidate ingest limit`);
    if (!DRY) {
      const pending = existing.get(built.scanId);
      if (pending === 0) { report.ingest.skippedAlreadyComplete++; processed++; continue; }
      if (pending === undefined) { await ingest({operation: 'historical_rank_snapshot_commit', snapshot: built.snapshot, candidates: built.candidates}); report.ingest.committedScans++; }
      if (outcomes.length) { await ingest({operation: 'historical_rank_outcome_commit', scan_id: built.scanId, outcomes: outcomes.map(({candidate_id, targets, outcome_hash}) => ({candidate_id, targets, outcome_hash}))}); report.ingest.outcomeCommits++; }
    }
    processed++;
    if (processed % 25 === 0) console.log(JSON.stringify({progress: 'v2-clean', scan: new Date(timestamp).toISOString().slice(0, 10), processed, committed: report.ingest.committedScans}));
  }
  writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
  console.log(JSON.stringify({status: 'V2_CLEAN_GENERATION_COMPLETE', ...report}));
}
run().catch(error => { console.error(`V2-CLEAN generation failed: ${error.message}`); process.exitCode = 1; });
