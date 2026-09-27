import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, emptyMetrics, runCycle } from './forward_loop.mjs';
import { parseCompletedCandles } from './market_data.mjs';
import { bestTradeNowToAlphaSignal, toCoin, toInstrument } from './fetch_signal.mjs';

test('classify counts NO_VALID_CANDIDATE when the scan has no bestTradeNow', () => {
  const metrics = emptyMetrics();
  const outcome = classify({ signal: null }, metrics);
  assert.equal(outcome, 'NO_VALID_CANDIDATE');
  assert.equal(metrics.no_valid_candidate, 1);
  assert.equal(metrics.signals_observed, 0);
});

test('classify counts a real fill as EXECUTED and increments fills', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 200, body: { accepted: true, fill: { status: 'FILLED' } } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'EXECUTED');
  assert.equal(metrics.valid_intents, 1);
  assert.equal(metrics.risk_approvals, 1);
  assert.equal(metrics.fills, 1);
  assert.equal(metrics.signals_observed, 1);
});

test('classify counts a stale rejection without counting it as a risk rejection', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 409, body: { detail: { reason: 'STALE_SIGNAL' } } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'STALE');
  assert.equal(metrics.stale_signals_blocked, 1);
  assert.equal(metrics.risk_rejections, 0);
});

test('classify counts a duplicate rejection separately from a risk rejection', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 409, body: { reason: 'EXECUTION_ROUTER_DUPLICATE_SIGNAL: s1' } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'DUPLICATE');
  assert.equal(metrics.duplicate_signals_blocked, 1);
});

test('classify falls back to a risk rejection for any other reason', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 409, body: { detail: { reason: 'MAX_PORTFOLIO_EXPOSURE_EXCEEDED' } } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'REJECTED:MAX_PORTFOLIO_EXPOSURE_EXCEEDED');
  assert.equal(metrics.risk_rejections, 1);
});

test('bestTradeNowToAlphaSignal maps the real scan-core.mjs field names, not guessed ones', () => {
  const scan = {
    scanId: 'scan-abc123', scannedAt: 1700000000000,
    bestTradeNow: { asset: 'BTC', direction: 'long', entry: 60000, stop: 58000, tp1: 62000, tp2: 64000, combined_score: 88, strategy: 'TREND CONTINUATION' },
  };
  const signal = bestTradeNowToAlphaSignal(scan);
  assert.deepEqual(signal, {
    signal_id: 'scan-abc123-BTC', asset: 'BTC', direction: 'long', timestamp: 1700000000000,
    entry: 60000, stop: 58000, targets: [62000, 64000], quant_score: 88, strategy_id: 'TREND CONTINUATION',
  });
});

test('bestTradeNowToAlphaSignal returns null when the scan found no valid candidate', () => {
  assert.equal(bestTradeNowToAlphaSignal({ scanId: 's', scannedAt: 0, bestTradeNow: null }), null);
});

test('toInstrument appends -PERP to the asset', () => {
  assert.equal(toInstrument('ETH'), 'ETH-PERP');
});

test('classify counts an accepted /paper/signal trade as a fill', () => {
  const metrics = emptyMetrics();
  const outcome = classify({ signal: { signal_id: 's1' }, posted: { status: 200, body: { accepted: true, trade: { trade_id: 's1' } } } }, metrics);
  assert.equal(outcome, 'EXECUTED');
  assert.equal(metrics.fills, 1);
});

test('classify treats STALE_MARKET_DATA as stale, not a risk rejection', () => {
  const metrics = emptyMetrics();
  const outcome = classify({ signal: { signal_id: 's1' }, posted: { status: 200, body: { accepted: false, reason: 'STALE_MARKET_DATA' } } }, metrics);
  assert.equal(outcome, 'STALE');
  assert.equal(metrics.risk_rejections, 0);
});

test('parseCompletedCandles keeps only completed, well-formed 5m candles in time order', () => {
  const now = 1_000_000_000;
  const rows = [
    { t: now - 600_000, o: '1', h: '2', l: '0.5', c: '1.5' },
    { t: now - 900_000, o: '1', h: '2', l: '0.5', c: '1.5' },
    { t: now - 100_000, o: '1', h: '2', l: '0.5', c: '1.5' }, // still forming
    { t: now - 1_200_000, o: '1', h: '0.9', l: '0.5', c: '1.5' }, // high below close: malformed
  ];
  const candles = parseCompletedCandles(rows, now);
  assert.deepEqual(candles.map((c) => c.time), [now - 900_000, now - 600_000]);
  assert.equal(candles[0].high, 2);
});

test('toCoin prefers the scanned Hyperliquid instrument over the asset symbol', () => {
  assert.equal(toCoin({ bestTradeNow: { asset: 'PEPE', instrument: 'kPEPE' } }), 'kPEPE');
  assert.equal(toCoin({ bestTradeNow: { asset: 'ETH' } }), 'ETH');
  assert.equal(toCoin({ bestTradeNow: null }), null);
});

function fakeService(openTrades) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const body = path === '/paper/open' ? { trades: openTrades } : path === '/paper/mark' ? { exits: [] } : { accepted: true, trade: {} };
    return { status: 200, json: async () => body };
  };
  return calls;
}

test('runCycle records NO_TRADE and opens nothing when the scan has no candidate', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const calls = fakeService([]);
  const metrics = emptyMetrics();
  const out = await runCycle(0, metrics, { scan: async () => ({ signal: null, reason: 'NO_VALID_CANDIDATE' }) });
  assert.equal(out.outcome, 'NO_VALID_CANDIDATE');
  assert.ok(calls.some((c) => c.path === '/paper/no-trade'));
  assert.ok(!calls.some((c) => c.path === '/paper/signal'));
});

test('runCycle adds no new risk when an open position has no readable market data (fail closed)', async () => {
  const calls = fakeService([{ trade_id: 't', instrument: 'ETH-PERP', coin: 'ETH', last_checked_ms: 0 }]);
  const metrics = emptyMetrics();
  const out = await runCycle(0, metrics, {
    candles: async () => { throw new Error('HTTP 503'); },
    scan: async () => ({ signal: { signal_id: 's2', asset: 'BTC', direction: 'long', timestamp: Date.now(), entry: 1, stop: 0.9, targets: [1.1] }, coin: 'BTC' }),
    mid: async () => ({ price: 1, at: Date.now() }),
  });
  assert.equal(out.outcome, 'STALE');
  assert.equal(metrics.stale_market_data, 1);
  assert.ok(!calls.some((c) => c.path === '/paper/signal'));
});

test('fetchMid retries a transient failure, but not a missing coin', async () => {
  const { fetchMid } = await import('./market_data.mjs');
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ NEAR: '2.5' }) };
  };
  const waits = [];
  const mid = await fetchMid('NEAR', { fetchImpl: flaky, now: () => 42, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(mid, { price: 2.5, at: 42 });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5000]);
  const limited = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const total = [];
  await assert.rejects(fetchMid('NEAR', { fetchImpl: limited, sleep: async (ms) => { total.push(ms); } }), /after 5 attempts: HTTP 429/);
  assert.ok(total.reduce((a, b) => a + b, 0) > 60000, 'backoff outlasts the per-minute rate-limit window');
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ BTC: '1' }) });
  await assert.rejects(fetchMid('NEAR', { fetchImpl: ok, sleep: async () => {} }), /no live mid for NEAR/);
});
