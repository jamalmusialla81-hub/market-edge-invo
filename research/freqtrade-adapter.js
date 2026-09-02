'use strict';

// Adapter only: Freqtrade consumes immutable decisions produced by Market Edge.
// It does not implement or substitute the Quant strategy rules and it cannot
// create exchange orders. This keeps parity evaluation from drifting strategy.
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function assertDecision(decision) {
  const entry = finite(decision?.entry ?? decision?.preferred_entry), stop = finite(decision?.stop), tp1 = finite(decision?.tp1), tp2 = finite(decision?.tp2);
  if (!decision?.signal_id || !['long', 'short'].includes(decision?.direction) || !entry || !stop || !tp1 || entry === stop) throw new Error('FREQTRADE_ADAPTER_INVALID_FROZEN_DECISION');
  return {entry, stop, tp1, tp2};
}
function toResearchSignal(decision) {
  const values = assertDecision(decision), long = decision.direction === 'long';
  return {signal_id: decision.signal_id, timestamp: Number(decision.timestamp), pair: `${decision.asset}/USDT`, direction: decision.direction, enter_long: long ? 1 : 0, enter_short: long ? 0 : 1, entry: values.entry, stop: values.stop, tp1: values.tp1, tp2: values.tp2, rr: finite(decision.rr), stoploss_fraction: long ? (values.stop - values.entry) / values.entry : (values.entry - values.stop) / values.entry, execution: 'RESEARCH_ONLY; Market Edge frozen next-valid execution; stop-first same-candle ordering; no exchange order'};
}
function parity(expected, adapted) {
  const fields = ['timestamp', 'direction', 'entry', 'stop', 'tp1', 'tp2', 'rr'];
  const mismatch = fields.filter(field => finite(expected[field]) !== null && Math.abs(finite(expected[field]) - finite(adapted[field])) > 1e-10 || (finite(expected[field]) === null && expected[field] !== adapted[field]));
  return {pass: mismatch.length === 0, mismatch};
}
function researchConfig() {
  return {dry_run: true, stake_currency: 'USDT', exchange_execution: false, adapter_mode: 'frozen_market_edge_decisions', fill_ordering: 'STOP_FIRST_ON_AMBIGUITY', fee_model: 'round-trip sensitivity: 0.08%, 0.16%, 0.25%, 0.40%'};
}
module.exports = {assertDecision, toResearchSignal, parity, researchConfig};
