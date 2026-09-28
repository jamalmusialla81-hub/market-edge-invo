'use strict';

// Phase 16 — microstructure PREP ONLY.  An interface for future L2 research;
// no provider is configured, no model (DeepLOB or otherwise) exists, and
// nothing here is imported by production, execution, Nautilus or Hummingbot.
//
// ALPHA and EXECUTION are kept separate: an alpha verdict (is the candidate
// worth taking?) never changes because of microstructure; microstructure only
// decides whether NOW is a good moment to execute it.  Fails closed: missing
// or stale book data yields EXECUTION_UNKNOWN -> WAIT, never a silent PROCEED.

const VERSION = 'microstructure-interface-v0';
const FIELDS = Object.freeze(['spread_bps', 'bid_depth', 'ask_depth', 'order_book_imbalance', 'microprice', 'queue_imbalance', 'aggressive_buy_flow', 'aggressive_sell_flow', 'short_horizon_adverse_selection']);
const REQUIRED_PROVENANCE = Object.freeze(['provider', 'venue', 'instrument', 'instrument_type', 'source_timestamp', 'capture_timestamp']);
const finite = v => typeof v === 'number' && Number.isFinite(v);

// A provider must implement snapshot(instrument, T) -> {fields..., provenance}.
// The only provider in this phase reports NOT_CONFIGURED.
const NotConfiguredProvider = Object.freeze({name: 'NONE', snapshot: () => ({status: 'SKIPPED_NOT_CONFIGURED'})});

// Pure computation from one L2 snapshot plus recent trades.  depthBps bounds
// the depth window around mid.  Returns null fields when inputs are missing.
function fromBook({bids = [], asks = [], trades = [], depthBps = 10} = {}) {
  const bestBid = bids[0], bestAsk = asks[0];
  if (!bestBid || !bestAsk || !(bestAsk[0] > bestBid[0])) return Object.fromEntries(FIELDS.map(f => [f, null]));
  const mid = (bestBid[0] + bestAsk[0]) / 2, lo = mid * (1 - depthBps / 1e4), hi = mid * (1 + depthBps / 1e4);
  const bidDepth = bids.filter(([p]) => p >= lo).reduce((t, [, q]) => t + q, 0), askDepth = asks.filter(([p]) => p <= hi).reduce((t, [, q]) => t + q, 0);
  const buy = trades.filter(t => t.aggressor === 'buy').reduce((s, t) => s + t.qty, 0), sell = trades.filter(t => t.aggressor === 'sell').reduce((s, t) => s + t.qty, 0);
  return {
    spread_bps: (bestAsk[0] - bestBid[0]) / mid * 1e4, bid_depth: bidDepth, ask_depth: askDepth,
    order_book_imbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null,
    microprice: (bestBid[0] * bestAsk[1] + bestAsk[0] * bestBid[1]) / (bestBid[1] + bestAsk[1]),
    queue_imbalance: (bestBid[1] - bestAsk[1]) / (bestBid[1] + bestAsk[1]),
    aggressive_buy_flow: buy, aggressive_sell_flow: sell,
    short_horizon_adverse_selection: null      // needs post-trade mid path; defined in a future pre-registration
  };
}

// policy thresholds are REQUIRED and deliberately have no defaults: none have
// been researched, so none may be assumed.
function assess({alphaValid, micro, policy, T, maxAgeMs}) {
  const alpha = alphaValid ? 'ALPHA_VALID' : 'ALPHA_INVALID';
  if (!alphaValid) return {alpha, execution: 'NOT_EVALUATED', decision: 'SKIP'};
  if (!policy || !finite(policy.maxSpreadBps) || !finite(policy.minOpposingDepth)) return {alpha, execution: 'EXECUTION_UNKNOWN', decision: 'WAIT', reason: 'NO_RESEARCHED_POLICY'};
  if (!micro || micro.status || !micro.provenance || REQUIRED_PROVENANCE.some(k => micro.provenance[k] === undefined || micro.provenance[k] === null)) return {alpha, execution: 'EXECUTION_UNKNOWN', decision: 'WAIT', reason: 'MISSING_MICROSTRUCTURE_OR_PROVENANCE'};
  if (!finite(maxAgeMs) || T - micro.provenance.source_timestamp > maxAgeMs || micro.provenance.source_timestamp > T) return {alpha, execution: 'EXECUTION_UNKNOWN', decision: 'WAIT', reason: 'STALE_OR_FUTURE_SNAPSHOT'};
  const opposing = policy.side === 'long' ? micro.ask_depth : micro.bid_depth;
  if (!finite(micro.spread_bps) || !finite(opposing)) return {alpha, execution: 'EXECUTION_UNKNOWN', decision: 'WAIT', reason: 'INCOMPLETE_FIELDS'};
  if (micro.spread_bps > policy.maxSpreadBps || opposing < policy.minOpposingDepth) return {alpha, execution: 'EXECUTION_UNFAVOURABLE', decision: 'WAIT'};
  return {alpha, execution: 'EXECUTION_FAVOURABLE', decision: 'PROCEED_RESEARCH_ONLY'};
}

module.exports = {VERSION, FIELDS, REQUIRED_PROVENANCE, NotConfiguredProvider, fromBook, assess};
