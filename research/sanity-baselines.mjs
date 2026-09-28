#!/usr/bin/env node
// Diagnostic sanity baselines only: exact-expectation Random vs Current Quant
// #1 on the DEVELOPMENT period of one dataset version.  No training, tuning,
// feature selection, model selection or promotion.  The sealed holdout is
// excluded in SQL and again in parseRows.
import {writeFileSync} from 'node:fs';
import V2 from './rank-research-v2.js';
import Registry from './dataset-registry.js';

const CF = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8ea7796a8fb13ffb612245e8a08a55d6', DB = process.env.MARKET_EDGE_D1_DATABASE_ID || '39a4082e-41a4-45e9-9b76-99cf10eaca01';
const ENGINE = process.env.SANITY_ENGINE || 'HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF', REPORT = process.env.SANITY_REPORT || 'sanity-baselines.json';
const COSTS = [0, .0008, .0016, .0025], FOLDS = 5;
Registry.assertTrainable(ENGINE);
async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('READ_ONLY_VIOLATION');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
  return body.result?.[0]?.results || [];
}
const mean = v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const raw = await d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.quant_score,c.candidate_rank,c.regime,c.feature_json,c.targets_json,c.valid_current_geometry,s.scan_timestamp FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id WHERE c.valid_current_geometry=1 AND json_extract(c.targets_json,'$.status')='RESOLVED' AND s.engine_version=? AND s.scan_timestamp<? ORDER BY s.scan_timestamp,c.candidate_id`, [ENGINE, V2.HOLDOUT.devCutoffMs]);
const {rows, excludedHoldoutOrEmbargo, droppedStaleInputs} = V2.parseRows(raw);
if (excludedHoldoutOrEmbargo) throw new Error('HOLDOUT_BREACH');
const sizes = new Map(); for (const row of rows) sizes.set(row.scan_id, (sizes.get(row.scan_id) || 0) + 1);
const choice = rows.filter(row => sizes.get(row.scan_id) >= 2);
const score = {RANDOM: () => 0, CURRENT_QUANT: row => row.quant_score};
const pickSet = (name, subset, cost = .0016) => V2.picks(subset, subset.map(score[name]), cost);
const series = (name, subset) => pickSet(name, subset).map(item => item.r);
function breakdown(name, key) { const out = {}; for (const pick of pickSet(name, choice)) { const k = key(pick); (out[k] ||= []).push(pick.r); } return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, {picks: v.length, meanR: mean(v)}])); }
// Chronological blocks of choice scans (no training involved; stability only).
const scans = [...new Set(choice.map(row => row.scan_id))].sort((a, b) => choice.find(r => r.scan_id === a).timestamp - choice.find(r => r.scan_id === b).timestamp), size = Math.ceil(scans.length / FOLDS);
const folds = Array.from({length: FOLDS}, (_, k) => new Set(scans.slice(k * size, (k + 1) * size))).filter(set => set.size).map((set, k) => { const subset = choice.filter(row => set.has(row.scan_id)), first = subset[0].timestamp, last = subset.at(-1).timestamp; return {fold: k + 1, from: new Date(first).toISOString().slice(0, 10), to: new Date(last).toISOString().slice(0, 10), scans: set.size, RANDOM: mean(series('RANDOM', subset)), CURRENT_QUANT: mean(series('CURRENT_QUANT', subset))}; });
function model(name) {
  return {atCosts: Object.fromEntries(COSTS.map(cost => [`${(cost * 100).toFixed(2)}%`, V2.summarise(pickSet(name, choice, cost))])), ci95_016: V2.blockBootstrap(series(name, choice)),
    byAsset: breakdown(name, pick => pick.row.asset), byDirection: breakdown(name, pick => pick.row.direction), byStrategy: breakdown(name, pick => pick.row.strategy)};
}
const q = series('CURRENT_QUANT', choice), r = series('RANDOM', choice), diff = q.map((v, i) => v - r[i]);
const all = {candidates: choice.length, byAsset: {}, byDirection: {}, byStrategy: {}};
for (const row of choice) for (const [k, v] of [['byAsset', row.asset], ['byDirection', row.direction], ['byStrategy', row.strategy]]) { (all[k][v] ||= []).push(V2.costR(row)); }
for (const k of ['byAsset', 'byDirection', 'byStrategy']) all[k] = Object.fromEntries(Object.entries(all[k]).map(([key, v]) => [key, {candidates: v.length, meanR: mean(v)}]));
const report = {dataset_version: ENGINE, scope: 'development choice scans only; diagnostic, not evidence of alpha', rows: rows.length, droppedStaleInputs, choiceScans: scans.length, choiceCandidates: choice.length,
  RANDOM: model('RANDOM'), CURRENT_QUANT: {...model('CURRENT_QUANT'), rankBuckets016: V2.rankBuckets(choice, choice.map(score.CURRENT_QUANT)), weightedPairAccuracy: V2.weightedPairAccuracy(choice.map(score.CURRENT_QUANT), choice.map(row => Number(row.targets.FINAL_R)), choice.map(row => row.scan_id)), ...V2.spearmanWithin(choice, choice.map(score.CURRENT_QUANT))},
  quantMinusRandom016: {mean: mean(diff), ci95: V2.blockBootstrap(diff, {seed: 13})}, temporalFolds016: folds, allCandidates016: all,
  tuning: 'NONE', modelSelection: 'NONE', featureSelection: 'NONE', promotion: 'NONE'};
writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report));
