// MAJOR 1 (#14): shared Hyperliquid request budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs, budgetFor, dedupKey, HYPERLIQUID_INFO_URL, isRateLimitError, parseRetryAfter, PRIORITY, RateLimitedError,
  requestWeight, RequestBudget, sharedBudget,
} from './rate_limit.mjs';
import { fetchAllMids, fetchCompletedCandles, fetchMid } from './market_data.mjs';
import { PositionMonitor, RATE_LIMITED_MAX_INTERVAL_MS } from './position_monitor.mjs';

const URL = HYPERLIQUID_INFO_URL;
const body = (b) => ({ method: 'POST', body: JSON.stringify(b) });
const MIDS = { type: 'allMids' };

// A controllable clock + timers: nothing here sleeps for real.
function fakeClock(start = 1_000_000) {
  let now = start;
  const pending = [];
  let id = 0;
  const timers = {
    setTimeout: (fn, ms) => { id += 1; pending.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: (h) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1); },
  };
  return {
    now: () => now,
    timers,
    pending,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > target) break;
        pending.shift();
        now = next.at;
        next.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const okRes = (data, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => data });
const res429 = (retryAfter = null) => ({ ok: false, status: 429, headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) }, json: async () => ({}) });

test('backoff escalates exponentially, is capped, and is jittered (distribution, not one value)', () => {
  const samples = (attempt) => Array.from({ length: 400 }, () => backoffMs(attempt));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const a1 = samples(1); const a3 = samples(3); const a10 = samples(10);
  assert.ok(a1.every((v) => v >= 1000 && v <= 2000), 'attempt 1 within [base/2, base]');
  assert.ok(a3.every((v) => v >= 4000 && v <= 8000), 'attempt 3 within [4s, 8s]');
  assert.ok(a10.every((v) => v >= 30_000 && v <= 60_000), 'capped at 60s');
  assert.ok(mean(a3) > mean(a1) * 3, 'escalates');
  assert.ok(new Set(a3).size > 50, 'jitter spreads retries (many distinct values)');
  const sd = Math.sqrt(mean(a3.map((v) => (v - mean(a3)) ** 2)));
  assert.ok(sd > 500, `jitter has real spread (sd ${sd.toFixed(0)}ms)`);
});

test('Retry-After is parsed as seconds or an HTTP date; absent -> null', () => {
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
});

test('request weights follow Hyperliquid (allMids light, candles scale with bars)', () => {
  assert.equal(requestWeight(MIDS), 2);
  assert.equal(requestWeight({ type: 'metaAndAssetCtxs' }), 20);
  const req = { coin: 'BTC', interval: '5m', startTime: 0, endTime: 500 * 300_000 };
  assert.equal(requestWeight({ type: 'candleSnapshot', req }), 20 + Math.ceil(500 / 60));
  assert.equal(dedupKey(URL, '{"b":1,"a":2}'), dedupKey(URL, '{"a":2,"b":1}'), 'key ignores key order');
  assert.notEqual(dedupKey(URL, JSON.stringify({ type: 'l2Book', coin: 'BTC' })), dedupKey(URL, JSON.stringify({ type: 'l2Book', coin: 'ETH' })));
});

test('concurrent identical requests are deduplicated to one HTTP call; each caller gets its own copy', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const budget = new RequestBudget({ fetchImpl: async () => { calls += 1; await gate; return okRes({ BTC: '1' }); } });
  const reqs = [1, 2, 3].map(() => budget.fetch(URL, body(MIDS), { priority: PRIORITY.P0_POSITION_MONITOR }));
  release();
  const out = await Promise.all(reqs.map(async (r) => (await r).json()));
  assert.equal(calls, 1);
  assert.deepEqual(out, [{ BTC: '1' }, { BTC: '1' }, { BTC: '1' }]);
  out[0].BTC = 'mutated';
  assert.equal(out[1].BTC, '1', 'callers never share one mutable object');
  assert.equal(budget.health().endpoints.allMids.deduplicated, 2);
  // Completed requests are NOT served again (no response cache): a new call is a new request.
  await (await budget.fetch(URL, body(MIDS), { priority: 0 })).json();
  assert.equal(calls, 2, 'a price is never re-served after its request completed');
});

test('429 starts a cooldown; Retry-After is honoured; discovery waits it out, research is deferred', async () => {
  const clock = fakeClock();
  const seen = [];
  let limited = true;
  const budget = new RequestBudget({ now: clock.now, timers: clock.timers, random: () => 0.5,
    fetchImpl: async (url, init) => { seen.push({ at: clock.now(), type: JSON.parse(init.body).type }); return limited ? res429('20') : okRes({}); } });
  const first = await budget.fetch(URL, body({ type: 'metaAndAssetCtxs' }), { priority: PRIORITY.P2_DISCOVERY });
  assert.equal(first.status, 429);
  const h = budget.health();
  assert.equal(h.state, 'BACKOFF');
  assert.equal(h.cooldown_until_ms, clock.now() + 20_000, 'Retry-After 20s honoured');
  assert.equal(h.endpoints.metaAndAssetCtxs.retry_after_seen, 1);
  // Research (P3/P4/P5) does not queue behind a cooldown: deferred at once.
  for (const p of [PRIORITY.P3_SHADOW_CAPTURE, PRIORITY.P4_SHADOW_RESOLUTION, PRIORITY.P5_CHART_HISTORY]) {
    await assert.rejects(budget.fetch(URL, body({ type: 'candleSnapshot', req: { coin: `C${p}` } }), { priority: p }), (e) => e instanceof RateLimitedError && isRateLimitError(e));
  }
  // Discovery waits for the cooldown (no request during it), then goes.
  limited = false;
  const pending = budget.fetch(URL, body({ type: 'metaAndAssetCtxs', n: 2 }), { priority: PRIORITY.P2_DISCOVERY });
  await clock.advance(19_000);
  assert.equal(seen.length, 1, 'nothing sent during the cooldown');
  await clock.advance(1_500);
  assert.equal((await pending).status, 200);
  assert.equal(seen.length, 2);
  assert.ok(seen[1].at >= seen[0].at + 20_000);
  // Research keeps yielding for a full 60s window after the last 429, then resumes.
  await assert.rejects(budget.fetch(URL, body({ type: 'candleSnapshot', req: { coin: 'R' } }), { priority: PRIORITY.P4_SHADOW_RESOLUTION }), /RECENT_429/);
  await clock.advance(40_000);
  assert.equal((await budget.fetch(URL, body({ type: 'candleSnapshot', req: { coin: 'R' } }), { priority: PRIORITY.P4_SHADOW_RESOLUTION })).status, 200);
});

test('without Retry-After, repeated 429s escalate the cooldown and recovery resets it', async () => {
  const clock = fakeClock();
  let limited = true;
  const budget = new RequestBudget({ now: clock.now, timers: clock.timers, random: () => 1,
    fetchImpl: async () => (limited ? res429(null) : okRes({ BTC: '1' })) });
  const cooldowns = [];
  for (let i = 0; i < 4; i += 1) {
    await budget.fetch(URL, body(MIDS), { priority: PRIORITY.P0_POSITION_MONITOR });
    cooldowns.push(budget.health().cooldown_until_ms - clock.now());
  }
  assert.deepEqual(cooldowns, [2000, 4000, 8000, 16000], 'exponential (random=1 -> upper bound)');
  assert.equal(budget.health().consecutive_429, 4);
  limited = false;
  await clock.advance(20_000);
  const ok = await budget.fetch(URL, body(MIDS), { priority: PRIORITY.P0_POSITION_MONITOR });
  assert.equal(ok.status, 200);
  assert.equal(budget.health().consecutive_429, 0, 'backoff state resets after recovery');
  assert.equal(budget.health().state, 'RECOVERING');
  await clock.advance(61_000);
  assert.equal(budget.health().state, 'OK');
});

test('repeated 429 -> discovery gives up gracefully after its bounded wait (deferred, not an infinite loop)', async () => {
  const clock = fakeClock();
  let calls = 0;
  const budget = new RequestBudget({ now: clock.now, timers: clock.timers, random: () => 1, maxBackoffMs: 60_000,
    fetchImpl: async () => { calls += 1; return res429('120'); } });
  await budget.fetch(URL, body(MIDS), { priority: PRIORITY.P0_POSITION_MONITOR });
  // Cooldown 120s > discovery's 90s max wait: rejected immediately, no request sent.
  await assert.rejects(budget.fetch(URL, body({ type: 'metaAndAssetCtxs' }), { priority: PRIORITY.P2_DISCOVERY }), /RATE_LIMITED_DEFERRED/);
  assert.equal(calls, 1);
  assert.equal(budget.health().by_priority.P2_DISCOVERY.deferred, 1);
});

test('research traffic cannot starve the position monitor: P0 jumps every queued P3/P4/P5 request', async () => {
  const started = [];
  const releases = [];
  const budget = new RequestBudget({ maxConcurrent: 2, weightPerMinute: 100_000,
    fetchImpl: async (url, init) => { started.push(JSON.parse(init.body).tag); await new Promise((r) => releases.push(r)); return okRes({}); } });
  const low = [];
  for (let i = 0; i < 6; i += 1) {
    low.push(budget.fetch(URL, body({ type: 'candleSnapshot', tag: `low${i}` }), { priority: 3 + (i % 3), maxWaitMs: 60_000 }));
  }
  await flush();
  assert.deepEqual(started, ['low0', 'low1'], 'two slots busy with research');
  const p0 = budget.fetch(URL, body({ type: 'allMids', tag: 'P0' }), { priority: PRIORITY.P0_POSITION_MONITOR });
  releases.shift()();
  await flush();
  assert.equal(started[2], 'P0', 'the monitor read takes the first free slot, ahead of 4 queued research reads');
  while (releases.length) { releases.shift()(); await flush(); }
  await p0;
  await Promise.all(low);
});

test('a saturated weight budget defers research but never blocks P0/P1', async () => {
  const clock = fakeClock();
  let calls = 0;
  const budget = new RequestBudget({ now: clock.now, timers: clock.timers, weightPerMinute: 200,
    fetchImpl: async () => { calls += 1; return okRes({}); } });
  const candle = (coin) => body({ type: 'candleSnapshot', req: { coin, interval: '5m', startTime: 0, endTime: 500 * 300_000 } });
  // Research may not eat into the room kept for higher priorities.
  await assert.rejects(budget.fetch(URL, candle('A'), { priority: PRIORITY.P3_SHADOW_CAPTURE }), /WEIGHT_BUDGET/);
  for (let i = 0; i < 12; i += 1) await budget.fetch(URL, candle(`X${i}`), { priority: PRIORITY.P1_RECONCILIATION });
  assert.ok(budget.health().weight_used_last_60s > 200, 'P1 is never held back by the budget');
  const mids = await budget.fetch(URL, body(MIDS), { priority: PRIORITY.P0_POSITION_MONITOR });
  assert.equal(mids.status, 200, 'P0 still goes through a saturated budget');
  // Discovery waits for the window to roll over, then proceeds.
  const disc = budget.fetch(URL, candle('D'), { priority: PRIORITY.P2_DISCOVERY });
  await clock.advance(30_000);
  const before = calls;
  await clock.advance(31_000);
  assert.equal((await disc).status, 200);
  assert.equal(calls, before + 1);
});

test('non-Hyperliquid hosts pass straight through the budget', async () => {
  let calls = 0;
  const budget = new RequestBudget({ fetchImpl: async () => { calls += 1; return okRes([]); } });
  budget.cooldownUntil = Date.now() + 60_000;
  const f = budget.fetchImplFor(PRIORITY.P5_CHART_HISTORY);
  await f('https://api.binance.com/api/v3/klines?symbol=BTCUSDT', {});
  assert.equal(calls, 1);
  await assert.rejects(f(URL, body(MIDS)), /RATE_LIMITED_DEFERRED/);
});

test('stale data remains rejected: a rate-limited mid read fails closed, never returns an older price', async () => {
  const clock = fakeClock();
  let n = 0;
  const budget = new RequestBudget({ now: clock.now, timers: clock.timers,
    fetchImpl: async () => { n += 1; return n === 1 ? okRes({ ETH: '100' }) : res429('30'); } });
  const first = await fetchAllMids({ budget, now: clock.now });
  assert.equal(first.mids.ETH, '100');
  await clock.advance(10_000);
  await assert.rejects(fetchAllMids({ budget, now: clock.now }), /HTTP 429/, 'no cached 100 is served');
  // Discovery's mid waits out the cooldown, asks again, and still fails closed.
  const mid = assert.rejects(fetchMid('ETH', { budget, retries: 0, now: clock.now }), /429/);
  await clock.advance(31_000);
  await mid;
  await clock.advance(61_000);
  await assert.rejects(fetchCompletedCandles('ETH', 0, { budget, now: clock.now(), priority: PRIORITY.P4_SHADOW_RESOLUTION }), /429/);
});

test('position monitor: a rate-limited heartbeat flags positions offline and spaces the next one (bounded)', async () => {
  const timers = { handles: [], setTimeout(fn, ms) { this.handles.push(ms); return this.handles.length; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {} };
  const calls = [];
  const api = async (method, path, b) => {
    calls.push({ path, body: b });
    if (path === '/paper/open') return { status: 200, body: { trades: [{ trade_id: 'T', instrument: 'ETH-PERP', coin: 'ETH', direction: 'long', entry_fill: 1, stop: 0.9, tp1: 1.1, tp2: 1.2, opened_at_ms: 0 }] } };
    return { status: 200, body: {} };
  };
  let limited = true;
  const monitor = new PositionMonitor({ api, timers, stream: null, budget: null,
    fetchMids: async () => { if (limited) throw new RateLimitedError('P0 allMids'); return { mids: { ETH: '1.0' }, at: 1 }; } });
  monitor.state = 'IDLE';
  await monitor.beat();
  const hb = calls.filter((c) => c.path === '/paper/monitor/heartbeat').at(-1).body;
  assert.equal(hb.market_ok, false);
  assert.deepEqual(hb.offline_instruments, ['ETH-PERP']);
  assert.equal(hb.rate_limited, true);
  assert.ok(!calls.some((c) => c.path === '/paper/tick'), 'no price tick without a fresh price');
  assert.equal(timers.handles.at(-1), 20_000);
  await monitor.beat();
  await monitor.beat();
  assert.equal(timers.handles.at(-1), RATE_LIMITED_MAX_INTERVAL_MS, 'bounded at 30s');
  limited = false;
  await monitor.beat();
  assert.equal(timers.handles.at(-1), 10_000, 'normal cadence as soon as data is back');
  assert.ok(calls.some((c) => c.path === '/paper/tick'));
});

test('the real network path always uses the shared budget; injected fetchers are left alone', () => {
  assert.equal(budgetFor(globalThis.fetch, undefined), sharedBudget());
  assert.equal(budgetFor(async () => {}, undefined), null);
  const b = new RequestBudget();
  assert.equal(budgetFor(async () => {}, b), b);
  assert.equal(sharedBudget(), sharedBudget(), 'one budget per process');
});
