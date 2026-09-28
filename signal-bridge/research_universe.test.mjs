import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPROVED_RESEARCH_ASSETS, RESEARCH_UNIVERSE_VERSION, supplementMarkets, supplementPerCycle, supplementPlan } from './research_universe.mjs';
import { buildShadowPayload, OUTSIDE_PRODUCTION_UNIVERSE, SCOPE_RESEARCH_SUPPLEMENT } from './shadow_capture.mjs';
import { emptyMetrics, runCycle, shadowObserve } from './forward_loop.mjs';

const NOW = 1_790_000_060_000;
const SPAN = { m5: 300000, m15: 900000, h1: 3600000, h4: 14400000, d1: 86400000 };
function frame(key, n = 220) {
  const end = Math.floor(NOW / SPAN[key]) * SPAN[key] - SPAN[key];
  return Array.from({ length: n }, (_, i) => {
    const close = 100 * 1.001 ** i;
    return { time: end - (n - 1 - i) * SPAN[key], open: close / 1.001, high: close * 1.002, low: close / 1.001 * 0.998, close, volume: 100 };
  });
}
const tfs = () => Object.fromEntries(Object.keys(SPAN).map((k) => [k, frame(k)]));
const cand = (direction, strategy, q) => ({ direction, strategy, entry: 100, stop: direction === 'long' ? 98 : 102, target1: direction === 'long' ? 102 : 98, target2: direction === 'long' ? 104 : 96, rr1: 1, rr2: 2, setupQuality: q, decision: 'TAKE TRADE', regime: 'UPTREND' });
const market = (symbol, cands = []) => ({ symbol, price: 100, sourceCount: 2, quantPick: cands[0] || { direction: null }, timeframes: tfs(), candidates: cands });
// every approved asset except these is "in the production scan"
const NOT_SCANNED = ['AERO', 'BCH', 'HBAR', 'ONDO', 'XLM'];
function productionScan({ failures = [], listed = [...APPROVED_RESEARCH_ASSETS, 'kPEPE'].filter((a) => a !== 'AERO') } = {}) {
  const scanned = ['BTC', 'ETH', 'SOL'];
  return {
    scanId: 'scan-p1', scannedAt: NOW, status: 'DATA_UNAVAILABLE', universe: { found: 40, scanned: 3 }, rankedOpportunities: [], bestTradeNow: null,
    research: { failures, assetCtxs: Object.fromEntries(listed.map((a) => [a, { funding: '0.00001', openInterest: '10' }])),
      markets: [...scanned, ...APPROVED_RESEARCH_ASSETS.filter((a) => !scanned.includes(a) && !NOT_SCANNED.includes(a))].map((s) => market(s)) },
  };
}

test('approved research universe = the 16 assets of the EXPANDED dataset manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../research/dataset-expansion/reports/dataset-manifest.json', import.meta.url)));
  assert.equal(manifest.dataset_version, RESEARCH_UNIVERSE_VERSION);
  assert.deepEqual([...APPROVED_RESEARCH_ASSETS].sort(), [...manifest.assets].sort());
  assert.equal(APPROVED_RESEARCH_ASSETS.length, 16);
});

test('supplement plan: deterministic rotation over assets the production scan missed, only venue-listed ones', () => {
  const scan = productionScan();
  const p0 = supplementPlan(scan, 0, 1), p1 = supplementPlan(scan, 1, 1), p4 = supplementPlan(scan, 4, 1);
  assert.deepEqual(p0.missing, NOT_SCANNED);
  assert.deepEqual(p0.notOnVenue, ['AERO']);            // not listed on the venue: never requested
  assert.deepEqual(p0.selected, ['BCH']);
  assert.deepEqual(p1.selected, ['HBAR']);
  assert.deepEqual(p4.selected, ['BCH']);               // wraps around the 4 eligible assets
  assert.deepEqual(supplementPlan(scan, 0, 1), p0);     // deterministic
  const seen = new Set([0, 1, 2, 3].flatMap((c) => supplementPlan(scan, c, 1).selected));
  assert.deepEqual([...seen].sort(), ['BCH', 'HBAR', 'ONDO', 'XLM']);
  assert.equal(supplementPlan(scan, 0, 3).selected.length, 3);
});

test('supplement is skipped when the production scan hit data failures (e.g. HTTP 429)', () => {
  const plan = supplementPlan(productionScan({ failures: ['BTC: HTTP 429'] }), 0, 1);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.skipped, 'PRODUCTION_SCAN_HAD_DATA_FAILURES');
  assert.equal(supplementPlan(productionScan({ listed: [] }), 0, 1).skipped, 'VENUE_LISTING_UNKNOWN');
  assert.equal(supplementPlan(productionScan(), 0, 0).skipped, 'DISABLED');
});

test('per-cycle budget is bounded (default 1, max 3)', () => {
  assert.equal(supplementPerCycle(undefined), 1);
  assert.equal(supplementPerCycle('10'), 3);
  assert.equal(supplementPerCycle('-2'), 0);
  assert.deepEqual(supplementMarkets(['BCH']), [{ invoInstrument: 'BCH', dataSymbol: 'BCH' }]);
});

test('research-supplement observations can never be submitted and are stamped outside the production universe', () => {
  const scan = { scanId: 'scan-r1', scannedAt: NOW, status: 'BEST_TRADE_NOW', rankedOpportunities: [{ rank: 1, asset: 'BCH', market_geometry: 'COMPLETE' }],
    bestTradeNow: { asset: 'BCH', direction: 'long', strategy: 'TREND' }, research: { failures: [], assetCtxs: {}, markets: [market('BCH', [cand('long', 'TREND', 80), cand('short', 'MR', 50)])] } };
  const p = buildShadowPayload({ scan, signal: { signal_id: 'x' } }, { decision: 'EXECUTED', signal_id: 'x' },
    { scope: SCOPE_RESEARCH_SUPPLEMENT, crossMarketContext: { markets: 40 }, assetCtxs: { BCH: { funding: '0.0001' } } });
  assert.equal(p.scan.scan_id, 'research-scan-r1');
  assert.equal(p.scan.scan_scope, SCOPE_RESEARCH_SUPPLEMENT);
  assert.equal(p.scan.submitted_signal_id, null);
  assert.deepEqual(p.scan.execution, { decision: 'NOT_APPLICABLE', reason: OUTSIDE_PRODUCTION_UNIVERSE });
  assert.deepEqual(p.scan.cross_market, { markets: 40 });
  for (const o of p.observations) {
    assert.equal(o.production_state, OUTSIDE_PRODUCTION_UNIVERSE);
    if (o.kind !== 'CANDIDATE') continue;
    assert.equal(o.submitted, false);
    assert.equal(o.not_submitted_reason, OUTSIDE_PRODUCTION_UNIVERSE);
    assert.equal(o.decision.candidate.is_production_pick, false);
    assert.equal(o.decision.candidate.is_best_trade_now, false);
    assert.equal(o.decision.candidate.production_rank, null);
  }
  assert.equal(p.observations.find((o) => o.kind === 'CANDIDATE' && o.decision.candidate.direction === 'long').decision.candidate.is_generator_asset_pick, true);
  assert.equal(p.observations[0].decision.derivatives.funding, 0.0001);
});

function fakeService() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const body = path === '/paper/open' ? { trades: [] } : path === '/shadow/pending' ? { pending: [] } : path === '/shadow/scan' ? { inserted: 3 } : {};
    return { status: 200, json: async () => body };
  };
  return calls;
}

test('shadow supplement runs research-only through /shadow/*, with injected markets, after the paper decision', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const calls = fakeService();
  const researchCalls = [];
  const researchScan = async (opts) => {
    researchCalls.push(opts);
    return { scanId: 'scan-r2', scannedAt: NOW, status: 'DATA_UNAVAILABLE', rankedOpportunities: [], bestTradeNow: null,
      research: { failures: [], assetCtxs: {}, markets: opts.markets.map((m) => market(m.invoInstrument, [cand('long', 'TREND', 70)])) } };
  };
  const out = await runCycle(2, emptyMetrics(), {
    scan: async (opts) => ({ signal: null, scan: productionScan(), reason: 'NO_VALID_CANDIDATE', includeResearch: opts.includeResearch }),
    researchScan, supplementCount: 1,
  });
  assert.equal(researchCalls.length, 1);
  assert.deepEqual(researchCalls[0].markets, [{ invoInstrument: 'ONDO', dataSymbol: 'ONDO' }]);
  assert.equal(researchCalls[0].includeResearch, true);
  assert.deepEqual(out.shadow.supplement.selected, ['ONDO']);
  const scans = calls.filter((c) => c.path === '/shadow/scan').map((c) => c.body.scan);
  assert.deepEqual(scans.map((s) => s.scan_scope), ['PRODUCTION_SCAN', SCOPE_RESEARCH_SUPPLEMENT]);
  // research never touches execution
  assert.ok(!calls.some((c) => ['/paper/signal', '/execution/intent'].includes(c.path)));
  assert.ok(calls.findIndex((c) => c.path === '/paper/no-trade') < calls.findIndex((c) => c.path === '/shadow/scan'));
});

test('delayed shadow resolution stops asking after an HTTP 429 (deferred, never filled from elsewhere)', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path });
    const body = path === '/shadow/pending' ? { pending: [{ coin: 'AAA', since_ms: 1 }, { coin: 'BBB', since_ms: 1 }] } : { inserted: 0 };
    return { status: 200, json: async () => body };
  };
  let fetched = 0;
  const out = await shadowObserve(0, { scan: productionScan({ failures: ['x'] }) }, 'NO_TRADE', null, {
    candles: async () => { fetched += 1; throw new Error('HTTP 429'); }, extraFetches: 5,
  });
  assert.equal(fetched, 1);
  assert.equal(out.deferred_rate_limited, true);
  assert.ok(!calls.some((c) => c.path === '/shadow/resolve'));
});

test('sealed holdout is untouched: same definition, and the expanded dataset is development-only', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const V2 = require('../research/rank-research-v2.js');
  const Registry = require('../research/dataset-registry.js');
  assert.equal(V2.HOLDOUT.id, 'PHASE5-V1-HOLDOUT-2025-12-01');
  assert.equal(V2.HOLDOUT.startMs, Date.UTC(2025, 11, 1));
  const manifest = JSON.parse(readFileSync(new URL('../research/dataset-expansion/reports/dataset-manifest.json', import.meta.url)));
  assert.deepEqual(manifest.holdout, JSON.parse(JSON.stringify(V2.HOLDOUT)));
  assert.equal(manifest.development_only, true);
  // separate versions, original not overwritten; contaminated V1 stays unusable
  assert.equal(Registry.status('HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF').status, 'ACTIVE');
  assert.equal(Registry.status('HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED').developmentOnly, true);
  assert.throws(() => Registry.assertTrainable('HISTORICAL-RANK-V1'), /DATASET_NOT_TRAINABLE/);
  for (const shadow of ['FORWARD-SHADOW-RAW-V1', 'FORWARD-SHADOW-RESOLVED-V1', 'FORWARD-PAPER-EXECUTED-V1']) {
    assert.throws(() => Registry.assertTrainable(shadow), /DATASET_NOT_TRAINABLE/);   // evidence collection, not online retraining
  }
});
