// Live market data for the paper forward loop, read from the same public
// Hyperliquid info API and the same completed-candle rules production's
// scan uses (backend/scan-core.mjs hyperCandles/completedCandles). Read only.
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const FIVE_MINUTES = 5 * 60 * 1000;

async function post(fetchImpl, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(HYPERLIQUID_API, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// The scan makes many Hyperliquid calls right before this, so a transient
// failure (e.g. HTTP 429) is retried briefly; a missing coin is not.
export async function fetchMid(coin, { fetchImpl = fetch, now = Date.now, retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let mids;
    try {
      mids = await post(fetchImpl, { type: 'allMids' });
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

export function parseCompletedCandles(rows, now, intervalMs = FIVE_MINUTES) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ time: Number(row?.t), open: Number(row?.o), high: Number(row?.h), low: Number(row?.l), close: Number(row?.c) }))
    .filter((c) => Object.values(c).every(Number.isFinite) && c.time + intervalMs <= now && c.low > 0
      && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time);
}

export async function fetchCompletedCandles(coin, sinceMs, { fetchImpl = fetch, now = Date.now() } = {}) {
  const rows = await post(fetchImpl, { type: 'candleSnapshot', req: { coin, interval: '5m', startTime: sinceMs - FIVE_MINUTES, endTime: now } });
  return parseCompletedCandles(rows, now);
}
