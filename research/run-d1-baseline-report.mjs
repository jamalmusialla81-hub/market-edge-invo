// This command is designed for GitHub Actions only. It reads immutable D1
// records using the existing deploy credential and prints aggregates only.
import {readFile} from 'node:fs/promises';
import Analysis from './dataset-analysis.js';

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error('RESEARCH_REPORT_CREDENTIALS_MISSING');
const config = JSON.parse(await readFile(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'));
const database = config.d1_databases.find(item => item.binding === 'MARKET_EDGE_DB');
if (!database?.database_id) throw new Error('RESEARCH_REPORT_DATABASE_CONFIG_MISSING');

const sql = `SELECT signal_id,timestamp,asset,strategy,direction,regime,quality_score,signal_price,preferred_entry,stop,tp1,tp2,rr,features_json,targets_json FROM historical_decision_points WHERE dataset_version=? AND targets_json LIKE '%RESOLVED%' ORDER BY timestamp ASC`;
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database.database_id}/query`, {
  method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  body: JSON.stringify({sql, params: ['EARLY-WINDOW-RESEARCH-V1']}), signal: AbortSignal.timeout(30_000)
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || payload.success !== true) throw new Error(`RESEARCH_REPORT_D1_READ_FAILED:${response.status}:${(payload.errors || []).map(item => item.code).join(',')}`);
const rows = (payload.result || []).flatMap(result => result.results || []);
const output = Analysis.report(rows);
console.log(JSON.stringify({check: 'IMMUTABLE_RESEARCH_BASELINE_REPORT', database: database.database_name, databaseId: database.database_id, ...output}));
