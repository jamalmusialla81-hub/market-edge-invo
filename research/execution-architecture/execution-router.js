'use strict';

// ExecutionRouter: routes an approved ExecutionIntent to exactly one paper
// backend by signal_id, and refuses to route the same signal_id twice (the
// "one signal -> one order, no duplicate execution" acceptance test). This
// is the ONLY place that decides which backend handles an intent; alpha code
// never talks to a backend directly. Paper-only: no live order placement.
const {ExecutionIntent} = require('./domain-objects.js');

const BACKENDS = Object.freeze({NAUTILUS_NATIVE: 'NAUTILUS_NATIVE', HUMMINGBOT: 'HUMMINGBOT', FUTURE_BROKER: 'FUTURE_BROKER'});

function ExecutionRouter({riskGate, routingTable = {}, backends = {}} = {}) {
  if (typeof riskGate !== 'function') throw new Error('EXECUTION_ROUTER_REQUIRES_RISK_GATE');
  const submitted = new Map(); // signal_id -> backend name, for duplicate-execution detection

  function resolveBackend(intent) {
    const preferred = intent.venue_preference;
    if (preferred && backends[preferred]) return preferred;
    const configured = routingTable[intent.instrument];
    if (configured && backends[configured]) return configured;
    if (backends[BACKENDS.NAUTILUS_NATIVE]) return BACKENDS.NAUTILUS_NATIVE;
    const [fallback] = Object.keys(backends);
    if (!fallback) throw new Error('EXECUTION_ROUTER_NO_BACKENDS_CONFIGURED');
    return fallback;
  }

  async function route(rawIntent, riskDecision) {
    const intent = ExecutionIntent(rawIntent);
    if (submitted.has(intent.signal_id)) {
      throw new Error(`EXECUTION_ROUTER_DUPLICATE_SIGNAL: ${intent.signal_id} already routed to ${submitted.get(intent.signal_id)}`);
    }
    const approval = riskDecision || await riskGate(intent);
    if (!approval || !approval.approved) {
      throw new Error(`EXECUTION_ROUTER_RISK_REJECTED: ${approval?.reason || 'no risk approval supplied'}`);
    }
    if (approval.approved_leverage != null && intent.leverage > approval.approved_leverage) {
      throw new Error(`EXECUTION_ROUTER_LEVERAGE_EXCEEDS_APPROVAL: requested ${intent.leverage} > approved ${approval.approved_leverage}`);
    }
    const backendName = resolveBackend(intent);
    const backend = backends[backendName];
    if (!backend) throw new Error(`EXECUTION_ROUTER_BACKEND_UNAVAILABLE: ${backendName}`);
    submitted.set(intent.signal_id, backendName);
    return {backend: backendName, fill: await backend.submit(intent)};
  }

  return {route, BACKENDS, submittedCount: () => submitted.size};
}

module.exports = {ExecutionRouter, BACKENDS};
