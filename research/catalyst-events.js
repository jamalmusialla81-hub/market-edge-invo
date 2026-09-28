'use strict';

// Research interface for future equity catalyst / news context.  It is
// deliberately separate from crypto rank research: nothing here is imported by
// the scanner, Quant, ML weighting, Best Trade Now, or execution.
//
// The key scientific property is point-in-time correctness.  Every event
// carries two clocks:
//   event_time   - when the underlying thing happened / is scheduled
//   available_at - when Market Edge could first have known it (publication,
//                  ingestion, or human review), which is what a model may use
// A feature built for a decision at time T may only read events with
// available_at <= T.  Revisions are new immutable records that supersede an
// earlier id; the original is never edited.

const VERSION = 'catalyst-events-v1';
const TYPES = Object.freeze(['NewsEvent', 'CatalystEvent', 'EarningsEvent', 'AnalystEvent', 'MacroEvent']);
const DIRECTIONALITY = Object.freeze(['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED', 'UNKNOWN']);
const EXTRACTION = Object.freeze(['MACHINE_EXTRACTED', 'HUMAN_REVIEWED']);
const CATEGORIES = Object.freeze({
  NewsEvent: ['GENERAL', 'MERGER_ACQUISITION', 'LEGAL_REGULATORY', 'MANAGEMENT_CHANGE', 'PRODUCT', 'GUIDANCE', 'CAPITAL_MARKETS', 'OTHER'],
  CatalystEvent: ['FDA_DECISION', 'PRODUCT_LAUNCH', 'INVESTOR_DAY', 'INDEX_INCLUSION', 'LOCKUP_EXPIRY', 'SHARE_BUYBACK', 'DIVIDEND', 'SPLIT', 'OTHER'],
  EarningsEvent: ['SCHEDULED', 'REPORTED', 'PRE_ANNOUNCEMENT', 'GUIDANCE_UPDATE'],
  AnalystEvent: ['UPGRADE', 'DOWNGRADE', 'INITIATION', 'PRICE_TARGET_CHANGE', 'REITERATION'],
  MacroEvent: ['CPI', 'PPI', 'PAYROLLS', 'FOMC_DECISION', 'FOMC_MINUTES', 'GDP', 'PMI', 'RETAIL_SALES', 'JOBLESS_CLAIMS', 'OTHER']
});
// Type-specific payload fields.  Values are optional at creation (a scheduled
// earnings event has no actual EPS yet); the revision carries the actuals.
const PAYLOAD = Object.freeze({
  NewsEvent: ['headline', 'summary', 'url'],
  CatalystEvent: ['description', 'scheduled', 'url'],
  EarningsEvent: ['fiscal_period', 'session', 'eps_estimate', 'eps_actual', 'revenue_estimate', 'revenue_actual', 'guidance_direction'],
  AnalystEvent: ['firm', 'analyst', 'rating_from', 'rating_to', 'target_from', 'target_to', 'currency'],
  MacroEvent: ['region', 'indicator', 'consensus', 'actual', 'previous', 'unit']
});
const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function hash(value) { let h = 0x811c9dc5; const text = stable(value); for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); }
const time = value => { const parsed = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };

// Build and validate one immutable event.  Throws on anything that would make
// the record unusable for point-in-time research.
function createEvent(type, input) {
  if (!TYPES.includes(type)) throw new Error(`CATALYST_TYPE_INVALID: ${type}`);
  const eventTime = time(input.event_time), availableAt = time(input.available_at), ingestedAt = time(input.ingested_at ?? input.available_at);
  if (eventTime === null) throw new Error('CATALYST_EVENT_TIME_REQUIRED');
  if (availableAt === null) throw new Error('CATALYST_AVAILABLE_AT_REQUIRED: the knowledge time is what prevents lookahead');
  if (ingestedAt !== null && ingestedAt < availableAt) throw new Error('CATALYST_INGESTED_BEFORE_AVAILABLE');
  const tickers = [...new Set((input.tickers ?? (input.ticker ? [input.ticker] : [])).map(item => String(item).toUpperCase()))];
  if (type !== 'MacroEvent' && !tickers.length) throw new Error('CATALYST_TICKER_REQUIRED');
  if (tickers.some(ticker => !TICKER.test(ticker))) throw new Error('CATALYST_TICKER_INVALID');
  if (!CATEGORIES[type].includes(input.category)) throw new Error(`CATALYST_CATEGORY_INVALID: ${input.category} for ${type}`);
  const directionality = input.directionality ?? 'UNKNOWN';
  if (!DIRECTIONALITY.includes(directionality)) throw new Error('CATALYST_DIRECTIONALITY_INVALID');
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('CATALYST_CONFIDENCE_OUT_OF_RANGE');
  if (!EXTRACTION.includes(input.extraction)) throw new Error('CATALYST_EXTRACTION_REQUIRED: MACHINE_EXTRACTED or HUMAN_REVIEWED');
  if (input.extraction === 'HUMAN_REVIEWED' && (!input.reviewed_by || time(input.reviewed_at) === null)) throw new Error('CATALYST_REVIEW_PROVENANCE_REQUIRED');
  // A human review makes the event knowable no earlier than the review time
  // only when the event was not already published; callers set available_at.
  const source = input.source || {};
  if (!source.name) throw new Error('CATALYST_SOURCE_REQUIRED');
  if (input.raw === undefined || input.raw === null) throw new Error('CATALYST_RAW_PROVENANCE_REQUIRED');
  const payload = Object.fromEntries(PAYLOAD[type].filter(key => input.payload?.[key] !== undefined).map(key => [key, input.payload[key]]));
  const unknown = Object.keys(input.payload || {}).filter(key => !PAYLOAD[type].includes(key));
  if (unknown.length) throw new Error(`CATALYST_PAYLOAD_UNKNOWN_FIELDS: ${unknown.join(',')}`);
  const record = {
    schema_version: VERSION, type, category: input.category, tickers, event_time: eventTime, available_at: availableAt, ingested_at: ingestedAt,
    source: {name: String(source.name), kind: source.kind || 'UNSPECIFIED', url: source.url || null, license: source.license || null},
    directionality, confidence, extraction: input.extraction,
    extractor: input.extraction === 'MACHINE_EXTRACTED' ? (input.extractor || {name: 'UNSPECIFIED', version: null}) : null,
    review: input.extraction === 'HUMAN_REVIEWED' ? {reviewed_by: input.reviewed_by, reviewed_at: time(input.reviewed_at)} : null,
    payload, raw_provenance: {raw_hash: hash(input.raw), raw_ref: input.raw_ref || null},
    supersedes: input.supersedes || null
  };
  return Object.freeze({...record, event_id: `${type.replace('Event', '').toLowerCase()}-${hash(record)}`});
}
// Point-in-time view: events knowable at decision time, with superseded
// revisions removed only when their replacement was itself knowable.
function asOf(events, decisionTime, {ticker = null, types = TYPES, minConfidence = 0, humanReviewedOnly = false} = {}) {
  const t = time(decisionTime); if (t === null) throw new Error('CATALYST_DECISION_TIME_REQUIRED');
  const visible = events.filter(event => event.available_at <= t && types.includes(event.type) && event.confidence >= minConfidence && (!humanReviewedOnly || event.extraction === 'HUMAN_REVIEWED') && (!ticker || event.type === 'MacroEvent' || event.tickers.includes(String(ticker).toUpperCase())));
  const superseded = new Set(visible.map(event => event.supersedes).filter(Boolean));
  return visible.filter(event => !superseded.has(event.event_id)).sort((a, b) => a.available_at - b.available_at || a.event_id.localeCompare(b.event_id));
}
// Guard used by any future feature builder: throws if a feature row cites an
// event that was not knowable at its decision time.
function assertPointInTime(featureRow, events) {
  const byId = new Map(events.map(event => [event.event_id, event]));
  for (const id of featureRow.event_ids || []) { const event = byId.get(id); if (!event) throw new Error(`CATALYST_UNKNOWN_EVENT: ${id}`); if (event.available_at > featureRow.decision_time) throw new Error(`LOOKAHEAD_REJECTED: ${id} available after decision`); }
  return true;
}

module.exports = {VERSION, TYPES, CATEGORIES, DIRECTIONALITY, EXTRACTION, PAYLOAD, createEvent, asOf, assertPointInTime, hash};
