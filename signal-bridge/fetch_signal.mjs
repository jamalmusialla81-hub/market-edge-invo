// Part E: read-only Market Edge signal fetcher for the paper execution
// bridge. Imports the real production scan orchestrator (backend/scan-core.mjs)
// unmodified and read-only -- this file does not change production behavior,
// ranking, or the customer-facing scan in any way. It only reads the same
// bestTradeNow result a customer would see and converts it into an
// AlphaSignal-shaped payload for POST /execution/signal on the (paper-only)
// execution-service.
//
// One-shot by design: this is the building block Part F's continuous forward
// loop calls on Market Edge's own cadence (backend/wrangler.jsonc: every 5
// minutes) -- it is not itself a scheduler.
import { runLiveScan } from '../backend/scan-core.mjs';

const EXECUTION_SERVICE_URL = process.env.EXECUTION_SERVICE_URL || 'http://localhost:8000';
const EXECUTION_SERVICE_API_KEY = process.env.MARKET_EDGE_EXEC_API_KEY;

export function bestTradeNowToAlphaSignal(scan) {
  const best = scan.bestTradeNow;
  if (!best) return null;
  return {
    signal_id: `${scan.scanId}-${best.asset}`,
    asset: best.asset,
    direction: best.direction,
    timestamp: scan.scannedAt,
    entry: best.entry,
    stop: best.stop,
    targets: [best.tp1, best.tp2].filter((value) => Number.isFinite(value)),
    quant_score: best.combined_score ?? best.quant_score ?? null,
    strategy_id: best.strategy || 'market-edge-alpha',
  };
}

// Display-only scan context for the desktop app's Signals screen. Never used
// for sizing or routing; the execution-service stores it next to the signal.
export function signalMeta(scan) {
  const best = scan?.bestTradeNow;
  if (!best) return null;
  const pick = (key) => (best[key] === undefined ? null : best[key]);
  return {
    rank: pick('rank'), quant_score: pick('quant_score'), ml_score: pick('ml_score'), combined_score: pick('combined_score'),
    rr1: pick('rr1'), rr2: pick('rr2'), strategy: pick('strategy'), entry_status: pick('entry_status'),
    strict_verdict: pick('strict_verdict'), current_price: pick('current_price'), source_count: pick('source_count'),
    regime: pick('regime'), scan_id: scan.scanId,
    // Provenance shown on Trade Detail. Read from whatever the scan already
    // returns; null when production does not report it (never inferred).
    model_version: best.ml?.model_id ?? null, model_status: best.ml?.status ?? null,
    feature_version: pick('feature_version'), observation_id: pick('observation_id'),
    scan_snapshot_id: pick('scan_snapshot_id'),
  };
}

export function toInstrument(asset) {
  return `${asset}-PERP`;
}

// The Hyperliquid market name production scanned (market.invoInstrument,
// surfaced as bestTradeNow.instrument); falls back to the asset symbol.
export function toCoin(scan) {
  const best = scan?.bestTradeNow;
  return best?.instrument || best?.asset || null;
}

async function postSignal(signal) {
  if (!EXECUTION_SERVICE_API_KEY) {
    throw new Error('MARKET_EDGE_EXEC_API_KEY is not set -- refusing to call the execution service without auth');
  }
  const response = await fetch(`${EXECUTION_SERVICE_URL}/execution/signal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': EXECUTION_SERVICE_API_KEY },
    body: JSON.stringify({ signal, instrument: toInstrument(signal.asset) }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export async function runOnce({ fetchImpl = fetch, now = Date.now(), dryRun = false } = {}) {
  const scan = await runLiveScan({ fetchImpl, now });
  const signal = bestTradeNowToAlphaSignal(scan);
  if (!signal) {
    return { scanId: scan.scanId, scannedAt: scan.scannedAt, status: scan.status, signal: null, reason: 'NO_VALID_CANDIDATE', posted: null };
  }
  if (dryRun) {
    return { scanId: scan.scanId, scannedAt: scan.scannedAt, status: scan.status, signal, coin: toCoin(scan), meta: signalMeta(scan), posted: null };
  }
  const posted = await postSignal(signal);
  return { scanId: scan.scanId, scannedAt: scan.scannedAt, status: scan.status, signal, posted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  runOnce({ dryRun })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error('SIGNAL_FETCH_FAILED:', error.message);
      process.exit(1);
    });
}
