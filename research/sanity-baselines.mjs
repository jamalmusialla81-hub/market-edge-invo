#!/usr/bin/env node
// Lightweight sanity baselines only: exact-expectation Random vs Current Quant
// #1 on the development period of one dataset version.  No training, no
// tuning, no model selection, no promotion.  The sealed holdout is excluded
// in SQL and again in parseRows.
import {writeFileSync} from 'node:fs';
import V2 from './rank-research-v2.js';
import Registry from './dataset-registry.js';

const CF = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8ea7796a8fb13ffb612245e8a08a55d6', DB = process.env.MARKET_EDGE_D1_DATABASE_ID || '39a4082e-41a4-45e9-9b76-99cf10eaca01';
const ENGINE = process.env.SANITY_ENGINE || 'HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF', REPORT = process.env.SANITY_REPORT || 'sanity-baselines.json';
Registry.assertTrainable(ENGINE);
async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('READ_ONLY_VIOLATION');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
  return body.result?.[0]?.results || [];
}
const raw = await d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.quant_score,c.candidate_rank,c.regime,c.feature_json,c.targets_json,c.valid_current_geometry,s.scan_timestamp FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id WHERE c.valid_current_geometry=1 AND json_extract(c.targets_json,'$.status')='RESOLVED' AND s.engine_version=? AND s.scan_timestamp<? ORDER BY s.scan_timestamp,c.candidate_id`, [ENGINE, V2.HOLDOUT.devCutoffMs]);
const {rows, excludedHoldoutOrEmbargo, droppedStaleInputs} = V2.parseRows(raw);
if (excludedHoldoutOrEmbargo) throw new Error('HOLDOUT_BREACH');
const choice = rows.filter(row => rows.filter(other => other.scan_id === row.scan_id).length >= 2);
const random = choice.map(() => 0), quant = choice.map(row => row.quant_score);
const at = scores => Object.fromEntries(V2.COSTS.map(cost => [`${(cost * 100).toFixed(2)}%`, V2.summarise(V2.picks(choice, scores, cost))]));
const series = scores => V2.picks(choice, scores).map(item => item.r), q = series(quant), r = series(random), diff = q.map((value, i) => value - r[i]);
const report = {dataset_version: ENGINE, scope: 'development choice scans only; sanity check, not evidence of alpha', rows: rows.length, droppedStaleInputs, choiceScans: new Set(choice.map(row => row.scan_id)).size, choiceCandidates: choice.length,
  RANDOM: {atCosts: at(random), ci95_016: V2.blockBootstrap(r)}, CURRENT_QUANT: {atCosts: at(quant), ci95_016: V2.blockBootstrap(q), rankBuckets016: V2.rankBuckets(choice, quant), weightedPairAccuracy: V2.weightedPairAccuracy(quant, choice.map(row => Number(row.targets.FINAL_R)), choice.map(row => row.scan_id)), ...V2.spearmanWithin(choice, quant)},
  quantMinusRandom016: {mean: diff.reduce((a, b) => a + b, 0) / (diff.length || 1), ci95: V2.blockBootstrap(diff, {seed: 13})}, tuning: 'NONE', modelSelection: 'NONE', promotion: 'NONE'};
writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report));
