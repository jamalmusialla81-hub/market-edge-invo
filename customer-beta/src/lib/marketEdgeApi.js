const API_URL = import.meta.env?.VITE_MARKET_EDGE_API_URL || 'https://market-edge-ai.jakob-market-edge.workers.dev/api/scan';
const CHART_URL = API_URL.replace(/\/api\/scan$/, '/api/chart');
const STATUSES = new Set(['TRADE_READY', 'WAIT_FOR_ENTRY', 'ENTRY_EXPIRED', 'NO_VALID_SETUP', 'DATA_UNAVAILABLE']);

export class MarketEdgeApiError extends Error {
  constructor(message, { code = 'DATA_UNAVAILABLE', httpStatus = null, cause = null, entitlement = null } = {}) {
    super(message);
    this.name = 'MarketEdgeApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.cause = cause;
    this.entitlement = entitlement;
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value, path) => value == null ? null : isFiniteNumber(value) ? value : invalid(`${path} must be a finite number`);
const nullableText = (value, path) => value == null ? null : typeof value === 'string' ? value : invalid(`${path} must be text`);
const invalid = message => { throw new MarketEdgeApiError(`Worker response rejected: ${message}`, { code: 'RESPONSE_INVALID' }); };

function parsePosition(value) {
  if (value == null) return null;
  if (!isRecord(value)) invalid('position must be an object');
  return {
    notional: nullableNumber(value.notional, 'position.notional'),
    margin: nullableNumber(value.margin, 'position.margin'),
    leverage: nullableNumber(value.leverage, 'position.leverage'),
    riskAmount: nullableNumber(value.risk_amount, 'position.risk_amount'),
    estimatedCosts: nullableNumber(value.estimated_costs, 'position.estimated_costs'),
    allocation: nullableNumber(value.allocation, 'position.allocation')
  };
}

function parseTrade(value, path) {
  if (value == null) return null;
  if (!isRecord(value)) invalid(`${path} must be an object`);
  const entryZone = value.entry_zone;
  if (entryZone != null && (!isRecord(entryZone) || !isFiniteNumber(entryZone.low) || !isFiniteNumber(entryZone.high))) invalid(`${path}.entry_zone must contain low/high numbers`);
  const direction = nullableText(value.direction, `${path}.direction`);
  if (direction && !['long', 'short'].includes(direction)) invalid(`${path}.direction is unsupported`);
  const entryStatus = nullableText(value.entry_status, `${path}.entry_status`);
  if (entryStatus && !STATUSES.has(entryStatus)) invalid(`${path}.entry_status is unsupported`);
  const ml = value.ml == null ? null : isRecord(value.ml) ? {
    modelId: nullableText(value.ml.model_id, `${path}.ml.model_id`),
    status: nullableText(value.ml.status, `${path}.ml.status`),
    weight: nullableNumber(value.ml.weight, `${path}.ml.weight`),
    reason: nullableText(value.ml.reason, `${path}.ml.reason`)
  } : invalid(`${path}.ml must be an object`);
  return {
    rank: nullableNumber(value.rank, `${path}.rank`),
    asset: nullableText(value.asset, `${path}.asset`), instrument: nullableText(value.instrument, `${path}.instrument`), direction,
    strategy: nullableText(value.strategy, `${path}.strategy`), currentPrice: nullableNumber(value.current_price, `${path}.current_price`),
    entry: nullableNumber(value.entry, `${path}.entry`), entryZone: entryZone ? { low: entryZone.low, high: entryZone.high } : null,
    stop: nullableNumber(value.stop, `${path}.stop`), tp1: nullableNumber(value.tp1, `${path}.tp1`), tp2: nullableNumber(value.tp2, `${path}.tp2`),
    rr1: nullableNumber(value.rr1, `${path}.rr1`), rr2: nullableNumber(value.rr2, `${path}.rr2`),
    setupQuality: nullableNumber(value.setup_quality, `${path}.setup_quality`), entryStatus,
    strictVerdict: nullableText(value.strict_verdict, `${path}.strict_verdict`), quantScore: nullableNumber(value.quant_score, `${path}.quant_score`),
    mlScore: nullableNumber(value.ml_score, `${path}.ml_score`), combinedScore: nullableNumber(value.combined_score, `${path}.combined_score`),
    ml, position: parsePosition(value.position), regime: nullableText(value.regime, `${path}.regime`),
    reasoning: nullableText(value.reasoning, `${path}.reasoning`), caution: nullableText(value.caution, `${path}.caution`),
    sourceCount: nullableNumber(value.source_count, `${path}.source_count`), dataQuality: nullableText(value.data_quality, `${path}.data_quality`),
    scanSnapshotId: nullableText(value.scan_snapshot_id, `${path}.scan_snapshot_id`), raw: value
  };
}
function parseEntitlement(value) {
  if (value == null) return null;
  if (!isRecord(value)) invalid('account.entitlement must be an object');
  return { plan: nullableText(value.plan, 'account.entitlement.plan') || 'FREE', role: nullableText(value.role, 'account.entitlement.role') || 'USER', dailyLimit: nullableNumber(value.dailyLimit, 'account.entitlement.dailyLimit'), usedToday: nullableNumber(value.usedToday, 'account.entitlement.usedToday'), remainingToday: nullableNumber(value.remainingToday, 'account.entitlement.remainingToday'), unlimited: value.unlimited === true };
}

export function parseScanResponse(value) {
  if (!isRecord(value)) invalid('response is not an object');
  if (typeof value.scanId !== 'string' || !value.scanId) invalid('scanId is required');
  if (!isFiniteNumber(value.scannedAt)) invalid('scannedAt is required');
  if (!STATUSES.has(value.status)) invalid('status is unsupported');
  if (!isRecord(value.universe) || !isRecord(value.dataQuality)) invalid('universe and dataQuality are required');
  const result = {
    scanId: value.scanId,
    scannedAt: value.scannedAt,
    status: value.status,
    universe: {
      found: nullableNumber(value.universe.found, 'universe.found'), scanned: nullableNumber(value.universe.scanned, 'universe.scanned'),
      evaluated: nullableNumber(value.universe.evaluated, 'universe.evaluated'), excluded: nullableNumber(value.universe.excluded, 'universe.excluded'), dataFailures: nullableNumber(value.universe.dataFailures, 'universe.dataFailures')
    },
    dataQuality: { status: nullableText(value.dataQuality.status, 'dataQuality.status'), failures: Array.isArray(value.dataQuality.failures) ? value.dataQuality.failures.filter(item => typeof item === 'string') : [], coverage: value.dataQuality.coverage == null ? null : isRecord(value.dataQuality.coverage) ? { requested: nullableNumber(value.dataQuality.coverage.requested, 'dataQuality.coverage.requested'), evaluated: nullableNumber(value.dataQuality.coverage.evaluated, 'dataQuality.coverage.evaluated'), skipped: nullableNumber(value.dataQuality.coverage.skipped, 'dataQuality.coverage.skipped'), multiSourceEvaluated: nullableNumber(value.dataQuality.coverage.multiSourceEvaluated, 'dataQuality.coverage.multiSourceEvaluated'), singleSourceEvaluated: nullableNumber(value.dataQuality.coverage.singleSourceEvaluated, 'dataQuality.coverage.singleSourceEvaluated') } : invalid('dataQuality.coverage must be an object') },
    scanSummary: value.scanSummary == null ? null : isRecord(value.scanSummary) ? { rankedOpportunities: nullableNumber(value.scanSummary.rankedOpportunities, 'scanSummary.rankedOpportunities'), actionableNow: nullableNumber(value.scanSummary.actionableNow, 'scanSummary.actionableNow') } : invalid('scanSummary must be an object'),
    bestOpportunity: parseTrade(value.bestOpportunity, 'bestOpportunity'),
    bestTradeNow: parseTrade(value.bestTradeNow, 'bestTradeNow'),
    rankedOpportunities: value.rankedOpportunities == null ? [] : Array.isArray(value.rankedOpportunities) ? value.rankedOpportunities.map((trade, index) => parseTrade(trade, `rankedOpportunities[${index}]`)).filter(Boolean) : invalid('rankedOpportunities must be an array'),
    account: value.account == null ? null : isRecord(value.account) ? { entitlement: parseEntitlement(value.account.entitlement), principalType: nullableText(value.account.principalType, 'account.principalType'), recommendationId: nullableText(value.account.recommendationId, 'account.recommendationId') } : invalid('account must be an object'),
    raw: value
  };
  if (result.status === 'TRADE_READY' && !hasCompleteTrade(result.bestTradeNow)) invalid('TRADE_READY requires a complete bestTradeNow');
  if (result.status !== 'TRADE_READY' && result.bestTradeNow) invalid('Only TRADE_READY may include bestTradeNow');
  return result;
}

export async function fetchMarketChart({ asset, timeframe = '15m', signal, fetchImpl = fetch, endpoint = CHART_URL } = {}) {
  const url = new URL(endpoint);
  url.searchParams.set('asset', String(asset || ''));
  url.searchParams.set('timeframe', timeframe);
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal });
    const body = await response.json().catch(() => { throw new MarketEdgeApiError('Worker returned invalid chart data', { code: 'RESPONSE_INVALID', httpStatus: response.status }); });
    if (!response.ok) throw new MarketEdgeApiError(body?.error?.message || `Chart request failed (${response.status})`, { code: body?.error?.code || 'HTTP_ERROR', httpStatus: response.status });
    if (!isRecord(body) || body.asset !== String(asset || '').toUpperCase() || body.timeframe !== timeframe || !Array.isArray(body.candles)) invalid('chart response has invalid identity fields');
    const candles = body.candles.map((candle, index) => {
      if (!isRecord(candle) || ![candle.time, candle.open, candle.high, candle.low, candle.close].every(isFiniteNumber)) invalid(`candles[${index}] is invalid`);
      return { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: nullableNumber(candle.volume, `candles[${index}].volume`) };
    });
    if (!candles.length) invalid('chart response has no candles');
    return { asset: body.asset, timeframe: body.timeframe, source: nullableText(body.source, 'chart.source'), capturedAt: nullableNumber(body.capturedAt, 'chart.capturedAt'), candles, raw: body };
  } catch (error) {
    if (error instanceof MarketEdgeApiError) throw error;
    if (error?.name === 'AbortError') throw new MarketEdgeApiError('Chart request was cancelled', { code: 'TIMEOUT' });
    throw new MarketEdgeApiError('Chart data is unavailable', { code: 'NETWORK_ERROR', cause: error });
  }
}

export function hasCompleteTrade(trade) {
  return Boolean(trade && ['long', 'short'].includes(trade.direction) && [trade.entry, trade.stop, trade.tp1, trade.tp2, trade.rr1, trade.position?.notional, trade.position?.margin, trade.position?.leverage, trade.position?.riskAmount].every(isFiniteNumber));
}

function authHeaders(accessToken) { return accessToken ? { authorization: `Bearer ${accessToken}` } : {}; }
export async function scanMarkets({ settings = {}, accessToken = null, signal, timeoutMs = 60000, fetchImpl = fetch, endpoint = API_URL, requestId: requestIdInput } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestId = requestIdInput || globalThis.crypto?.randomUUID?.() || `scan-request-${Date.now()}`;
  const cancellation = () => controller.abort();
  signal?.addEventListener('abort', cancellation, { once: true });
  try {
    const response = await fetchImpl(endpoint, {
      // The request id stays in the JSON payload. Keeping headers simple lets the
      // existing explicit CORS policy remain narrow without a new custom header.
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...authHeaders(accessToken) }, signal: controller.signal,
      body: JSON.stringify({ requestId, settings })
    });
    const body = await response.json().catch(() => { throw new MarketEdgeApiError('Worker returned invalid JSON', { code: 'RESPONSE_INVALID', httpStatus: response.status }); });
    if (!response.ok) throw new MarketEdgeApiError(body?.error?.message || `Worker request failed (${response.status})`, { code: body?.error?.code || 'HTTP_ERROR', httpStatus: response.status, entitlement: body?.error?.entitlement || null });
    return parseScanResponse(body);
  } catch (error) {
    if (error instanceof MarketEdgeApiError) throw error;
    if (error?.name === 'AbortError') throw new MarketEdgeApiError('The scan timed out. No recommendation was generated.', { code: 'TIMEOUT' });
    throw new MarketEdgeApiError('The Worker could not be reached. No recommendation was generated.', { code: 'NETWORK_ERROR', cause: error });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancellation);
  }
}

const API_BASE = API_URL.replace(/\/api\/scan$/, '');
async function accountRequest(path, { method = 'GET', body, accessToken = null, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${API_BASE}${path}`, { method, credentials: 'include', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...authHeaders(accessToken) }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json().catch(() => { throw new MarketEdgeApiError('Worker returned invalid JSON', { code: 'RESPONSE_INVALID', httpStatus: response.status }); });
    if (!response.ok) throw new MarketEdgeApiError(result?.error?.message || 'Account request failed.', { code: result?.error?.code || 'HTTP_ERROR', httpStatus: response.status });
    return result;
  } catch (error) {
    if (error instanceof MarketEdgeApiError) throw error;
    throw new MarketEdgeApiError('Account service is unavailable.', { code: 'NETWORK_ERROR', cause: error });
  }
}
export const getAccount = options => accountRequest('/v1/account', options);
export const getCloudTrades = options => accountRequest('/v1/trades', options);
export const takeCloudTrade = (recommendationId, options = {}) => accountRequest('/v1/trades/take', { ...options, method: 'POST', body: { recommendationId } });
export const closeCloudTrade = (id, exitPrice, options = {}) => accountRequest(`/v1/trades/${encodeURIComponent(id)}/close`, { ...options, method: 'POST', body: { exitPrice } });

export { API_URL, CHART_URL, STATUSES };
