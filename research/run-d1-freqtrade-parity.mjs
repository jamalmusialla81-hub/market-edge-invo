// GitHub Actions only: compare Freqtrade's frozen-decision adapter against
// genuine immutable Market Edge records. It cannot evaluate strategy logic.
import {readFile} from 'node:fs/promises';
import Adapter from './freqtrade-adapter.js';

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error('PARITY_CREDENTIALS_MISSING');
const config = JSON.parse(await readFile(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'));
const database = config.d1_databases.find(item => item.binding === 'MARKET_EDGE_DB');
const sql = `WITH ranked AS (
  SELECT signal_id,timestamp,asset,strategy,direction,preferred_entry,stop,tp1,tp2,rr,features_json,targets_json,
         ROW_NUMBER() OVER (PARTITION BY strategy ORDER BY timestamp ASC) AS family_row
  FROM historical_decision_points
  WHERE dataset_version=? AND targets_json LIKE '%RESOLVED%'
)
SELECT * FROM ranked WHERE family_row=1 ORDER BY strategy`;
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database.database_id}/query`, {
  method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  body: JSON.stringify({sql, params: ['EARLY-WINDOW-RESEARCH-V1']}), signal: AbortSignal.timeout(30_000)
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || payload.success !== true) throw new Error(`PARITY_D1_READ_FAILED:${response.status}`);
const rows = (payload.result || []).flatMap(result => result.results || []);
const samples = rows.map(row => {
  const decision = {signal_id: row.signal_id, timestamp: Number(row.timestamp), asset: row.asset, direction: String(row.direction).toLowerCase(), entry: Number(row.preferred_entry), stop: Number(row.stop), tp1: Number(row.tp1), tp2: row.tp2 == null ? null : Number(row.tp2), rr: Number(row.rr)};
  const adapted = Adapter.toResearchSignal(decision);
  const match = Adapter.parity(decision, adapted);
  let target = {}, features = {};
  try { target = JSON.parse(row.targets_json || '{}'); } catch {}
  try { features = JSON.parse(row.features_json || '{}'); } catch {}
  return {strategy: row.strategy, asset: row.asset, timestamp: decision.timestamp, direction: decision.direction, geometry_match: match.pass, mismatch: match.mismatch, target_available: Number.isFinite(Number(target.FINAL_R)), feature_top_level_keys: Object.keys(features).sort()};
});
console.log(JSON.stringify({check: 'FREQTRADE_FROZEN_DECISION_PARITY', sample_count: samples.length, matched: samples.filter(sample => sample.geometry_match).length, material_mismatch: samples.filter(sample => !sample.geometry_match), samples, evaluator_note: 'Adapter parity only. The adapter intentionally consumes frozen Market Edge decisions and does not reimplement the production evaluator.'}));
