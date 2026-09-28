// Shared request budget for the public Hyperliquid info API (MAJOR 1, #14).
//
// Every Node-side caller that reads https://api.hyperliquid.xyz/info goes
// through ONE budget per process, so independently scheduled callers (the
// 10s open-position heartbeat, the 5-minute discovery scan, shadow capture,
// delayed shadow resolution) can no longer each retry into the same per-IP
// limit and turn a temporary 429 into a request storm.
//
// What it does:
//   - request WEIGHT accounting modelled on Hyperliquid's documented per-IP
//     limit (1200 weight/min; allMids = 2, most info requests = 20,
//     candleSnapshot = 20 + 1 per 60 candles), reported in diagnostics. A hard
//     pacing budget (`weightPerMinute`, HYPERLIQUID_WEIGHT_PER_MINUTE) is
//     OFF by default: by that model one production scan (~40 markets x 5
//     candle reads) is ~5,000 weight, yet CI shows it completing in under a
//     minute, so the model over-estimates and pacing on it would stretch
//     discovery past the 600s signal-freshness limit. Until CI evidence
//     calibrates it, the budget reacts to real 429s instead (below);
//   - PRIORITY, highest first: P0 open-position monitoring, P1 reconciliation
//     (the open-trade candle backstop), P2 discovery, P3 shadow capture, P4
//     delayed shadow resolution, P5 chart/history. P0/P1 never wait for the
//     budget or a cooldown and always start before anything queued below
//     them; P2 waits (bounded) out a cooldown; P3-P5 are skipped, not
//     queued, during a cooldown and for 60s after the last 429;
//   - after an HTTP 429 a cooldown with exponential backoff + jitter, or the
//     server's Retry-After when it sends one. P0/P1 keep their own cadence
//     through a cooldown (the monitor tries once per heartbeat, it never
//     loops); everything else waits it out or is deferred;
//   - in-flight de-duplication: identical concurrent requests (same URL +
//     body) share one HTTP request. Nothing is served after it completed:
//     there is NO response cache here, so a price is never reused;
//   - counters for diagnostics (health()).
//
// What it never does: invent, cache, interpolate or re-serve market data. A
// request the budget refuses fails with a RateLimitedError ("HTTP 429 ...
// RATE_LIMITED_DEFERRED"), which every caller already treats as "no data"
// (MARKET_DATA_OFFLINE / STALE / deferred), exactly as a real 429.

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

export const PRIORITY = Object.freeze({
  P0_POSITION_MONITOR: 0,
  P1_RECONCILIATION: 1,
  P2_DISCOVERY: 2,
  P3_SHADOW_CAPTURE: 3,
  P4_SHADOW_RESOLUTION: 4,
  P5_CHART_HISTORY: 5,
});
export const PRIORITY_NAMES = ['P0_POSITION_MONITOR', 'P1_RECONCILIATION', 'P2_DISCOVERY', 'P3_SHADOW_CAPTURE', 'P4_SHADOW_RESOLUTION', 'P5_CHART_HISTORY'];

export const HYPERLIQUID_WEIGHT_LIMIT_PER_MIN = 1200;
export const DEFAULT_WEIGHT_PER_MINUTE = null; // pacing off unless configured (see header)
const WINDOW_MS = 60_000;
// Budget each priority may NOT eat into (room kept for the ones above it).
const DEFAULT_RESERVE = [0, 0, 150, 350, 450, 500];
// Longest a request of each priority waits for room/cooldown before it is
// deferred. P0/P1 never wait; discovery may wait out a 60s window.
const DEFAULT_MAX_WAIT_MS = [0, 0, 90_000, 0, 0, 0];
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
const INTERVAL_MS = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000 };
const LIGHT_TYPES = new Set(['allMids', 'l2Book', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);

export class RateLimitedError extends Error {
  constructor(message, { retryAfterMs = null, priority = null } = {}) {
    super(`HTTP 429 RATE_LIMITED_DEFERRED: ${message}`);
    this.name = 'RateLimitedError';
    this.code = 'RATE_LIMITED';
    this.retryAfterMs = retryAfterMs;
    this.priority = priority;
  }
}

export const isRateLimitError = (error) => error?.code === 'RATE_LIMITED' || /\b429\b/.test(String(error?.message || error));

/** Exponential backoff with "equal jitter": half fixed, half random, so
 *  independently scheduled callers never retry in lockstep. attempt >= 1. */
export function backoffMs(attempt, { baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS, random = Math.random } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const cap = Math.min(maxMs, baseMs * 2 ** (n - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null if absent/invalid. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function parseBody(body) {
  if (!body) return null;
  if (typeof body === 'object') return body;
  try { return JSON.parse(String(body)); } catch { return null; }
}

/** Which Hyperliquid endpoint a request body hits (the per-endpoint counter key). */
export function endpointOf(body) {
  return String(parseBody(body)?.type || 'unknown');
}

/** Estimated Hyperliquid request weight (conservative where the docs are vague). */
export function requestWeight(body) {
  const parsed = parseBody(body);
  const type = parsed?.type;
  if (LIGHT_TYPES.has(type)) return 2;
  if (type === 'candleSnapshot') {
    const req = parsed.req || {};
    const step = INTERVAL_MS[req.interval] || 300_000;
    const bars = Math.max(0, (Number(req.endTime) - Number(req.startTime)) / step) || 500;
    return 20 + Math.ceil(Math.min(bars, 5000) / 60);
  }
  return 20;
}

/** In-flight de-duplication key: same URL + same body = same request. */
export function dedupKey(url, body) {
  const parsed = parseBody(body);
  return `${url}|${parsed ? stableStringify(parsed) : String(body ?? '')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Wrap a fetch so its abort timeout starts when the request is sent. */
export function withTimeout(fetchImpl, timeoutMs) {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

function emptyEndpoint() {
  return { requests: 0, ok: 0, errors: 0, http_429: 0, last_429_at_ms: null, deduplicated: 0, deferred: 0, retry_after_seen: 0 };
}

export class RequestBudget {
  constructor({
    fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, random = Math.random, timers = defaultTimers,
    weightPerMinute = DEFAULT_WEIGHT_PER_MINUTE, reserve = DEFAULT_RESERVE, maxWaitMs = DEFAULT_MAX_WAIT_MS,
    maxConcurrent = 4, baseBackoffMs = BACKOFF_BASE_MS, maxBackoffMs = BACKOFF_MAX_MS, host = HYPERLIQUID_INFO_URL,
  } = {}) {
    Object.assign(this, { fetchImpl, now, random, timers, weightPerMinute, reserve, maxWaitMs, maxConcurrent, baseBackoffMs, maxBackoffMs, host });
    this.window = [];            // [{ at, weight }] spent in the last 60s
    this.queue = [];             // waiting requests
    this.inflight = new Map();   // dedupKey -> Promise<shared result>
    this.running = 0;
    this.seq = 0;
    this.cooldownUntil = 0;      // after a 429: everything below P1 waits until then
    this.consecutive429 = 0;
    this.lastRetryAfterMs = null;
    this.timer = null;
    this.timerAt = null;
    this.endpoints = {};
    this.byPriority = PRIORITY_NAMES.map(() => ({ started: 0, deferred: 0, waited_ms: 0 }));
    this.totals = { requests: 0, http_429: 0, deduplicated: 0, deferred: 0, last_429_at_ms: null, last_ok_at_ms: null };
  }

  endpoint(name) {
    return (this.endpoints[name] ||= emptyEndpoint());
  }

  /** Does this URL go through the budget? Only the Hyperliquid info API. */
  governs(url) {
    return String(url).startsWith(this.host);
  }

  windowWeight(at = this.now()) {
    while (this.window.length && this.window[0].at <= at - WINDOW_MS) this.window.shift();
    return this.window.reduce((sum, w) => sum + w.weight, 0);
  }

  /** A fetch-compatible function whose Hyperliquid requests carry `priority`
   *  (for code that takes a fetchImpl, e.g. the unmodified production scan).
   *  Other hosts (Binance, Coinbase) pass straight through untouched. The
   *  caller's own abort timer would already be running while the request
   *  waits in the queue, so for governed requests it is replaced by a
   *  timeout of `timeoutMs` that starts when the request is actually sent. */
  fetchImplFor(priority, fetchImpl, { timeoutMs = 8000 } = {}) {
    return (url, init = {}) => {
      const base = fetchImpl || this.fetchImpl;
      if (!this.governs(url)) return base(url, init);
      const { signal, ...rest } = init;
      return this.fetch(url, rest, { priority, fetchImpl: withTimeout(base, timeoutMs) });
    };
  }

  async fetch(url, init = {}, { priority = PRIORITY.P2_DISCOVERY, fetchImpl, maxWaitMs } = {}) {
    const doFetch = fetchImpl || this.fetchImpl;
    if (!this.governs(url)) return doFetch(url, init);
    const key = dedupKey(url, init?.body);
    const name = endpointOf(init?.body);
    const shared = this.inflight.get(key);
    if (shared) {
      this.endpoint(name).deduplicated += 1;
      this.totals.deduplicated += 1;
      return toResponse(await shared);
    }
    const promise = this.schedule({ url, init, priority, name, doFetch, maxWaitMs, weight: requestWeight(init?.body) });
    this.inflight.set(key, promise);
    try {
      return toResponse(await promise);
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  schedule(req) {
    const p = Math.max(0, Math.min(5, Number(req.priority) || 0));
    const wait = req.maxWaitMs ?? this.maxWaitMs[p] ?? 0;
    return new Promise((resolve, reject) => {
      const entry = { ...req, priority: p, seq: this.seq += 1, enqueuedAt: this.now(), deadline: this.now() + wait, resolve, reject };
      this.queue.push(entry);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  /** Why this request can't start right now (null = it can). */
  blockedReason(entry, at) {
    if (entry.priority <= PRIORITY.P1_RECONCILIATION) return null; // never held back by budget or cooldown
    if (at < this.cooldownUntil) return 'COOLDOWN_AFTER_429';
    // Research/chart traffic yields for a full window after any 429.
    if (entry.priority >= PRIORITY.P3_SHADOW_CAPTURE && this.totals.last_429_at_ms !== null && at - this.totals.last_429_at_ms < WINDOW_MS) return 'RECENT_429';
    if (this.paced() && this.windowWeight(at) + entry.weight > this.weightPerMinute - (this.reserve[entry.priority] ?? 0)) return 'WEIGHT_BUDGET';
    return null;
  }

  /** When could a blocked request next become startable? */
  paced() {
    return Number.isFinite(this.weightPerMinute) && this.weightPerMinute > 0;
  }

  nextOpportunity(entry, at) {
    if (at < this.cooldownUntil) return this.cooldownUntil;
    const recent = entry.priority >= PRIORITY.P3_SHADOW_CAPTURE && this.totals.last_429_at_ms !== null ? this.totals.last_429_at_ms + WINDOW_MS : 0;
    if (at < recent) return recent;
    if (!this.paced()) return at;
    const room = this.weightPerMinute - (this.reserve[entry.priority] ?? 0) - entry.weight;
    let used = this.windowWeight(at);
    for (const w of this.window) {
      used -= w.weight;
      if (used <= room) return w.at + WINDOW_MS + 1;
    }
    return at + 1000;
  }

  pump() {
    const at = this.now();
    let wakeAt = Infinity;
    for (const entry of [...this.queue]) {
      if (this.running >= this.maxConcurrent) break;
      const why = this.blockedReason(entry, at);
      if (!why) {
        this.queue.splice(this.queue.indexOf(entry), 1);
        this.start(entry, at);
        continue;
      }
      const next = this.nextOpportunity(entry, at);
      if (next > entry.deadline) {
        this.queue.splice(this.queue.indexOf(entry), 1);
        this.defer(entry, why, next - at);
        continue;
      }
      wakeAt = Math.min(wakeAt, next);
    }
    this.arm(wakeAt, at);
  }

  arm(wakeAt, at) {
    if (!Number.isFinite(wakeAt)) return;
    if (this.timer && this.timerAt <= wakeAt) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timerAt = wakeAt;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.timerAt = null; this.pump(); }, Math.max(0, wakeAt - at));
  }

  defer(entry, why, retryAfterMs) {
    this.endpoint(entry.name).deferred += 1;
    this.byPriority[entry.priority].deferred += 1;
    this.totals.deferred += 1;
    entry.reject(new RateLimitedError(`${PRIORITY_NAMES[entry.priority]} ${entry.name} deferred (${why})`, { retryAfterMs, priority: entry.priority }));
  }

  start(entry, at) {
    this.running += 1;
    this.window.push({ at, weight: entry.weight });
    const ep = this.endpoint(entry.name);
    ep.requests += 1;
    this.totals.requests += 1;
    const stats = this.byPriority[entry.priority];
    stats.started += 1;
    stats.waited_ms += at - entry.enqueuedAt;
    (async () => {
      let res;
      try {
        res = await entry.doFetch(entry.url, entry.init);
      } catch (error) {
        ep.errors += 1;
        throw error;
      }
      const status = Number(res?.status);
      const headers = res?.headers;
      if (status === 429) {
        this.note429(entry.name, headers?.get?.('retry-after'));
      } else if (res?.ok) {
        ep.ok += 1;
        this.consecutive429 = 0;
        this.totals.last_ok_at_ms = this.now();
      } else {
        ep.errors += 1;
      }
      let data = null;
      let parseError = null;
      if (res?.ok) {
        try { data = await res.json(); } catch (error) { parseError = error; }
      }
      return { ok: Boolean(res?.ok), status, retryAfter: headers?.get?.('retry-after') ?? null, data, parseError };
    })().then(entry.resolve, entry.reject).finally(() => {
      this.running -= 1;
      this.pump();
    });
  }

  note429(name, retryAfterHeader) {
    const at = this.now();
    const ep = this.endpoint(name);
    ep.http_429 += 1;
    ep.last_429_at_ms = at;
    this.totals.http_429 += 1;
    this.totals.last_429_at_ms = at;
    this.consecutive429 += 1;
    const retryAfterMs = parseRetryAfter(retryAfterHeader, at);
    if (retryAfterMs !== null) ep.retry_after_seen += 1;
    this.lastRetryAfterMs = retryAfterMs;
    const wait = retryAfterMs ?? backoffMs(this.consecutive429, { baseMs: this.baseBackoffMs, maxMs: this.maxBackoffMs, random: this.random });
    this.cooldownUntil = Math.max(this.cooldownUntil, at + wait);
  }

  /** Diagnostics snapshot (the SIDE 1 rate-limit panel's data contract). */
  health() {
    const at = this.now();
    const queueDepth = PRIORITY_NAMES.map(() => 0);
    for (const q of this.queue) queueDepth[q.priority] += 1;
    return {
      schema: 'rate-limit-health/v1',
      host: this.host,
      at_ms: at,
      state: at < this.cooldownUntil ? 'BACKOFF' : this.totals.last_429_at_ms && at - this.totals.last_429_at_ms < WINDOW_MS ? 'RECOVERING' : 'OK',
      cooldown_until_ms: at < this.cooldownUntil ? this.cooldownUntil : null,
      consecutive_429: this.consecutive429,
      last_retry_after_ms: this.lastRetryAfterMs,
      weight_used_last_60s: this.windowWeight(at),
      weight_limit_per_min: this.paced() ? this.weightPerMinute : null,
      pacing: this.paced() ? 'WEIGHT_BUDGET' : 'REACTIVE_429_ONLY',
      hyperliquid_limit_per_min: HYPERLIQUID_WEIGHT_LIMIT_PER_MIN,
      in_flight: this.running,
      queue_depth: this.queue.length,
      queue_depth_by_priority: Object.fromEntries(PRIORITY_NAMES.map((n, i) => [n, queueDepth[i]])),
      by_priority: Object.fromEntries(PRIORITY_NAMES.map((n, i) => [n, { ...this.byPriority[i] }])),
      endpoints: JSON.parse(JSON.stringify(this.endpoints)),
      totals: { ...this.totals },
    };
  }
}

// Each waiter gets its own Response-like view of the shared result (its own
// copy of the parsed body, so one caller can never mutate another's data).
function toResponse(shared) {
  return {
    ok: shared.ok,
    status: shared.status,
    headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? shared.retryAfter : null) },
    json: async () => {
      if (shared.parseError) throw shared.parseError;
      return shared.data === null ? null : structuredClone(shared.data);
    },
  };
}

let shared = null;
/** The one per-process budget every production call site uses. */
export function sharedBudget() {
  if (!shared) {
    const n = Number(process.env.HYPERLIQUID_WEIGHT_PER_MINUTE);
    shared = new RequestBudget(Number.isFinite(n) && n > 0 ? { weightPerMinute: Math.min(n, HYPERLIQUID_WEIGHT_LIMIT_PER_MIN) } : {});
  }
  return shared;
}

/** Callers that were handed a custom fetchImpl (tests, injected mocks) and no
 *  explicit budget talk to it directly; the real network always goes through
 *  the shared budget. */
export function budgetFor(fetchImpl, budget) {
  if (budget !== undefined) return budget;
  return fetchImpl === undefined || fetchImpl === globalThis.fetch ? sharedBudget() : null;
}
