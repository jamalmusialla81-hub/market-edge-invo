import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crossesTrigger, DEFAULT_MONITOR_INTERVAL_MS, HyperliquidTradeStream, MAX_MONITOR_INTERVAL_MS, MIN_MONITOR_INTERVAL_MS,
  monitorIntervalMs, PositionMonitor, WS_TRADE_SOURCE,
} from './position_monitor.mjs';
import { DEFAULT_CYCLE_INTERVAL_MS, requestStop, runLoop, stopControl } from './forward_loop.mjs';
import { MARKET_PRICE_SOURCE } from './market_data.mjs';

const LONG = { trade_id: 'T1', instrument: 'ETH-PERP', coin: 'ETH', direction: 'long', entry_fill: 100, stop: 90, tp1: 110, tp2: 120, tp1_hit: false, opened_at_ms: 0 };

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimeout: (h) => { pending.delete(h); },
    setInterval: (fn, ms) => { id += 1; pending.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearInterval: (h) => { pending.delete(h); },
    timeouts: () => [...pending.values()].filter((t) => t.kind === 'timeout'),
    async fire(ms) {
      for (const [h, t] of [...pending]) if (t.kind === 'timeout' && t.ms === ms) { pending.delete(h); await t.fn(); }
    },
  };
}

// A fake execution-service: records every call; /paper/open returns `state.open`.
function fakeApi(state) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/paper/open') return { status: 200, body: { trades: state.open } };
    if (path === '/paper/tick') return { status: 200, body: state.onTick ? state.onTick(body) : { exits: [] } };
    return { status: 200, body: {} };
  };
  return { api, calls };
}

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWS.instances.push(this); }
  send(msg) { this.sent.push(JSON.parse(msg)); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  trades(coin, rows) { this.onmessage?.({ data: JSON.stringify({ channel: 'trades', data: rows.map(([px, time]) => ({ coin, px: String(px), time, sz: '1' })) }) }); }
  drop() { this.onclose?.(); }
}

test('interval: default 10s, and a safe minimum/maximum is enforced', () => {
  assert.equal(DEFAULT_MONITOR_INTERVAL_MS, 10_000);
  assert.equal(monitorIntervalMs(undefined), 10_000);
  assert.equal(monitorIntervalMs('junk'), 10_000);
  assert.equal(monitorIntervalMs(1), MIN_MONITOR_INTERVAL_MS); // no millisecond polling of a public API
  assert.equal(monitorIntervalMs(10 * 60_000), MAX_MONITOR_INTERVAL_MS);
  assert.equal(new PositionMonitor({ api: async () => ({}), intervalMs: 5, stream: null }).intervalMs, MIN_MONITOR_INTERVAL_MS);
});

test('discovery cadence is unchanged at 5 minutes and is separate from the monitor', async () => {
  assert.equal(DEFAULT_CYCLE_INTERVAL_MS, 300_000);
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  globalThis.fetch = async (url) => ({ status: 200, json: async () => (new URL(url).pathname === '/paper/open' ? { trades: [] } : {}) });
  const sleeps = [];
  let started = 0, stopped = 0, wakes = 0;
  const monitor = { start: () => { started += 1; }, stop: () => { stopped += 1; }, wake: () => { wakes += 1; } };
  let scans = 0;
  await runLoop({
    maxCycles: 3, intervalMs: DEFAULT_CYCLE_INTERVAL_MS, monitor,
    sleep: async (ms) => { sleeps.push(ms); },
    deps: { scan: async () => { scans += 1; return { signal: null, reason: 'NO_VALID_CANDIDATE' }; } },
  });
  assert.equal(scans, 3);
  assert.deepEqual(sleeps, [300_000, 300_000]);
  assert.equal(started, 1);
  assert.equal(wakes, 3); // discovery wakes the monitor after each cycle
  assert.equal(stopped, 1);
  stopControl.requested = false;
});

test('fast loop sleeps with no positions, starts when the first opens, stops when the last closes', async () => {
  const state = { open: [] };
  const { api, calls } = fakeApi(state);
  const timers = fakeTimers();
  const monitor = new PositionMonitor({ api, timers, stream: null, fetchMids: async () => ({ mids: { ETH: '104' }, at: 1000 }) });
  await monitor.start();
  assert.equal(monitor.state, 'IDLE');
  assert.equal(timers.timeouts().length, 0, 'idle: nothing scheduled');
  assert.ok(!calls.some((c) => c.path === '/paper/tick'));

  state.open = [LONG];                     // discovery opened one
  await monitor.wake();
  assert.equal(monitor.state, 'ACTIVE');
  assert.deepEqual(timers.timeouts().map((t) => t.ms), [10_000]);
  await timers.fire(10_000);               // the next heartbeat
  assert.equal(calls.filter((c) => c.path === '/paper/tick').length, 2);

  state.open = [];                         // last position closed
  await timers.fire(10_000);
  assert.equal(monitor.state, 'IDLE');
  assert.equal(timers.timeouts().length, 0);
  assert.ok(calls.some((c) => c.path === '/paper/monitor/heartbeat' && c.body.state === 'IDLE'));
  monitor.stop();
});

test('fast loop never scans or opens trades: only open/tick/heartbeat calls', async () => {
  const state = { open: [LONG, { ...LONG, trade_id: 'T2', instrument: 'BTC-PERP', coin: 'BTC' }] };
  const { api, calls } = fakeApi(state);
  let midCalls = 0;
  const monitor = new PositionMonitor({ api, timers: fakeTimers(), stream: null, fetchMids: async () => { midCalls += 1; return { mids: { ETH: '101', BTC: '60000' }, at: 5 }; } });
  await monitor.start();
  assert.equal(midCalls, 1, 'one batched allMids read for all open positions');
  assert.deepEqual([...new Set(calls.map((c) => c.path))].sort(), ['/paper/monitor/heartbeat', '/paper/open', '/paper/tick']);
  const ticks = calls.filter((c) => c.path === '/paper/tick').map((c) => c.body);
  assert.deepEqual(ticks.map((t) => [t.instrument, t.price, t.at_ms, t.source, t.trigger]),
    [['ETH-PERP', 101, 5, MARKET_PRICE_SOURCE, 'POLL_HEARTBEAT'], ['BTC-PERP', 60000, 5, MARKET_PRICE_SOURCE, 'POLL_HEARTBEAT']]);
  monitor.stop();
});

test('market data failure fails closed: no tick, positions flagged MARKET_DATA_OFFLINE, retried next heartbeat', async () => {
  const state = { open: [LONG] };
  const { api, calls } = fakeApi(state);
  const timers = fakeTimers();
  const monitor = new PositionMonitor({ api, timers, stream: null, fetchMids: async () => { throw new Error('HTTP 503'); } });
  await monitor.start();
  assert.ok(!calls.some((c) => c.path === '/paper/tick'), 'no invented or cached price is posted');
  const hb = calls.find((c) => c.path === '/paper/monitor/heartbeat').body;
  assert.equal(hb.market_ok, false);
  assert.deepEqual(hb.offline_instruments, ['ETH-PERP']);
  assert.match(hb.error, /503/);
  assert.equal(monitor.state, 'ACTIVE');
  assert.deepEqual(timers.timeouts().map((t) => t.ms), [10_000]);
  monitor.stop();
});

test('a coin missing from allMids is offline for that position only', async () => {
  const state = { open: [LONG, { ...LONG, trade_id: 'T2', instrument: 'XYZ-PERP', coin: 'XYZ' }] };
  const { api, calls } = fakeApi(state);
  const monitor = new PositionMonitor({ api, timers: fakeTimers(), stream: null, fetchMids: async () => ({ mids: { ETH: '101' }, at: 5 }) });
  await monitor.start();
  assert.deepEqual(calls.filter((c) => c.path === '/paper/tick').map((c) => c.body.instrument), ['ETH-PERP']);
  assert.deepEqual(calls.find((c) => c.path === '/paper/monitor/heartbeat').body.offline_instruments, ['XYZ-PERP']);
  monitor.stop();
});

test('crossesTrigger: stop, TP1, TP2 after TP1, breakeven after TP1, both directions', () => {
  assert.equal(crossesTrigger(LONG, 105), false);
  assert.equal(crossesTrigger(LONG, 90), true);
  assert.equal(crossesTrigger(LONG, 110), true);
  assert.equal(crossesTrigger({ ...LONG, tp1_hit: true }, 115), false);
  assert.equal(crossesTrigger({ ...LONG, tp1_hit: true }, 120), true);
  assert.equal(crossesTrigger({ ...LONG, tp1_hit: true }, 99.9), true); // breakeven
  const SHORT = { ...LONG, direction: 'short', stop: 110, tp1: 90, tp2: 80 };
  assert.equal(crossesTrigger(SHORT, 95), false);
  assert.equal(crossesTrigger(SHORT, 110), true);
  assert.equal(crossesTrigger(SHORT, 89), true);
  assert.equal(crossesTrigger(SHORT, NaN), false);
});

test('websocket prints: a crossing is posted immediately; others only feed MFE/MAE extremes on the heartbeat', async () => {
  FakeWS.instances = [];
  const state = { open: [LONG] };
  const { api, calls } = fakeApi(state);
  const timers = fakeTimers();
  state.onTick = (body) => (body.trigger === 'WS_TRADE' ? { exits: [{ kind: 'TP1', trigger: 'WS_TRADE' }] } : { exits: [] });
  const monitor = new PositionMonitor({ api, timers, WebSocketImpl: FakeWS, fetchMids: async () => ({ mids: { ETH: '104' }, at: 50 }) });
  await monitor.start();
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, 'wss://api.hyperliquid.xyz/ws');
  ws.open();
  assert.deepEqual(ws.sent, [{ method: 'subscribe', subscription: { type: 'trades', coin: 'ETH' } }]);
  assert.equal(monitor.mode, 'WEBSOCKET+POLL');

  ws.trades('ETH', [[103, 10], [107.5, 11], [96, 12]]);  // no crossing
  assert.equal(calls.filter((c) => c.path === '/paper/tick').length, 1); // only the first heartbeat's
  ws.trades('ETH', [[110.2, 13]]);                          // TP1 crossing
  await new Promise((r) => setImmediate(r));
  const wsTick = calls.find((c) => c.path === '/paper/tick' && c.body.trigger === 'WS_TRADE').body;
  assert.deepEqual([wsTick.price, wsTick.at_ms, wsTick.source], [110.2, 13, WS_TRADE_SOURCE]);
  assert.equal(monitor.stats.exits, 1);
  // after an exit the monitor re-reads positions at once; that heartbeat
  // carries the stream's extremes since the previous one
  const wsIndex = calls.findIndex((c) => c.body?.trigger === 'WS_TRADE');
  const beat = calls.slice(wsIndex).find((c) => c.path === '/paper/tick' && c.body.trigger === 'POLL_HEARTBEAT').body;
  assert.equal(beat.observed_high, 110.2);
  assert.equal(beat.observed_low, 96);
  await timers.fire(10_000);
  const next = calls.filter((c) => c.path === '/paper/tick' && c.body.trigger === 'POLL_HEARTBEAT').at(-1).body;
  assert.equal(next.observed_high, null, 'extremes are flushed once, not re-posted');
  const hb = calls.filter((c) => c.path === '/paper/monitor/heartbeat').at(-1).body;
  assert.equal(hb.ws_state, 'CONNECTED');
  monitor.stop();
  assert.equal(ws.closed, true);
});

test('websocket prints from before entry are ignored', async () => {
  FakeWS.instances = [];
  const state = { open: [{ ...LONG, opened_at_ms: 1000 }] };
  const { api, calls } = fakeApi(state);
  const monitor = new PositionMonitor({ api, timers: fakeTimers(), WebSocketImpl: FakeWS, fetchMids: async () => ({ mids: { ETH: '104' }, at: 2000 }) });
  await monitor.start();
  FakeWS.instances[0].open();
  FakeWS.instances[0].trades('ETH', [[80, 999]]);
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls.some((c) => c.body?.trigger === 'WS_TRADE'));
  monitor.stop();
});

test('stream reconnects with backoff while positions are open, and is released when none are', () => {
  FakeWS.instances = [];
  const timers = fakeTimers();
  const states = [];
  const stream = new HyperliquidTradeStream({ WebSocketImpl: FakeWS, timers, onState: (s) => states.push(s) });
  stream.setCoins(['ETH']);
  FakeWS.instances[0].open();
  FakeWS.instances[0].drop();
  assert.equal(stream.state, 'DISCONNECTED');
  assert.deepEqual(timers.timeouts().map((t) => t.ms), [1000]);
  [...timers.pending.values()].find((t) => t.kind === 'timeout').fn();
  assert.equal(FakeWS.instances.length, 2);
  FakeWS.instances[1].open();
  assert.deepEqual(FakeWS.instances[1].sent[0], { method: 'subscribe', subscription: { type: 'trades', coin: 'ETH' } });
  stream.setCoins([]);
  assert.equal(stream.state, 'IDLE');
  assert.equal(FakeWS.instances[1].closed, true);
  assert.ok(states.includes('CONNECTED') && states.includes('DISCONNECTED'));
});

test('no WebSocket available: poll-only mode is reported, heartbeat still runs', async () => {
  const state = { open: [LONG] };
  const { api, calls } = fakeApi(state);
  const monitor = new PositionMonitor({ api, timers: fakeTimers(), WebSocketImpl: null, fetchMids: async () => ({ mids: { ETH: '101' }, at: 5 }) });
  await monitor.start();
  assert.equal(monitor.mode, 'POLL_ONLY');
  const hb = calls.find((c) => c.path === '/paper/monitor/heartbeat').body;
  assert.equal(hb.mode, 'POLL_ONLY');
  assert.equal(hb.ws_state, 'UNAVAILABLE');
  monitor.stop();
});

test('restart: a new monitor picks up persisted open positions on its first look', async () => {
  const state = { open: [LONG] };
  const { api, calls } = fakeApi(state);
  const monitor = new PositionMonitor({ api, timers: fakeTimers(), stream: null, fetchMids: async () => ({ mids: { ETH: '101' }, at: 5 }) });
  await monitor.start();
  assert.equal(monitor.state, 'ACTIVE');
  assert.equal(calls[0].path, '/paper/open');
  monitor.stop();
});

test('an unreachable execution-service does not crash the monitor', async () => {
  const timers = fakeTimers();
  const api = async () => { throw new Error('execution-service GET /paper/open -> HTTP 503'); };
  const monitor = new PositionMonitor({ api, timers, stream: null });
  await monitor.start();
  assert.equal(monitor.stats.errors, 1);
  monitor.stop();
  assert.equal(monitor.state, 'STOPPED');
});

test('runLoop stops the monitor when the loop is asked to stop', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  globalThis.fetch = async (url) => ({ status: 200, json: async () => (new URL(url).pathname === '/paper/open' ? { trades: [] } : {}) });
  let stopped = false;
  await runLoop({
    maxCycles: 5, intervalMs: 1, monitor: { start() {}, wake() {}, stop() { stopped = true; } },
    sleep: async () => { requestStop('TEST'); },
    deps: { scan: async () => ({ signal: null, reason: 'NO_VALID_CANDIDATE' }) },
  });
  assert.equal(stopped, true);
  stopControl.requested = false;
});

test('stop() during an in-flight heartbeat does not re-arm the timer or reopen the stream', async () => {
  const timers = fakeTimers();
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = async (method, path) => {
    if (path === '/paper/open') { await gate; return { body: { trades: [LONG] } }; }
    return { body: {} };
  };
  const monitor = new PositionMonitor({ api, timers, stream: null, fetchMids: async () => ({ mids: { ETH: '101' }, at: 5 }) });
  const running = monitor.start();
  monitor.stop();
  release();
  await running;
  assert.equal(monitor.state, 'STOPPED');
  assert.equal(timers.timeouts().length, 0);
});
