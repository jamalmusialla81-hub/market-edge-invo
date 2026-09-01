import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCompleteTrade, MarketEdgeApiError, parseScanResponse, scanMarkets } from './marketEdgeApi.js';
import { fixtures } from '../test/workerFixtures.js';

test('normalizes Worker fields without changing underlying trade values', () => {
  const parsed = parseScanResponse(fixtures.TRADE_READY);
  assert.equal(parsed.bestTradeNow.entry, fixtures.TRADE_READY.bestTradeNow.entry);
  assert.equal(parsed.bestTradeNow.stop, fixtures.TRADE_READY.bestTradeNow.stop);
  assert.equal(parsed.bestTradeNow.tp1, fixtures.TRADE_READY.bestTradeNow.tp1);
  assert.equal(parsed.bestTradeNow.position.margin, fixtures.TRADE_READY.bestTradeNow.position.margin);
  assert.ok(hasCompleteTrade(parsed.bestTradeNow));
});

test('accepts every supported Worker status and rejects invalid actionability', () => {
  for (const fixture of Object.values(fixtures)) assert.equal(parseScanResponse(fixture).status, fixture.status);
  const malformed = structuredClone(fixtures.TRADE_READY);
  malformed.bestTradeNow.stop = null;
  assert.throws(() => parseScanResponse(malformed), /response rejected/);
  const actionabilityMismatch = structuredClone(fixtures.WAIT_FOR_ENTRY);
  actionabilityMismatch.bestTradeNow = fixtures.TRADE_READY.bestTradeNow;
  assert.throws(() => parseScanResponse(actionabilityMismatch), /Only TRADE_READY/);
});

test('fails closed for HTTP, invalid JSON, network, and malformed response failures', async () => {
  const request = () => scanMarkets({ requestId: 'test', fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Try later' } }), { status: 429 }) });
  await assert.rejects(request, error => error instanceof MarketEdgeApiError && error.code === 'RATE_LIMITED' && error.httpStatus === 429);
  await assert.rejects(() => scanMarkets({ requestId: 'test', fetchImpl: async () => new Response('not-json', { status: 200 }) }), error => error.code === 'RESPONSE_INVALID');
  await assert.rejects(() => scanMarkets({ requestId: 'test', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), error => error.code === 'NETWORK_ERROR');
  await assert.rejects(() => scanMarkets({ requestId: 'test', fetchImpl: async () => new Response(JSON.stringify({ status: 'UNKNOWN' }), { status: 200 }) }), error => error.code === 'RESPONSE_INVALID');
});

test('times out without retaining or inventing a recommendation', async () => {
  const pendingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  await assert.rejects(
    () => scanMarkets({ requestId: 'timeout-test', timeoutMs: 1, fetchImpl: pendingFetch }),
    error => error instanceof MarketEdgeApiError && error.code === 'TIMEOUT'
  );
});
