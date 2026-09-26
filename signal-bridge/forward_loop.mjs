// Part F: continuous PAPER forward loop wrapping the Part E signal bridge
// (fetch_signal.mjs), proven end-to-end in CI (see execution-stack-ci.yml's
// signal-bridge-e2e job / project memory). Each cycle: fetch the real Market
// Edge scan -> validate freshness -> risk check -> route -> persist ->
// reconcile -> update metrics -> repeat. Never resends a signal_id (each
// scan's signal_id is derived from that scan's own scanId, which is a hash
// of [now, ...] -- a fresh scan always gets a fresh signal_id; idempotency
// at the execution-service is the actual backstop, not this loop's own
// bookkeeping).
//
// CYCLE_INTERVAL_MS defaults to Market Edge's own 5-minute scan cadence
// (backend/wrangler.jsonc). MAX_CYCLES is unset (runs until stopped) for the
// real endurance harness (Part I); CI passes a small bounded value so a test
// run finishes and doesn't hammer live exchanges.
import { runOnce } from './fetch_signal.mjs';

const EXECUTION_SERVICE_URL = process.env.EXECUTION_SERVICE_URL || 'http://localhost:8000';
const EXECUTION_SERVICE_API_KEY = process.env.MARKET_EDGE_EXEC_API_KEY;
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || 300000);
const MAX_CYCLES = process.env.MAX_CYCLES ? Number(process.env.MAX_CYCLES) : Infinity;

export function emptyMetrics() {
  return {
    started_at: Date.now(), cycles: 0, signals_observed: 0, no_valid_candidate: 0,
    stale_signals_blocked: 0, duplicate_signals_blocked: 0, valid_intents: 0,
    risk_approvals: 0, risk_rejections: 0, fills: 0, errors: 0,
  };
}

async function reconcileOnce() {
  const response = await fetch(`${EXECUTION_SERVICE_URL}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': EXECUTION_SERVICE_API_KEY }, body: '{}',
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export function classify(result, metrics) {
  metrics.cycles += 1;
  if (result.signal === null) {
    metrics.no_valid_candidate += 1;
    return 'NO_VALID_CANDIDATE';
  }
  metrics.signals_observed += 1;
  const posted = result.posted;
  if (!posted) return 'DRY_RUN';
  if (posted.status === 200 && posted.body?.accepted) {
    metrics.valid_intents += 1;
    metrics.risk_approvals += 1;
    if (posted.body?.fill?.status === 'FILLED' || posted.body?.fill?.status === 'PARTIALLY_FILLED') metrics.fills += 1;
    return 'EXECUTED';
  }
  const reason = posted.body?.detail?.reason || posted.body?.reason;
  if (reason === 'STALE_SIGNAL') { metrics.stale_signals_blocked += 1; return 'STALE'; }
  if (reason && String(reason).includes('DUPLICATE')) { metrics.duplicate_signals_blocked += 1; return 'DUPLICATE'; }
  metrics.risk_rejections += 1;
  return `REJECTED:${reason || 'UNKNOWN'}`;
}

export async function runLoop({ maxCycles = MAX_CYCLES, intervalMs = CYCLE_INTERVAL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const metrics = emptyMetrics();
  const history = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    let outcome;
    try {
      const result = await runOnce({});
      outcome = classify(result, metrics);
      let reconciliation = null;
      if (outcome === 'EXECUTED') {
        reconciliation = await reconcileOnce();
        if (reconciliation.body?.reconciled === false) metrics.reconciliation_failures = (metrics.reconciliation_failures || 0) + 1;
      }
      history.push({ cycle, at: Date.now(), outcome, scanId: result.scanId, signal_id: result.signal?.signal_id, reconciliation });
      console.log(JSON.stringify({ cycle, outcome, signal_id: result.signal?.signal_id }));
    } catch (error) {
      metrics.errors += 1;
      history.push({ cycle, at: Date.now(), outcome: 'ERROR', error: error.message });
      console.error(JSON.stringify({ cycle, outcome: 'ERROR', error: error.message }));
    }
    if (cycle < maxCycles - 1) await sleep(intervalMs);
  }
  metrics.ended_at = Date.now();
  return { metrics, history };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoop({}).then((result) => {
    console.log('--- FORWARD_LOOP_METRICS ---');
    console.log(JSON.stringify(result.metrics, null, 2));
  }).catch((error) => {
    console.error('FORWARD_LOOP_FAILED:', error.message);
    process.exit(1);
  });
}
