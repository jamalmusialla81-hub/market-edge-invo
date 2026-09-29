// Empirical Hyperliquid rate-limit capture (#14), run in CI from a GitHub
// runner IP. Read only, a handful of light requests: records the status and
// every rate-limit-looking response header for allMids and one small
// candleSnapshot, so whether Hyperliquid sends Retry-After is observed, not
// assumed. Never fails the job -- it is evidence, printed as one JSON line.
const URL = 'https://api.hyperliquid.xyz/info';

async function probe(body) {
  const started = Date.now();
  try {
    const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const headers = {};
    for (const [k, v] of res.headers) if (/retry|rate|limit|x-/i.test(k)) headers[k] = v;
    return { type: body.type, status: res.status, ms: Date.now() - started, headers };
  } catch (error) {
    return { type: body.type, error: error.message, ms: Date.now() - started };
  }
}

const now = Date.now();
const results = [];
for (let i = 0; i < 3; i += 1) results.push(await probe({ type: 'allMids' }));
results.push(await probe({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '1h', startTime: now - 24 * 3600_000, endTime: now } }));
const limited = results.filter((r) => r.status === 429);
console.log(JSON.stringify({
  event: 'HYPERLIQUID_RATE_LIMIT_PROBE', at: new Date(now).toISOString(), results,
  any_429: limited.length > 0,
  retry_after_seen: results.some((r) => r.headers && Object.keys(r.headers).some((k) => k.toLowerCase() === 'retry-after')),
}));
