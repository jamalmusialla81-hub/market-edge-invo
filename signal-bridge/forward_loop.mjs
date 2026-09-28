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
// Open positions are managed between discovery cycles by the separate fast
// open-position monitor (position_monitor.mjs, ~10s, POSITION_MONITOR_INTERVAL_MS
// clamped to 5-60s). It only evaluates stop/TP/timeout for positions that are
// already open and sleeps when none are; discovery wakes it after each cycle.
//
// CYCLE_INTERVAL_MS defaults to production's 5-minute cadence. MAX_CYCLES is
// unbounded unless set. FORWARD_LOOP_STDIN_CONTROL=1 (set by the desktop app)
// lets a "STOP" line on stdin end the loop after the current cycle instead of
// killing it mid-request -- works the same on macOS and Windows. LEVERAGE_ROTATION (e.g. "1,2,3,5,10") rotates the
// *requested* paper leverage; risk decides what is actually approved.
import { runOnce, toInstrument } from './fetch_signal.mjs';
import { fetchCompletedCandles, fetchL2Book, fetchMid, MARKET_PRICE_SOURCE } from './market_data.mjs';
import { buildShadowPayload, executionFromCycle, riskInputsFor, scanCandlesByCoin, SCOPE_RESEARCH_SUPPLEMENT } from './shadow_capture.mjs';
import { supplementMarkets, supplementPerCycle, supplementPlan } from './research_universe.mjs';
import { runLiveScan } from '../backend/scan-core.mjs';
import { monitorIntervalMs, PositionMonitor } from './position_monitor.mjs';

// The DISCOVERY cadence (scan -> rank -> maybe open). Unchanged: 5 minutes.
export const DEFAULT_CYCLE_INTERVAL_MS = 300000;
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || DEFAULT_CYCLE_INTERVAL_MS);
const MONITOR_INTERVAL_MS = monitorIntervalMs(process.env.POSITION_MONITOR_INTERVAL_MS);
const MAX_CYCLES = process.env.MAX_CYCLES ? Number(process.env.MAX_CYCLES) : Infinity;
const LEVERAGE_ROTATION = String(process.env.LEVERAGE_ROTATION || '1').split(',').map(Number).filter((n) => n > 0);
const SEGMENT = process.env.SEGMENT_NAME || `local-${Date.now()}`;
// Shadow learning (research only; see shadow_capture.mjs). It observes the
// scan this loop already runs -- it never adds scans, never changes the
// paper cadence, and a shadow failure never affects the paper cycle.
// SHADOW_EVERY_N_CYCLES=3 would record every 3rd scan (the interval is stored
// with every scan row); SHADOW_EXTRA_FETCH_PER_CYCLE bounds the extra candle
// requests used for the 48h/72h windows the scan's own 5m history can't reach.
const SHADOW_ENABLED = process.env.SHADOW_LEARNING !== '0';
const SHADOW_EVERY_N_CYCLES = Math.max(1, Number(process.env.SHADOW_EVERY_N_CYCLES || 1));
const SHADOW_EXTRA_FETCH_PER_CYCLE = Math.max(0, Number(process.env.SHADOW_EXTRA_FETCH_PER_CYCLE ?? 2));
// Approved research assets the production scan did not evaluate are observed
// research-only on a deterministic rotation (research_universe.mjs); bounded
// to SHADOW_SUPPLEMENT_PER_CYCLE (default 1, max 3) assets per cycle.
const SHADOW_SUPPLEMENT_PER_CYCLE = supplementPerCycle(process.env.SHADOW_SUPPLEMENT_PER_CYCLE);
const isRateLimited = (error) => /\b429\b/.test(String(error?.message || error));

// Graceful stop: the current cycle always finishes (its mark/signal/reconcile
// calls are each one committed backend transaction), then the loop ends its
// segment and exits. Open trades stay OPEN in the ledger and are advanced from
// their last checked candle on the next start.
export const stopControl = { requested: false, wake: null };
export function requestStop(reason = 'STOP_REQUESTED') {
  if (stopControl.requested) return;
  stopControl.requested = true;
  console.log(JSON.stringify({ event: 'LOOP_STOP_REQUESTED', reason, at: new Date().toISOString() }));
  if (stopControl.wake) stopControl.wake();
}

function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { stopControl.wake = null; resolve(); }, ms);
    stopControl.wake = () => { clearTimeout(timer); stopControl.wake = null; resolve(); };
  });
}

export function emptyMetrics() {
  return {
    started_at: Date.now(), cycles: 0, signals_observed: 0, no_valid_candidate: 0,
    stale_signals_blocked: 0, duplicate_signals_blocked: 0, valid_intents: 0,
    risk_approvals: 0, risk_rejections: 0, fills: 0, errors: 0,
    exits: 0, stale_market_data: 0, reconciliation_checks: 0, reconciliation_failures: 0,
  };
}

export async function api(method, path, body) {
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

// Research-only side channel: record every candidate and market state of this
// scan with the paper decision it got, then label whatever windows are due.
// Any error is logged and swallowed -- paper execution never depends on it.
export async function shadowObserve(cycle, result, outcome, posted, deps = {}) {
  if (!result?.scan?.research) return null;
  const { candles = fetchCompletedCandles, intervalMs = CYCLE_INTERVAL_MS, extraFetches = SHADOW_EXTRA_FETCH_PER_CYCLE,
    researchScan = runLiveScan, supplementCount = SHADOW_SUPPLEMENT_PER_CYCLE } = deps;
  const out = { recorded: 0, resolved: 0, errors: 0 };
  let production = null;
  try {
    production = buildShadowPayload(result, executionFromCycle(outcome, result, posted), { observationIntervalMs: intervalMs * SHADOW_EVERY_N_CYCLES });
    if (production) out.recorded = (await api('POST', '/shadow/scan', production)).body?.inserted || 0;
  } catch (error) {
    out.errors += 1;
    console.error(JSON.stringify({ event: 'SHADOW_RECORD_FAILED', cycle, error: error.message }));
  }
  // Research-only supplement: approved research assets this scan did not
  // evaluate, a few per cycle, same frozen generator, never submitted.
  const extraCandles = {};
  const plan = supplementPlan(result.scan, cycle, supplementCount);
  out.supplement = { selected: plan.selected, skipped: plan.skipped, not_on_venue: plan.notOnVenue, recorded: 0 };
  if (plan.selected.length) {
    try {
      const scan = await researchScan({ markets: supplementMarkets(plan.selected), includeResearch: true, now: Date.now() });
      const payload = buildShadowPayload({ scan }, null, { observationIntervalMs: intervalMs * SHADOW_EVERY_N_CYCLES, scope: SCOPE_RESEARCH_SUPPLEMENT,
        crossMarketContext: production?.scan?.cross_market ?? null, assetCtxs: result.scan.research.assetCtxs });
      if (payload) out.supplement.recorded = (await api('POST', '/shadow/scan', payload)).body?.inserted || 0;
      Object.assign(extraCandles, scanCandlesByCoin({ scan }));
      out.supplement.failures = scan?.research?.failures || [];
    } catch (error) {
      out.errors += 1;
      out.supplement.error = error.message;
      console.error(JSON.stringify({ event: 'SHADOW_SUPPLEMENT_FAILED', cycle, assets: plan.selected, error: error.message }));
    }
  }
  try {
    const pending = (await api('GET', '/shadow/pending')).body?.pending || [];
    const fromScan = { ...extraCandles, ...scanCandlesByCoin(result) };
    let fetched = 0;
    for (const { coin, since_ms: since } of pending) {
      let rows = fromScan[coin];
      if (!rows || rows[0].time > since) {
        if (fetched >= extraFetches) continue;
        fetched += 1;
        try { rows = await candles(coin, since, { now: Date.now() }); } catch (error) {
          console.error(JSON.stringify({ event: 'SHADOW_CANDLES_UNAVAILABLE', coin, error: error.message }));
          // Delayed resolution is the lowest priority: on a rate limit, stop
          // asking this cycle (windows stay pending and are retried later).
          if (isRateLimited(error)) { out.deferred_rate_limited = true; break; }
          continue;   // no fallback: the window stays pending
        }
      }
      const res = (await api('POST', '/shadow/resolve', { coin, venue: 'HYPERLIQUID', interval: '5m', candles: rows })).body;
      out.resolved += res?.labels || 0;
    }
  } catch (error) {
    out.errors += 1;
    console.error(JSON.stringify({ event: 'SHADOW_RESOLVE_FAILED', cycle, error: error.message }));
  }
  return out;
}

export async function runCycle(cycle, metrics, deps = {}) {
  const { scan = runOnce, mid = fetchMid, book = fetchL2Book, shadow = SHADOW_ENABLED } = deps;
  const observe = shadow && cycle % SHADOW_EVERY_N_CYCLES === 0;
  const lifecycle = await advanceOpenTrades(metrics, deps);
  // Research capture adds no requests (the scan already fetched every frame);
  // it is always on so Risk Sizing V2 gets its daily-candle input.
  const result = await scan({ dryRun: true, includeResearch: true });
  if (!result.signal) {
    await api('POST', '/paper/no-trade', { reason: result.reason || 'NO_VALID_CANDIDATE', detail: { scanId: result.scanId, status: result.status } });
    const outcome = classify(result, metrics);
    const shadowResult = observe ? await shadowObserve(cycle, result, outcome, null, deps) : null;
    return { outcome, lifecycle, ...(shadowResult ? { shadow: shadowResult } : {}) };
  }
  if (!lifecycle.dataOk) {
    // Can't see open positions' live prices: do not add risk this cycle.
    await api('POST', '/paper/no-trade', { reason: 'STALE_MARKET_DATA_FOR_OPEN_POSITIONS', detail: { signal_id: result.signal.signal_id } });
    metrics.cycles += 1;
    metrics.signals_observed += 1;
    metrics.stale_signals_blocked += 1;
    const shadowResult = observe ? await shadowObserve(cycle, result, 'STALE_OPEN_POSITIONS', null, deps) : null;
    return { outcome: 'STALE', lifecycle, ...(shadowResult ? { shadow: shadowResult } : {}) };
  }
  let mark = { price: null, at: null };
  try {
    mark = await mid(result.coin || result.signal.asset);
  } catch (error) {
    metrics.stale_market_data += 1;
    console.error(JSON.stringify({ event: 'NO_LIVE_MID', coin: result.coin || result.signal.asset, error: error.message }));
  }
  const leverage = LEVERAGE_ROTATION[cycle % LEVERAGE_ROTATION.length] || 1;
  const coin = result.coin || result.signal.asset;
  // Risk Sizing V2 inputs: same-scan daily candles + one order-book read for
  // this one signal. A missing input is sent as missing, never filled in.
  const riskInputs = riskInputsFor(result.scan?.research, coin) || {};
  try {
    riskInputs.depth = await book(coin);
  } catch (error) {
    console.error(JSON.stringify({ event: 'NO_ORDER_BOOK', coin, error: error.message }));
  }
  const posted = await api('POST', '/paper/signal', {
    signal: result.signal, instrument: toInstrument(result.signal.asset), coin,
    mark_price: mark.price, mark_at_ms: mark.at, requested_leverage: leverage, meta: result.meta || undefined,
    market_price_source: MARKET_PRICE_SOURCE, risk_inputs: riskInputs,
  });
  const outcome = classify({ ...result, posted }, metrics);
  const shadowResult = observe ? await shadowObserve(cycle, result, outcome, posted, deps) : null;
  return { outcome, lifecycle, signal_id: result.signal.signal_id, reason: posted.body?.reason, leverage, ...(shadowResult ? { shadow: shadowResult } : {}) };
}

// `monitor`: undefined -> the real open-position monitor; null -> none (tests).
export async function runLoop({ maxCycles = MAX_CYCLES, intervalMs = CYCLE_INTERVAL_MS, sleep = interruptibleSleep, deps = {}, monitor } = {}) {
  const metrics = emptyMetrics();
  const { body: seg } = await api('POST', '/paper/segment/start', { segment: SEGMENT });
  // Restart path too: positions persisted by a previous run are picked up by
  // the monitor's first look at /paper/open.
  const positions = monitor === undefined ? new PositionMonitor({ api, intervalMs: MONITOR_INTERVAL_MS }) : monitor;
  void positions?.start();
  try {
    for (let cycle = 0; cycle < maxCycles && !stopControl.requested; cycle += 1) {
      console.log(JSON.stringify({ event: 'CYCLE_START', cycle, at: new Date().toISOString(), interval_ms: intervalMs }));
      try {
        const cycleResult = await runCycle(cycle, metrics, deps);
        const rec = (await api('POST', '/reconcile', {})).body;
        metrics.reconciliation_checks += 1;
        if (rec.reconciled === false) metrics.reconciliation_failures += 1;
        console.log(JSON.stringify({ cycle, at: new Date().toISOString(), ...cycleResult, reconciled: rec.reconciled, halted: rec.halted }));
        // A position can only have opened in this cycle: let the monitor look now.
        void positions?.wake();
      } catch (error) {
        metrics.errors += 1;
        metrics.cycles += 1;
        console.error(JSON.stringify({ cycle, outcome: 'ERROR', error: error.message }));
      }
      if (cycle < maxCycles - 1 && !stopControl.requested) {
        console.log(JSON.stringify({ event: 'NEXT_CYCLE_AT', at: new Date(Date.now() + intervalMs).toISOString() }));
        await sleep(intervalMs);
      }
    }
  } finally {
    positions?.stop();
    await api('POST', '/paper/segment/end', { segment_row: seg.segment_row }).catch(() => {});
  }
  metrics.ended_at = Date.now();
  const report = (await api('GET', '/paper/report')).body;
  return { metrics, report };
}

if (import.meta.url === `file://${process.argv[1]}` || process.env.FORWARD_LOOP_MAIN === '1') {
  if (process.env.FORWARD_LOOP_STDIN_CONTROL === '1') {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { if (String(chunk).split(/\r?\n/).includes('STOP')) requestStop('STDIN_STOP'); });
    process.stdin.on('end', () => requestStop('STDIN_CLOSED'));  // parent (the app) went away
  }
  runLoop({}).then((result) => {
    console.log('--- FORWARD_LOOP_METRICS ---');
    console.log(JSON.stringify(result.metrics, null, 2));
    console.log('--- FORWARD_PAPER_REPORT ---');
    const { trades, ...summary } = result.report;
    console.log(JSON.stringify(summary, null, 2));
    // An open stdin control pipe would otherwise keep the process alive.
    process.exit(0);
  }).catch((error) => {
    console.error('FORWARD_LOOP_FAILED:', error.message);
    process.exit(1);
  });
}
