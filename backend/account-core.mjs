const SYDNEY = 'Australia/Sydney';
const encoder = new TextEncoder();

export function accountError(message, code = 'ACCOUNT_ERROR', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function clean(value, max = 180) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function validUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }

export function sydneyUsageDay(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SYDNEY, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function supabaseUrl(env) { return clean(env.SUPABASE_URL, 300).replace(/\/$/, ''); }
function serviceKey(env) { return clean(env.SUPABASE_SERVICE_ROLE_KEY, 5000); }
function configured(env) {
  if (!supabaseUrl(env) || !serviceKey(env)) throw accountError('Account services are not configured.', 'ACCOUNT_UNAVAILABLE', 503);
}
function requestHeaders(env, extra = {}) { return { apikey: serviceKey(env), authorization: `Bearer ${serviceKey(env)}`, 'content-type': 'application/json', ...extra }; }

async function supabase(env, fetchImpl, path, init = {}) {
  configured(env);
  const response = await fetchImpl(`${supabaseUrl(env)}${path}`, { ...init, headers: requestHeaders(env, init.headers) });
  const text = await response.text(); let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw accountError(body?.message || body?.hint || `Account service returned ${response.status}.`, 'ACCOUNT_STORAGE_FAILED', 503);
  return body;
}

function cookieMap(request) {
  return Object.fromEntries(String(request.headers.get('cookie') || '').split(';').map(value => value.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
}
async function signGuest(id, env) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(serviceKey(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(id));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function guestCookie(id, env) { return `${id}.${await signGuest(id, env)}`; }
async function verifyGuest(value, env) {
  const [id, signature] = String(value || '').split('.');
  if (!validUuid(id) || !signature) return null;
  const expected = await guestCookie(id, env);
  const a = encoder.encode(expected), b = encoder.encode(`${id}.${signature}`); let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i % Math.max(1, a.length)] || 0) ^ (b[i % Math.max(1, b.length)] || 0);
  return mismatch === 0 ? id : null;
}

async function verifiedSupabaseUser(request, env, fetchImpl) {
  const token = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const response = await fetchImpl(`${supabaseUrl(env)}/auth/v1/user`, { headers: { apikey: serviceKey(env), authorization: `Bearer ${token}` } });
  if (!response.ok) throw accountError('Your sign-in session is invalid or expired.', 'AUTH_INVALID', 401);
  const user = await response.json().catch(() => null);
  if (!user || !validUuid(user.id) || !clean(user.email, 320)) throw accountError('Your sign-in session could not be verified.', 'AUTH_INVALID', 401);
  return { id: user.id, email: clean(user.email, 320).toLowerCase(), anonymous: user.is_anonymous === true };
}

function isAdminEmail(email, env) { return clean(env.MARKET_EDGE_ADMIN_EMAILS, 1600).split(',').map(item => item.trim().toLowerCase()).filter(Boolean).includes(String(email || '').toLowerCase()); }

export async function resolvePrincipal(request, env, fetchImpl) {
  configured(env);
  const user = await verifiedSupabaseUser(request, env, fetchImpl);
  if (user && !user.anonymous) {
    const rows = await supabase(env, fetchImpl, '/rest/v1/rpc/market_edge_bootstrap_profile', { method: 'POST', body: JSON.stringify({ p_user_id: user.id, p_email: user.email, p_is_admin: isAdminEmail(user.email, env) }) });
    const profile = Array.isArray(rows) ? rows[0] : rows;
    if (!profile?.id) throw accountError('Account profile could not be initialized.', 'ACCOUNT_STORAGE_FAILED', 503);
    return { type: 'USER', id: user.id, email: user.email, profile: { role: profile.role, plan: profile.plan, displayName: profile.display_name || null }, setCookie: null };
  }
  const guestId = await verifyGuest(cookieMap(request).market_edge_guest, env);
  const id = guestId || crypto.randomUUID();
  const token = guestId ? null : await guestCookie(id, env);
  return { type: 'GUEST', id, email: null, profile: { role: 'USER', plan: 'FREE', displayName: null }, setCookie: token ? `market_edge_guest=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=None` : null };
}

export async function reserveScan(principal, requestId, env, fetchImpl, now = Date.now()) {
  const rows = await supabase(env, fetchImpl, '/rest/v1/rpc/market_edge_reserve_scan', { method: 'POST', body: JSON.stringify({ p_principal_type: principal.type, p_principal_id: principal.id, p_request_id: clean(requestId, 160), p_usage_day: sydneyUsageDay(now) }) });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw accountError('Scan allowance could not be checked.', 'ENTITLEMENT_UNAVAILABLE', 503);
  return row;
}

export async function finalizeScan(reservationId, scanId, env, fetchImpl) {
  if (!reservationId) return;
  await supabase(env, fetchImpl, '/rest/v1/rpc/market_edge_finalize_scan', { method: 'POST', body: JSON.stringify({ p_reservation_id: reservationId, p_scan_id: clean(scanId, 180) }) });
}
export async function releaseScan(reservationId, env, fetchImpl) {
  if (!reservationId) return;
  await supabase(env, fetchImpl, '/rest/v1/rpc/market_edge_release_scan', { method: 'POST', body: JSON.stringify({ p_reservation_id: reservationId }) }).catch(() => {});
}
export function entitlement(row) {
  const unlimited = row?.unlimited === true;
  return { plan: clean(row?.plan, 20) || 'FREE', role: clean(row?.role, 20) || 'USER', dailyLimit: unlimited ? null : Number(row?.daily_limit), usedToday: Number(row?.used_today) || 0, remainingToday: unlimited ? null : Math.max(0, Number(row?.remaining_today) || 0), unlimited };
}
export async function accountState(principal, env, fetchImpl, now = Date.now()) {
  const day = sydneyUsageDay(now);
  const rows = await supabase(env, fetchImpl, `/rest/v1/scan_usage?principal_id=eq.${principal.id}&usage_day_sydney=eq.${day}&status=eq.FINALIZED&select=id`, { method: 'GET' });
  const usedToday = Array.isArray(rows) ? rows.length : 0;
  const unlimited = principal.type === 'USER' && principal.profile?.role === 'ADMIN';
  const dailyLimit = unlimited ? null : principal.type === 'GUEST' ? 3 : 5;
  return { plan: principal.profile?.plan || 'FREE', role: principal.profile?.role || 'USER', dailyLimit, usedToday, remainingToday: unlimited ? null : Math.max(0, dailyLimit - usedToday), unlimited, principalType: principal.type };
}
export function successfulScan(scan) {
  const coverage = scan?.dataQuality?.coverage;
  return Boolean(scan && scan.status !== 'DATA_UNAVAILABLE' && Number(coverage?.evaluated ?? scan?.universe?.evaluated) > 0);
}
function hasGeometry(item) { return Boolean(item && ['long', 'short'].includes(item.direction) && [item.entry, item.stop, item.tp1, item.tp2, item.rr1].every(Number.isFinite)); }
export async function storeRecommendation(principal, scan, env, fetchImpl, now = Date.now()) {
  const trade = scan?.bestTradeNow;
  if (!hasGeometry(trade)) return null;
  const body = { principal_id: principal.id, scan_id: clean(scan.scanId, 180), snapshot: { scanId: scan.scanId, scannedAt: scan.scannedAt, trade, dataQuality: scan.dataQuality, universe: scan.universe }, expires_at: new Date(now + 15 * 60_000).toISOString() };
  const rows = await supabase(env, fetchImpl, `/rest/v1/scan_recommendations?on_conflict=principal_id,scan_id`, { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(body) });
  return Array.isArray(rows) ? rows[0]?.id || null : null;
}
export async function listTrades(principal, env, fetchImpl) {
  if (principal.type !== 'USER') throw accountError('Create an account to use cloud-synced trades.', 'AUTH_REQUIRED', 401);
  const rows = await supabase(env, fetchImpl, `/rest/v1/user_trades?user_id=eq.${encodeURIComponent(principal.id)}&select=*&order=created_at.desc`, { method: 'GET' });
  return Array.isArray(rows) ? rows : [];
}
export async function acceptTrade(principal, recommendationId, env, fetchImpl) {
  if (principal.type !== 'USER') throw accountError('Create an account to save trades across devices.', 'AUTH_REQUIRED', 401);
  if (!validUuid(recommendationId)) throw accountError('That recommendation is invalid.', 'RECOMMENDATION_INVALID', 400);
  const recommendations = await supabase(env, fetchImpl, `/rest/v1/scan_recommendations?id=eq.${recommendationId}&principal_id=eq.${principal.id}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*`, { method: 'GET' });
  const recommendation = Array.isArray(recommendations) ? recommendations[0] : null;
  if (!recommendation?.snapshot?.trade) throw accountError('This setup is no longer current. Rescan before taking it.', 'RECOMMENDATION_EXPIRED', 409);
  const existing = await supabase(env, fetchImpl, `/rest/v1/user_trades?user_id=eq.${principal.id}&recommendation_id=eq.${recommendationId}&select=*`, { method: 'GET' });
  if (Array.isArray(existing) && existing[0]) return { trade: existing[0], duplicate: true };
  const row = { user_id: principal.id, source: 'MARKET_EDGE', scan_id: recommendation.scan_id, recommendation_id: recommendation.id, snapshot: recommendation.snapshot, status: 'OPEN' };
  const inserted = await supabase(env, fetchImpl, '/rest/v1/user_trades', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) });
  return { trade: Array.isArray(inserted) ? inserted[0] : inserted, duplicate: false };
}
export async function closeTrade(principal, id, exitPrice, env, fetchImpl, now = Date.now()) {
  if (principal.type !== 'USER' || !validUuid(id)) throw accountError('That trade is unavailable.', 'TRADE_NOT_FOUND', 404);
  const rows = await supabase(env, fetchImpl, `/rest/v1/user_trades?id=eq.${id}&user_id=eq.${principal.id}&select=*`, { method: 'GET' });
  const trade = Array.isArray(rows) ? rows[0] : null;
  if (!trade || trade.status !== 'OPEN') throw accountError('That open trade is unavailable.', 'TRADE_NOT_FOUND', 404);
  const snapshot = trade.snapshot?.trade; const entry = Number(snapshot?.entry), stop = Number(snapshot?.stop), exit = Number(exitPrice);
  if (!snapshot || !Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(exit) || entry === stop) throw accountError('A valid exit price is required.', 'EXIT_PRICE_INVALID', 400);
  const sign = snapshot.direction === 'short' ? -1 : 1, realizedR = ((exit - entry) * sign) / Math.abs(entry - stop);
  const updated = await supabase(env, fetchImpl, `/rest/v1/user_trades?id=eq.${id}&user_id=eq.${principal.id}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: 'CLOSED', exit_price: exit, closed_at: new Date(now).toISOString(), realized_r: realizedR, updated_at: new Date(now).toISOString() }) });
  return Array.isArray(updated) ? updated[0] : updated;
}

export { validUuid };
