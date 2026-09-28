// Live market data for the paper forward loop, read from the same public
// Hyperliquid info API and the same completed-candle rules production's
// scan uses (backend/scan-core.mjs hyperCandles/completedCandles). Read only.
//
// Every request goes through the shared per-process request budget
// (rate_limit.mjs) at the caller's priority: open-position monitoring (P0),
// the open-trade candle backstop (P1), discovery's entry mark (P2), shadow
// resolution (P4). The budget never caches or re-serves a response, so every
// price here is still a fresh read or an error -- never a reused value.
import { budgetFor, PRIORITY, withTimeout } from './rate_limit.mjs';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const FIVE_MINUTES = 5 * 60 * 1000;
// Recorded on every accepted trade (data-integrity audit, 2026-09-27) so the
// price source is never ambiguous in the trade record.
export const MARKET_PRICE_SOURCE = 'HYPERLIQUID_ALLMIDS_LIVE';

// The timeout covers the HTTP exchange and starts when the request is sent;
// time waiting in the budget queue is bounded by the budget (P0/P1 never wait).
async function post(fetchImpl, body, timeoutMs = 8000, { priority = PRIORITY.P2_DISCOVERY, budget } = {}) {
  // No fetchImpl given = the real network, through the shared budget.
  const gate = budgetFor(fetchImpl, budget);
  const send = withTimeout(fetchImpl ?? gate?.fetchImpl ?? globalThis.fetch, timeoutMs);
  const init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const response = gate ? await gate.fetch(HYPERLIQUID_API, init, { priority, fetchImpl: send }) : await send(HYPERLIQUID_API, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

// The scan makes many Hyperliquid calls right before this and Hyperliquid's
// rate limit is a per-minute weight budget, so a 429 is retried until the
// window has rolled over (5+10+20+30s); a missing coin is not retried.
const MID_BACKOFF_MS = [5000, 10000, 20000, 30000];
export async function fetchMid(coin, { fetchImpl, now = Date.now, retries = MID_BACKOFF_MS.length, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), budget, priority = PRIORITY.P2_DISCOVERY } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(MID_BACKOFF_MS[Math.min(attempt - 1, MID_BACKOFF_MS.length - 1)]);
    let mids;
    try {
      mids = await post(fetchImpl, { type: 'allMids' }, 8000, { priority, budget });
    } catch (error) {
      lastError = error;
      continue;
    }
    const price = Number(mids?.[coin]);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`no live mid for ${coin} (allMids has ${Object.keys(mids || {}).length} coins)`);
    return { price, at: now() };
  }
  throw new Error(`allMids failed after ${retries + 1} attempts: ${lastError?.message}`);
}

// One allMids read serves every open position (batched: a single request
// regardless of how many positions are open). No retry loop here: the open-
// position monitor simply tries again on its next ~10s heartbeat, and a
// failure is reported as MARKET_DATA_OFFLINE rather than papered over.
// Priority P0 by default: this is the open-position monitor's price read.
export async function fetchAllMids({ fetchImpl, now = Date.now, timeoutMs = 5000, budget, priority = PRIORITY.P0_POSITION_MONITOR } = {}) {
  const mids = await post(fetchImpl, { type: 'allMids' }, timeoutMs, { priority, budget });
  if (!mids || typeof mids !== 'object') throw new Error('allMids returned no data');
  return { mids, at: now() };
}

export function parseCompletedCandles(rows, now, intervalMs = FIVE_MINUTES) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ time: Number(row?.t), open: Number(row?.o), high: Number(row?.h), low: Number(row?.l), close: Number(row?.c) }))
    .filter((c) => Object.values(c).every(Number.isFinite) && c.time + intervalMs <= now && c.low > 0
      && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time);
}

// Priority P1 by default (the open-trade backstop sweep); shadow resolution
// passes P4. Completed candles only; nothing is cached.
export async function fetchCompletedCandles(coin, sinceMs, { fetchImpl, now = Date.now(), budget, priority = PRIORITY.P1_RECONCILIATION } = {}) {
  const rows = await post(fetchImpl, { type: 'candleSnapshot', req: { coin, interval: '5m', startTime: sinceMs - FIVE_MINUTES, endTime: now } }, 8000, { priority, budget });
  return parseCompletedCandles(rows, now);
}
