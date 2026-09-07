// Read-only OOS evaluation of the model currently exposed by the Worker.
// It does not train, register, score production scans, or change ML weight.
import {readFile} from 'node:fs/promises';
import ML from '../ml-engine.js';
import Runner from './ml-runner.js';

const api = (process.env.MARKET_EDGE_API || 'https://market-edge-ai.jakob-market-edge.workers.dev').replace(/\/$/, '');
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error('ML_EVALUATION_CREDENTIALS_MISSING');
const config = JSON.parse(await readFile(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'));
const database = config.d1_databases.find(item => item.binding === 'MARKET_EDGE_DB');
const activeResponse = await fetch(`${api}/v1/research/ml/active`, {signal: AbortSignal.timeout(20_000)});
const active = await activeResponse.json().catch(() => null);
if (!activeResponse.ok || !active?.available || !active?.id || !active?.model) throw new Error('ML_EVALUATION_ACTIVE_MODEL_UNAVAILABLE');
async function d1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database.database_id}/query`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params}), signal: AbortSignal.timeout(30_000)});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) throw new Error(`ML_EVALUATION_D1_READ_FAILED:${response.status}`);
  return (payload.result || []).flatMap(result => result.results || []);
}
const [models, rows] = await Promise.all([
  d1('SELECT metadata_json FROM model_registry WHERE id=? LIMIT 1', [active.id]),
  d1(`SELECT signal_id,timestamp,asset,strategy,direction,regime,quality_score,rr,features_json,targets_json FROM historical_decision_points WHERE dataset_version=? AND targets_json LIKE '%RESOLVED%' ORDER BY timestamp ASC`, ['EARLY-WINDOW-RESEARCH-V1'])
]);
let metadata = {}; try { metadata = JSON.parse(models[0]?.metadata_json || '{}'); } catch {}
const trainedThrough = Number(metadata?.trainingWindow?.end);
if (!Number.isFinite(trainedThrough)) throw new Error('ML_EVALUATION_TRAINING_CUTOFF_UNAVAILABLE');
const samples = rows.filter(row => Number(row.timestamp) > trainedThrough).map(Runner.sample);
const compatible = samples.filter(sample => { try { ML.predictProbability(active.model, sample.features); return true; } catch { return false; } });
const scores = compatible.map(sample => ML.predictProbability(active.model, sample.features));
const actual = compatible.map(sample => sample.targets.tp1BeforeSl);
const finalR = compatible.map(sample => sample.targets.finalR);
const selectTopThird = values => {
  const take = Math.max(1, Math.floor(values.length / 3));
  return values.map((score, index) => ({score, index})).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, take).map(item => item.index);
};
const summarizeSelection = indices => ({n: indices.length, mean_final_r: indices.length ? indices.reduce((sum, index) => sum + finalR[index], 0) / indices.length : null, tp1_before_stop_rate: indices.length ? indices.reduce((sum, index) => sum + actual[index], 0) / indices.length : null});
const quantIndices = selectTopThird(compatible.map(sample => sample.features.quality));
const mlIndices = selectTopThird(scores);
console.log(JSON.stringify({
  check: 'CURRENT_PRODUCTION_ML_READ_ONLY_EVALUATION', model_id: active.id, model_status: active.status, trained_through: trainedThrough,
  chronological_oos_n: compatible.length, classification: compatible.length ? Runner.classification(scores, actual) : null,
  selection_proxy: {quant_only_top_third: summarizeSelection(quantIndices), current_ml_top_third: summarizeSelection(mlIndices)},
  ranking_validation: 'INSUFFICIENT_EVIDENCE: immutable decision rows have no frozen per-scan candidate universe or rank buckets.',
  production_changes: false
}));
