const API_URL = import.meta.env?.VITE_MARKET_EDGE_API_URL || 'https://market-edge-ai.jakob-market-edge.workers.dev/api/scan';
const STATUSES = new Set(['TRADE_READY', 'WAIT_FOR_ENTRY', 'ENTRY_EXPIRED', 'NO_VALID_SETUP', 'DATA_UNAVAILABLE']);

export class MarketEdgeApiError extends Error {
  constructor(message, { code = 'DATA_UNAVAILABLE', httpStatus = null, cause = null } = {}) {
    super(message);
    this.name = 'MarketEdgeApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.cause = cause;
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
    weight: nullableNumber(value.ml.weight, `${path}.ml.weight`)
  } : invalid(`${path}.ml must be an object`);
  return {
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
      excluded: nullableNumber(value.universe.excluded, 'universe.excluded'), dataFailures: nullableNumber(value.universe.dataFailures, 'universe.dataFailures')
    },
    dataQuality: { status: nullableText(value.dataQuality.status, 'dataQuality.status'), failures: Array.isArray(value.dataQuality.failures) ? value.dataQuality.failures.filter(item => typeof item === 'string').slice(0, 6) : [] },
    bestOpportunity: parseTrade(value.bestOpportunity, 'bestOpportunity'),
    bestTradeNow: parseTrade(value.bestTradeNow, 'bestTradeNow'),
    raw: value
  };
  if (result.status === 'TRADE_READY' && !hasCompleteTrade(result.bestTradeNow)) invalid('TRADE_READY requires a complete bestTradeNow');
  if (result.status !== 'TRADE_READY' && result.bestTradeNow) invalid('Only TRADE_READY may include bestTradeNow');
  return result;
}

export function hasCompleteTrade(trade) {
  return Boolean(trade && ['long', 'short'].includes(trade.direction) && [trade.entry, trade.stop, trade.tp1, trade.tp2, trade.rr1, trade.position?.notional, trade.position?.margin, trade.position?.leverage, trade.position?.riskAmount].every(isFiniteNumber));
}

export async function scanMarkets({ settings = {}, signal, timeoutMs = 45000, fetchImpl = fetch, endpoint = API_URL, requestId: requestIdInput } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestId = requestIdInput || globalThis.crypto?.randomUUID?.() || `scan-request-${Date.now()}`;
  const cancellation = () => controller.abort();
  signal?.addEventListener('abort', cancellation, { once: true });
  try {
    const response = await fetchImpl(endpoint, {
      // The request id stays in the JSON payload. Keeping headers simple lets the
      // existing explicit CORS policy remain narrow without a new custom header.
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ requestId, settings })
    });
    const body = await response.json().catch(() => { throw new MarketEdgeApiError('Worker returned invalid JSON', { code: 'RESPONSE_INVALID', httpStatus: response.status }); });
    if (!response.ok) throw new MarketEdgeApiError(body?.error?.message || `Worker request failed (${response.status})`, { code: body?.error?.code || 'HTTP_ERROR', httpStatus: response.status });
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

export { API_URL, STATUSES };
