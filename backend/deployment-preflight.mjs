// Read-only deployment diagnostics. Never print authentication headers or API
// response bodies that could contain credentials.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const database = '39a4082e-41a4-45e9-9b76-99cf10eaca01';
if (!account || !token) throw new Error('DEPLOY_CREDENTIALS_MISSING');
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
  method: 'POST',
  headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  body: JSON.stringify({sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('d1_migrations','research_experiments','research_feature_observations') ORDER BY name"}),
  signal: AbortSignal.timeout(20000)
});
const payload = await response.json().catch(() => ({}));
const codes = (payload.errors || []).map(error => error.code);
console.log(JSON.stringify({check: 'D1_SCHEMA_ACCESS', httpStatus: response.status, success: payload.success === true, errorCodes: codes}));
if (!response.ok || payload.success !== true) throw new Error(`D1_PREFLIGHT_FAILED HTTP ${response.status}; codes=${codes.join(',')}`);
const names = (payload.result || []).flatMap(result => result.results || []).map(row => row.name);
console.log(JSON.stringify({tables: names}));
if (process.argv.includes('--verify-schema') && !['research_experiments', 'research_feature_observations'].every(name => names.includes(name))) throw new Error('D1_SCHEMA_INCOMPLETE');
