// Open-position monitor: the fast loop that manages positions that are
// already open. It is separate from, and never replaces, the ~5 minute
// DISCOVERY loop (forward_loop.mjs), which alone scans, ranks and opens trades.
//
// Price path (preferred -> fallback):
//   1. Hyperliquid websocket `trades` stream for each open position's coin.
//      Every exchange trade print is checked against that position's active
//      stop / TP1 / TP2; a print that crosses one is posted to /paper/tick at
//      once (trigger WS_TRADE), so a crossing is caught by a real print, not
//      by whatever a later poll happens to sample.
//   2. A ~10s heartbeat: ONE allMids request for all open positions (batched),
//      posted per position as a POLL_HEARTBEAT tick, together with the highest
//      and lowest real prints seen on the stream since the last heartbeat
//      (those only widen MFE/MAE; they never fire a trigger on their own).
//   3. The discovery loop's 5m completed-candle sweep (/paper/mark) remains the
//      last backstop: a crossing missed by both of the above (e.g. the stream
//      was down between two polls) is still inside a real candle high/low.
// If the stream is unavailable the monitor runs poll-only and says so
// (mode POLL_ONLY). A poll only sees the sampled mid: nothing here invents a
// path between two observations.
//
// Scope: GET /paper/open, POST /paper/tick, POST /paper/monitor/heartbeat.
// It never runs the scan, never calls /paper/signal, and never opens a trade.
// It runs only while >=1 position is open; with none it goes IDLE (no timer,
// no stream) until the discovery loop wakes it.
//
// Rate limits (#14): the heartbeat's allMids read is the highest priority
// (P0) in the shared request budget (rate_limit.mjs), so discovery / shadow
// traffic can never starve it. The trade stream is a websocket and does not
// spend the REST budget at all. After a rate-limited heartbeat the next one
// is spaced out (bounded, 2x the interval up to 30s) instead of hammering the
// limit -- positions are flagged MARKET_DATA_OFFLINE meanwhile, exactly as
// before, and the stream keeps checking every real print against the levels.
import { fetchAllMids, MARKET_PRICE_SOURCE } from './market_data.mjs';
import { isRateLimitError, sharedBudget } from './rate_limit.mjs';

export const DEFAULT_MONITOR_INTERVAL_MS = 10_000;
// Internal safety bounds: nobody can configure millisecond polling of a
// public API, nor a monitor so slow it stops being one.
export const MIN_MONITOR_INTERVAL_MS = 5_000;
export const MAX_MONITOR_INTERVAL_MS = 60_000;
export const RATE_LIMITED_MAX_INTERVAL_MS = 30_000;
export const WS_TRADE_SOURCE = 'HYPERLIQUID_WS_TRADES';
export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const WS_PING_MS = 30_000; // Hyperliquid drops a connection idle for 60s

export function monitorIntervalMs(raw) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return DEFAULT_MONITOR_INTERVAL_MS;
  return Math.min(MAX_MONITOR_INTERVAL_MS, Math.max(MIN_MONITOR_INTERVAL_MS, Math.round(n)));
}

/** Would this price fire a position-management trigger for this trade? */
export function crossesTrigger(trade, price) {
  if (!Number.isFinite(price) || price <= 0) return false;
  const long = trade.direction === 'long';
  const activeStop = trade.tp1_hit ? trade.entry_fill : trade.stop;
  const reached = (level) => level !== null && level !== undefined && (long ? price >= level : price <= level);
  if (long ? price <= activeStop : price >= activeStop) return true;
  if (!trade.tp1_hit && reached(trade.tp1)) return true;
  return Boolean(trade.tp1_hit && reached(trade.tp2));
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

export class HyperliquidTradeStream {
  constructor({ WebSocketImpl = globalThis.WebSocket, url = HYPERLIQUID_WS_URL, onTrade = () => {}, onState = () => {}, timers = defaultTimers, pingMs = WS_PING_MS } = {}) {
    Object.assign(this, { WebSocketImpl, url, onTrade, onState, timers, pingMs });
    this.state = WebSocketImpl ? 'IDLE' : 'UNAVAILABLE';
    this.desired = new Set();
    this.subscribed = new Set();
    this.ws = null;
    this.attempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state, detail);
  }

  send(msg) {
    try { this.ws?.send(JSON.stringify(msg)); } catch { /* close handler reconnects */ }
  }

  setCoins(coins) {
    this.desired = new Set(coins);
    if (!this.WebSocketImpl) return;
    if (!this.desired.size) { this.close(); return; }
    if (!this.ws) { if (!this.reconnectTimer) this.connect(); return; }
    if (this.state !== 'CONNECTED') return; // onopen subscribes to whatever is desired then
    for (const coin of this.desired) if (!this.subscribed.has(coin)) { this.send({ method: 'subscribe', subscription: { type: 'trades', coin } }); this.subscribed.add(coin); }
    for (const coin of [...this.subscribed]) if (!this.desired.has(coin)) { this.send({ method: 'unsubscribe', subscription: { type: 'trades', coin } }); this.subscribed.delete(coin); }
  }

  connect() {
    this.reconnectTimer = null;
    if (!this.desired.size) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.setState('DISCONNECTED', error.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.setState('CONNECTING');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.subscribed.clear();
      this.setState('CONNECTED');
      this.setCoins([...this.desired]);
      this.pingTimer = this.timers.setInterval(() => this.send({ method: 'ping' }), this.pingMs);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (msg?.channel !== 'trades' || !Array.isArray(msg.data)) return;
      for (const t of msg.data) {
        const px = Number(t?.px);
        const time = Number(t?.time);
        if (t?.coin && Number.isFinite(px) && px > 0 && Number.isFinite(time)) this.onTrade(t.coin, px, time);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.subscribed.clear();
      if (this.pingTimer) { this.timers.clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.desired.size) {
        this.setState('DISCONNECTED');
        this.scheduleReconnect();
      } else {
        this.setState('IDLE');
      }
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.desired.size) return;
    const wait = RECONNECT_BACKOFF_MS[Math.min(this.attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.attempts += 1;
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), wait);
  }

  close() {
    this.desired.clear();
    if (this.reconnectTimer) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { this.timers.clearInterval(this.pingTimer); this.pingTimer = null; }
    const ws = this.ws;
    this.ws = null;
    this.subscribed.clear();
    try { ws?.close(); } catch { /* already closed */ }
    if (this.WebSocketImpl) this.setState('IDLE');
  }
}

export class PositionMonitor {
  constructor({ api, fetchMids = fetchAllMids, intervalMs = DEFAULT_MONITOR_INTERVAL_MS, timers = defaultTimers, stream, WebSocketImpl, budget } = {}) {
    if (typeof api !== 'function') throw new Error('PositionMonitor needs the execution-service api');
    this.api = api;
    this.fetchMids = fetchMids;
    this.intervalMs = monitorIntervalMs(intervalMs);
    this.timers = timers;
    this.state = 'STOPPED';
    this.open = new Map();        // trade_id -> /paper/open row
    this.extremes = new Map();    // trade_id -> { high, low } of stream prints since the last heartbeat
    this.inflight = new Set();    // trade_ids with a WS_TRADE tick being posted
    this.lastForwardAt = new Map(); // trade_id -> local ms of the last WS_TRADE post (throttle)
    this.timer = null;
    this.running = null;
    this.again = false;
    this.stats = { heartbeats: 0, poll_ticks: 0, ws_ticks: 0, exits: 0, offline_heartbeats: 0, errors: 0, rate_limited_heartbeats: 0 };
    // Only the real network path reports budget health; injected test fetchers don't.
    this.budget = budget !== undefined ? budget : (fetchMids === fetchAllMids ? sharedBudget() : null);
    this.rateLimitedStreak = 0;
    this.stream = stream !== undefined ? stream : new HyperliquidTradeStream({
      WebSocketImpl: WebSocketImpl === undefined ? globalThis.WebSocket : WebSocketImpl,
      timers,
      onTrade: (coin, price, at) => this.onTrade(coin, price, at),
      onState: (state, detail) => log('POSITION_MONITOR_STREAM', { state, detail }),
    });
  }

  get mode() {
    return this.stream?.state === 'CONNECTED' ? 'WEBSOCKET+POLL' : 'POLL_ONLY';
  }

  setState(state, fields = {}) {
    if (this.state === state) return;
    this.state = state;
    log('POSITION_MONITOR_STATE', { state, interval_ms: this.intervalMs, ...fields });
  }

  start() {
    if (this.state !== 'STOPPED') return this.running;
    this.setState('IDLE');
    return this.wake();
  }

  stop() {
    this.setState('STOPPED');
    if (this.timer) { this.timers.clearTimeout(this.timer); this.timer = null; }
    this.stream?.close();
    this.open.clear();
  }

  /** Re-check open positions now (the discovery loop calls this after each
   *  cycle, since that is the only place a position can open). */
  wake() {
    if (this.state === 'STOPPED') return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    if (this.timer) { this.timers.clearTimeout(this.timer); this.timer = null; }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.beat();
        } while (this.again && this.state !== 'STOPPED');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Next heartbeat delay: the configured interval, spaced out (bounded)
   *  while allMids is being rate limited. */
  nextDelayMs() {
    if (!this.rateLimitedStreak) return this.intervalMs;
    return Math.min(Math.max(this.intervalMs, RATE_LIMITED_MAX_INTERVAL_MS), this.intervalMs * 2 ** Math.min(this.rateLimitedStreak, 4));
  }

  schedule() {
    if (this.state !== 'ACTIVE') return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => { this.timer = null; return this.wake(); }, this.nextDelayMs());
  }

  async refreshOpen() {
    const trades = (await this.api('GET', '/paper/open')).body?.trades || [];
    this.open = new Map(trades.map((t) => [t.trade_id, t]));
    for (const id of [...this.extremes.keys()]) if (!this.open.has(id)) this.extremes.delete(id);
    return trades;
  }

  async beat() {
    let trades;
    try {
      trades = await this.refreshOpen();
    } catch (error) {
      // Can't see the ledger: keep trying on the heartbeat, never guess.
      this.stats.errors += 1;
      log('POSITION_MONITOR_ERROR', { error: error.message });
      if (this.state === 'ACTIVE') this.schedule();
      return;
    }
    if (this.state === 'STOPPED') return; // stopped while reading: do not re-arm
    if (!trades.length) {
      this.stream?.setCoins([]);
      this.setState('IDLE');
      await this.api('POST', '/paper/monitor/heartbeat', { state: 'IDLE', interval_ms: this.intervalMs, at_ms: Date.now() }).catch(() => {});
      return;
    }
    this.setState('ACTIVE', { open_positions: trades.length });
    this.stream?.setCoins([...new Set(trades.map((t) => t.coin))]);
    this.stats.heartbeats += 1;
    let mids = null;
    let at = null;
    let error = null;
    try {
      ({ mids, at } = await this.fetchMids());
      this.rateLimitedStreak = 0;
    } catch (e) {
      error = `allMids: ${e.message}`;
      if (isRateLimitError(e)) {
        this.rateLimitedStreak += 1;
        this.stats.rate_limited_heartbeats += 1;
      } else {
        this.rateLimitedStreak = 0;
      }
    }
    if (this.state === 'STOPPED') return;
    const offline = [];
    for (const trade of trades) {
      const price = Number(mids?.[trade.coin]);
      if (error || !Number.isFinite(price) || price <= 0) {
        offline.push(trade.instrument);
        continue;
      }
      const ext = this.extremes.get(trade.trade_id);
      this.extremes.delete(trade.trade_id);
      try {
        const res = await this.api('POST', '/paper/tick', {
          instrument: trade.instrument, price, at_ms: at, source: MARKET_PRICE_SOURCE, trigger: 'POLL_HEARTBEAT',
          observed_high: ext?.high ?? null, observed_low: ext?.low ?? null,
        });
        this.stats.poll_ticks += 1;
        this.noteExits(trade, res.body);
      } catch (e) {
        this.stats.errors += 1;
        log('POSITION_MONITOR_ERROR', { instrument: trade.instrument, error: e.message });
      }
    }
    if (offline.length) {
      this.stats.offline_heartbeats += 1;
      log('POSITION_MONITOR_OFFLINE', { instruments: offline, error: error || 'no live mid for coin' });
    }
    await this.api('POST', '/paper/monitor/heartbeat', {
      state: 'ACTIVE', mode: this.mode, ws_state: this.stream?.state ?? 'UNAVAILABLE', interval_ms: this.intervalMs,
      market_ok: offline.length === 0, error: offline.length ? (error || `no live mid for ${offline.join(', ')}`) : null,
      offline_instruments: offline, open_positions: trades.length, at_ms: Date.now(),
      rate_limited: this.rateLimitedStreak > 0, next_heartbeat_ms: this.nextDelayMs(),
      ...(this.budget ? { rate_limit: this.budget.health() } : {}),
    }).catch(() => {});
    this.schedule();
  }

  noteExits(trade, body) {
    const exits = body?.exits || [];
    if (!exits.length) return;
    this.stats.exits += exits.length;
    log('POSITION_MONITOR_EXIT', { instrument: trade.instrument, exits: exits.map((e) => e.kind), trigger: exits[0]?.trigger });
    this.again = true; // re-read positions (tp1_hit / closed) before the next evaluation
  }

  onTrade(coin, price, at) {
    for (const trade of this.open.values()) {
      if (trade.coin !== coin || at < trade.opened_at_ms) continue;
      const ext = this.extremes.get(trade.trade_id) || { high: price, low: price };
      ext.high = Math.max(ext.high, price);
      ext.low = Math.min(ext.low, price);
      this.extremes.set(trade.trade_id, ext);
      if (!crossesTrigger(trade, price) || this.inflight.has(trade.trade_id)) continue;
      // At most one crossing post per position per second: a burst of prints
      // through a level is one event, not hundreds of local requests.
      if (Date.now() - (this.lastForwardAt.get(trade.trade_id) || 0) < 1000) continue;
      this.lastForwardAt.set(trade.trade_id, Date.now());
      void this.forward(trade, price, at);
    }
  }

  async forward(trade, price, at) {
    this.inflight.add(trade.trade_id);
    try {
      const res = await this.api('POST', '/paper/tick', {
        instrument: trade.instrument, price, at_ms: at, source: WS_TRADE_SOURCE, trigger: 'WS_TRADE',
      });
      this.stats.ws_ticks += 1;
      if ((res.body?.exits || []).length) {
        this.noteExits(trade, res.body);
        await this.wake();
      }
    } catch (e) {
      this.stats.errors += 1;
      log('POSITION_MONITOR_ERROR', { instrument: trade.instrument, error: e.message, trigger: 'WS_TRADE' });
    } finally {
      this.inflight.delete(trade.trade_id);
    }
  }
}
