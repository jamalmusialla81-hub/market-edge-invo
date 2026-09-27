// Continuous PAPER forward loop against the persistent paper session.
//
// Each cycle:
//   1. advance every open paper trade through the live 5m candles completed
//      since its last check (stop / TP1 / breakeven / TP2 / timeout exits)
//   2. run the real Market Edge scan (backend/scan-core.mjs, read only)
//   3. no rank #1 candidate -> record NO_TRADE; never manufacture a trade
//   4. otherwise read the live mid and hand the signal to /paper/signal,
//      which validates freshness, rejects duplicates, sizes by risk,
//      approves or walks down leverage, routes, and opens the trade
//   5. reconcile ledger vs canonical portfolio (halts on divergence)
//
// If live market data can't be read for an open trade, the loop does not
// open new risk that cycle (fail closed) and says so in the log.
//
// CYCLE_INTERVAL_MS defaults to production's 5-minute cadence. MAX_CYCLES is
// unbounded unless set. LEVERAGE_ROTATION (e.g. "1,2,3,5,10") rotates the
// *requested* paper leverage; risk decides what is actually approved.
import { runOnce, toInstrument } from './fetch_signal.mjs';
import { fetchCompletedCandles, fetchMid, MARKET_PRICE_SOURCE } from './market_data.mjs';

const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || 300000);
const MAX_CYCLES = process.env.MAX_CYCLES ? Number(process.env.MAX_CYCLES) : Infinity;
const LEVERAGE_ROTATION = String(process.env.LEVERAGE_ROTATION || '1').split(',').map(Number).filter((n) => n > 0);
const SEGMENT = process.env.SEGMENT_NAME || `local-${Date.now()}`;

export function emptyMetrics() {
  return {
    started_at: Date.now(), cycles: 0, signals_observed: 0, no_valid_candidate: 0,
    stale_signals_blocked: 0, duplicate_signals_blocked: 0, valid_intents: 0,
    risk_approvals: 0, risk_rejections: 0, fills: 0, errors: 0,
    exits: 0, stale_market_data: 0, reconciliation_checks: 0, reconciliation_failures: 0,
  };
}

async function api(method, path, body) {
  const key = process.env.MARKET_EDGE_EXEC_API_KEY;
  if (!key) throw new Error('MARKET_EDGE_EXEC_API_KEY is not set');
  const base = process.env.EXECUTION_SERVICE_URL || 'http://localhost:8000';
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'X-API-Key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status >= 500 || response.status === 401 || response.status === 422) {
    throw new Error(`execution-service ${method} ${path} -> HTTP ${response.status}`);
  }
  return { status: response.status, body: json };
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
    const fillStatus = posted.body?.fill?.status;
    if (posted.body?.trade || fillStatus === 'FILLED' || fillStatus === 'PARTIALLY_FILLED') metrics.fills += 1;
    return 'EXECUTED';
  }
  const reason = posted.body?.detail?.reason || posted.body?.reason;
  if (reason === 'STALE_SIGNAL' || reason === 'STALE_MARKET_DATA') { metrics.stale_signals_blocked += 1; return 'STALE'; }
  if (reason && String(reason).includes('DUPLICATE')) { metrics.duplicate_signals_blocked += 1; return 'DUPLICATE'; }
  metrics.risk_rejections += 1;
  return `REJECTED:${reason || 'UNKNOWN'}`;
}

export async function advanceOpenTrades(metrics, { candles = fetchCompletedCandles, now = Date.now } = {}) {
  const open = (await api('GET', '/paper/open')).body.trades || [];
  let dataOk = true;
  const exits = [];
  for (const trade of open) {
    let rows;
    try {
      rows = await candles(trade.coin, trade.last_checked_ms, { now: now() });
    } catch (error) {
      dataOk = false;
      metrics.stale_market_data += 1;
      console.error(JSON.stringify({ event: 'STALE_MARKET_DATA', instrument: trade.instrument, error: error.message }));
      continue;
    }
    const marked = (await api('POST', '/paper/mark', { instrument: trade.instrument, candles: rows })).body;
    for (const exit of marked.exits || []) exits.push({ instrument: trade.instrument, ...exit });
  }
  metrics.exits += exits.length;
  return { open: open.length, exits, dataOk };
}

export async function runCycle(cycle, metrics, deps = {}) {
  const { scan = runOnce, mid = fetchMid } = deps;
  const lifecycle = await advanceOpenTrades(metrics, deps);
  const result = await scan({ dryRun: true });
  if (!result.signal) {
    await api('POST', '/paper/no-trade', { reason: result.reason || 'NO_VALID_CANDIDATE', detail: { scanId: result.scanId, status: result.status } });
    const outcome = classify(result, metrics);
    return { outcome, lifecycle };
  }
  if (!lifecycle.dataOk) {
    // Can't see open positions' live prices: do not add risk this cycle.
    await api('POST', '/paper/no-trade', { reason: 'STALE_MARKET_DATA_FOR_OPEN_POSITIONS', detail: { signal_id: result.signal.signal_id } });
    metrics.cycles += 1;
    metrics.signals_observed += 1;
    metrics.stale_signals_blocked += 1;
    return { outcome: 'STALE', lifecycle };
  }
  let mark = { price: null, at: null };
  try {
    mark = await mid(result.coin || result.signal.asset);
  } catch (error) {
    metrics.stale_market_data += 1;
    console.error(JSON.stringify({ event: 'NO_LIVE_MID', coin: result.coin || result.signal.asset, error: error.message }));
  }
  const leverage = LEVERAGE_ROTATION[cycle % LEVERAGE_ROTATION.length] || 1;
  const posted = await api('POST', '/paper/signal', {
    signal: result.signal, instrument: toInstrument(result.signal.asset), coin: result.coin || result.signal.asset,
    mark_price: mark.price, mark_at_ms: mark.at, requested_leverage: leverage,
    market_price_source: MARKET_PRICE_SOURCE,
  });
  const outcome = classify({ ...result, posted }, metrics);
  return { outcome, lifecycle, signal_id: result.signal.signal_id, reason: posted.body?.reason, leverage };
}

export async function runLoop({ maxCycles = MAX_CYCLES, intervalMs = CYCLE_INTERVAL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), deps = {} } = {}) {
  const metrics = emptyMetrics();
  const { body: seg } = await api('POST', '/paper/segment/start', { segment: SEGMENT });
  try {
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      try {
        const cycleResult = await runCycle(cycle, metrics, deps);
        const rec = (await api('POST', '/reconcile', {})).body;
        metrics.reconciliation_checks += 1;
        if (rec.reconciled === false) metrics.reconciliation_failures += 1;
        console.log(JSON.stringify({ cycle, at: new Date().toISOString(), ...cycleResult, reconciled: rec.reconciled, halted: rec.halted }));
      } catch (error) {
        metrics.errors += 1;
        metrics.cycles += 1;
        console.error(JSON.stringify({ cycle, outcome: 'ERROR', error: error.message }));
      }
      if (cycle < maxCycles - 1) await sleep(intervalMs);
    }
  } finally {
    await api('POST', '/paper/segment/end', { segment_row: seg.segment_row }).catch(() => {});
  }
  metrics.ended_at = Date.now();
  const report = (await api('GET', '/paper/report')).body;
  return { metrics, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoop({}).then((result) => {
    console.log('--- FORWARD_LOOP_METRICS ---');
    console.log(JSON.stringify(result.metrics, null, 2));
    console.log('--- FORWARD_PAPER_REPORT ---');
    const { trades, ...summary } = result.report;
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error) => {
    console.error('FORWARD_LOOP_FAILED:', error.message);
    process.exit(1);
  });
}
