import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildShadowPayload, crossMarket, executionFromCycle, frameFeatures, riskInputsFor, scanCandlesByCoin, FEATURE_VERSION, GENERATOR_VERSION } from './shadow_capture.mjs';
import { emptyMetrics, runCycle, shadowObserve } from './forward_loop.mjs';

const require = createRequire(import.meta.url);
const Guard = require('../research/shadow-leakage-guard.js');
const NOW = 1_790_000_060_000;
const SPAN = { m5: 300000, m15: 900000, h1: 3600000, h4: 14400000, d1: 86400000 };

function frame(key, drift = 0.001, n = 220) {
  const end = Math.floor(NOW / SPAN[key]) * SPAN[key] - SPAN[key];
  return Array.from({ length: n }, (_, i) => {
    const close = 100 * (1 + drift) ** i;
    return { time: end - (n - 1 - i) * SPAN[key], open: close / (1 + drift), high: close * 1.002, low: close / (1 + drift) * 0.998, close, volume: 100 + (i % 7) };
  });
}
const timeframes = (drift) => Object.fromEntries(Object.keys(SPAN).map((k) => [k, frame(k, drift)]));
const cand = (direction, strategy, q, extra = {}) => ({ direction, strategy, entry: 100, stop: direction === 'long' ? 98 : 102, target1: direction === 'long' ? 102 : 98, target2: direction === 'long' ? 104 : 96, rr1: 1, rr2: 2, setupQuality: q, decision: 'TAKE TRADE', regime: 'UPTREND', ...extra });

function researchScan() {
  const btcPick = cand('long', 'TREND CONTINUATION', 80);
  return {
    scanId: 'scan-t1', scannedAt: NOW, status: 'BEST_TRADE_NOW', universe: { found: 3, scanned: 3 },
    rankedOpportunities: [
      { rank: 1, asset: 'BTC', direction: 'long', strategy: 'TREND CONTINUATION', market_geometry: 'COMPLETE', strict_verdict: 'TAKE TRADE', ml_score: null },
      { rank: 2, asset: 'ETH', direction: 'short', strategy: 'MEAN REVERSION', market_geometry: 'COMPLETE', strict_verdict: 'WAIT' },
      { rank: 3, asset: 'SOL', direction: null, strategy: null, market_geometry: 'INCOMPLETE', strict_verdict: 'NO TRADE' },
    ],
    bestTradeNow: { asset: 'BTC', direction: 'long', strategy: 'TREND CONTINUATION', ml: { model_id: null } },
    research: {
      failures: ['XRP: All feeds unavailable'], assetCtxs: { BTC: { funding: '0.0000125', openInterest: '1000', markPx: '100.1' } },
      markets: [
        { symbol: 'BTC', price: 100, sourceCount: 3, sources: ['Hyperliquid', 'Binance', 'Coinbase'], quantPick: btcPick, timeframes: timeframes(0.001),
          candidates: [btcPick, cand('short', 'MEAN REVERSION', 55), cand('long', 'BREAKOUT + RETEST', 62)] },
        { symbol: 'ETH', price: 100, sourceCount: 2, quantPick: cand('short', 'MEAN REVERSION', 70), timeframes: timeframes(-0.001),
          candidates: [cand('short', 'MEAN REVERSION', 70)] },
        { symbol: 'SOL', price: 100, sourceCount: 2, quantPick: { direction: null }, timeframes: timeframes(0), candidates: [] },
      ],
    },
  };
}
const signal = { signal_id: 'scan-t1-BTC', asset: 'BTC', direction: 'long', timestamp: NOW, entry: 100, stop: 98, targets: [102, 104] };

test('every candidate and every market state is observed, not only the selected trade', () => {
  const p = buildShadowPayload({ scan: researchScan(), signal }, { decision: 'EXECUTED', signal_id: 'scan-t1-BTC' });
  const cands = p.observations.filter((o) => o.kind === 'CANDIDATE'), states = p.observations.filter((o) => o.kind === 'MARKET_STATE');
  assert.equal(cands.length, 4);
  assert.equal(states.length, 3);
  const eth = cands.find((o) => o.asset === 'ETH');
  assert.equal(eth.decision.candidate.production_rank, 2);
  assert.equal(eth.not_submitted_reason, 'RANK_BELOW_SELECTED');
  const btcShort = cands.find((o) => o.asset === 'BTC' && o.decision.candidate.direction === 'short');
  assert.equal(btcShort.decision.candidate.is_production_pick, false);
  assert.equal(btcShort.not_submitted_reason, 'NOT_ASSET_PICK');
  assert.deepEqual(cands.map((o) => o.decision.candidate.scan_candidate_rank).sort(), [1, 2, 3, 4]);
  assert.equal(cands.filter((o) => o.submitted).length, 1);
  assert.equal(states.find((o) => o.asset === 'SOL').production_state, 'NO_TRADE');
  assert.equal(p.scan.submitted_signal_id, 'scan-t1-BTC');
  assert.equal(p.scan.generator_version, GENERATOR_VERSION);
  assert.equal(p.scan.feature_version, FEATURE_VERSION);
  assert.deepEqual(p.scan.failures, ['XRP: All feeds unavailable']);
});

test('decision semantics (TASK A) are recorded on every candidate, are decision-time, and map back from the legacy row', () => {
  const Quant = require('../quant-engine.js');
  const scan = researchScan();
  const withSemantics = (c, m) => ({ ...c, semantics: Quant.decisionSemantics(c, { sourceCount: m.sourceCount, matchingFeeds: 3, maxPriceDisagreement: 0.004 }) });
  for (const m of scan.research.markets) { m.quantPick = withSemantics(m.quantPick, m); m.candidates = m.candidates.map((c) => withSemantics(c, m)); }
  const p = buildShadowPayload({ scan, signal }, { decision: 'EXECUTED', signal_id: 'scan-t1-BTC' });
  const cands = p.observations.filter((o) => o.kind === 'CANDIDATE');
  assert.equal(cands.length, 4);
  for (const o of cands) {
    const c = o.decision.candidate;
    assert.equal(c.semantics.version, 'DECISION-SEMANTICS-V1');
    assert.deepEqual(Guard.hindsightPaths(o.decision), []);
    // The recorded legacy verdict fields alone reproduce the same three populated concepts.
    const back = Quant.mapLegacyVerdict({ strict_verdict: c.verdict, direction: c.direction, strategy: c.strategy, quant_score: c.quant_score, entry: c.entry, stop: c.stop, tp1: c.tp1, rr1: c.rr1,
      entry_quality: c.entry_quality, entry_status: c.entry_status, market: { source_count: o.decision.market.source_count, matching_feeds: 3, max_price_disagreement: 0.004 } });
    if (c.verdict) assert.deepEqual([back.ranking_verdict, back.entry_readiness, back.data_confirmation], [c.semantics.ranking_verdict, c.semantics.entry_readiness, c.semantics.data_confirmation]);
  }
  // A candidate with no semantics (old Quant output) is recorded as null, never invented.
  const old = buildShadowPayload({ scan: researchScan(), signal }, { decision: 'EXECUTED' });
  assert.ok(old.observations.filter((o) => o.kind === 'CANDIDATE').every((o) => o.decision.candidate.semantics === null));
});

test('decision-time data carries features, cross-market and derivatives context, and no future field', () => {
  const p = buildShadowPayload({ scan: researchScan(), signal }, { decision: 'EXECUTED' });
  const btc = p.observations.find((o) => o.kind === 'CANDIDATE' && o.asset === 'BTC' && o.decision.candidate.is_production_pick);
  assert.ok(btc.decision.features.h1.atr > 0 && btc.decision.features.m5.rsi > 50);
  assert.equal(btc.decision.derivatives.funding, 0.0000125);
  assert.equal(btc.decision.cross_market.breadth_h1_up, 0.3333);
  assert.ok(btc.decision.market.data_age_ms >= 0 && btc.decision.market.data_age_ms <= 600000);
  for (const o of p.observations) assert.deepEqual(Guard.hindsightPaths(o.decision), []);
  assert.deepEqual(Guard.hindsightPaths(p.scan), []);
});

test('no-trade scans are still observed', () => {
  const scan = researchScan();
  scan.bestTradeNow = null;
  const p = buildShadowPayload({ scan, signal: null }, { decision: 'NO_SIGNAL' });
  assert.equal(p.scan.submitted_signal_id, null);
  assert.equal(p.observations.filter((o) => o.submitted).length, 0);
  assert.ok(p.observations.filter((o) => o.kind === 'CANDIDATE').every((o) => ['NO_SIGNAL_THIS_SCAN', 'NOT_ASSET_PICK'].includes(o.not_submitted_reason)));
});

test('the paper outcome maps to execution fields, kept apart from research validity', () => {
  const r = { signal };
  assert.deepEqual(executionFromCycle('EXECUTED', r, { body: { trade: { id: 1 } } }), { decision: 'EXECUTED', signal_id: 'scan-t1-BTC', trade: { id: 1 } });
  assert.deepEqual(executionFromCycle('REJECTED:ENTRIES_PAUSED', r, { body: { reason: 'ENTRIES_PAUSED' } }), { decision: 'REJECTED', reason: 'ENTRIES_PAUSED', signal_id: 'scan-t1-BTC' });
  assert.equal(executionFromCycle('STALE', r, { body: { reason: 'STALE_MARKET_DATA' } }).reason, 'STALE_MARKET_DATA');
  assert.equal(executionFromCycle('STALE_OPEN_POSITIONS', r, null).reason, 'STALE_MARKET_DATA_FOR_OPEN_POSITIONS');
  assert.deepEqual(executionFromCycle('NO_VALID_CANDIDATE', { signal: null }, null), { decision: 'NO_SIGNAL' });
});

test('the JS leakage guard rejects hindsight fields as features', () => {
  for (const bad of [['optimal_entry'], ['features.h1.rsi', 'mfe_r'], ['policy_r'], ['FUTURE_LABEL_DATA.B1'], ['best_achievable_r'], ['classification']]) {
    assert.throws(() => Guard.assertDecisionFeatures(bad), /HINDSIGHT_FIELD_AS_FEATURE/);
  }
  Guard.assertDecisionFeatures(['features.h1.rsi', 'features.h4.ret_6', 'cross_market.breadth_h1_up', 'candidate.rr1']);
});

test('frame features and breadth are point-in-time only', () => {
  const f = frameFeatures(frame('h1', 0.001));
  assert.ok(f.ret_1 > 0 && f.rsi === 100 && f.range_pos_20 > 0.5);
  assert.equal(frameFeatures(frame('h1').slice(0, 10)), null);
  assert.equal(crossMarket({ A: { h1: { ret_1: 0.1 } }, B: { h1: { ret_1: -0.1 } } }).breadth_h1_up, 0.5);
  assert.equal(scanCandlesByCoin({ scan: researchScan() }).BTC.length, 220);
});

function fakeService({ signalBody = { accepted: true, trade: {} }, shadowStatus = 200, pending = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith('/shadow/') && shadowStatus !== 200) return { status: shadowStatus, json: async () => ({}) };
    const body = path === '/paper/open' ? { trades: [] } : path === '/paper/signal' ? signalBody
      : path === '/shadow/pending' ? { pending } : path === '/shadow/scan' ? { inserted: 7 } : path === '/shadow/resolve' ? { labels: 2 } : {};
    return { status: 200, json: async () => body };
  };
  return calls;
}
const scanDep = (scan = researchScan()) => async (opts) => {
  assert.equal(opts.includeResearch, true);
  return { signal: scan.bestTradeNow ? signal : null, coin: 'BTC', scan, reason: scan.bestTradeNow ? undefined : 'NO_VALID_CANDIDATE' };
};

test('a signal rejected with ENTRIES_PAUSED is still tracked, after (never before) the paper decision', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const calls = fakeService({ signalBody: { accepted: false, reason: 'ENTRIES_PAUSED' } });
  const out = await runCycle(0, emptyMetrics(), { scan: scanDep(), mid: async () => ({ price: 100, at: Date.now() }) });
  assert.equal(out.outcome, 'REJECTED:ENTRIES_PAUSED');
  const order = calls.map((c) => c.path);
  assert.ok(order.indexOf('/paper/signal') < order.indexOf('/shadow/scan'));
  const payload = calls.find((c) => c.path === '/shadow/scan').body;
  assert.deepEqual(payload.scan.execution, { decision: 'REJECTED', reason: 'ENTRIES_PAUSED', signal_id: 'scan-t1-BTC' });
  assert.equal(payload.observations.find((o) => o.submitted).asset, 'BTC');
  assert.equal(out.shadow.recorded, 7);
});

test('a no-trade cycle still records the scan', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const scan = researchScan();
  scan.bestTradeNow = null;
  const calls = fakeService();
  const out = await runCycle(0, emptyMetrics(), { scan: scanDep(scan) });
  assert.equal(out.outcome, 'NO_VALID_CANDIDATE');
  assert.equal(calls.find((c) => c.path === '/shadow/scan').body.scan.execution.decision, 'NO_SIGNAL');
  assert.ok(!calls.some((c) => c.path === '/paper/signal'));
});

test('a shadow failure never breaks or changes the paper cycle', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const calls = fakeService({ shadowStatus: 500 });
  const out = await runCycle(0, emptyMetrics(), { scan: scanDep(), mid: async () => ({ price: 100, at: Date.now() }) });
  assert.equal(out.outcome, 'EXECUTED');
  assert.ok(out.shadow.errors >= 1);
  assert.equal(calls.filter((c) => c.path === '/paper/signal').length, 1);
});

test('resolution uses the scan\'s own same-venue candles, and a failed extra fetch is never replaced', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const calls = fakeService({ pending: [{ coin: 'BTC', since_ms: NOW - 3600000 }, { coin: 'DOGE', since_ms: NOW - 50 * 3600000 }] });
  const out = await shadowObserve(0, { scan: researchScan(), signal }, 'EXECUTED', { body: {} }, { candles: async () => { throw new Error('HTTP 429'); } });
  const resolves = calls.filter((c) => c.path === '/shadow/resolve');
  assert.deepEqual(resolves.map((c) => c.body.coin), ['BTC']);
  assert.equal(resolves[0].body.venue, 'HYPERLIQUID');
  assert.equal(resolves[0].body.interval, '5m');
  assert.equal(resolves[0].body.candles.length, 220);
  assert.equal(out.resolved, 2);
});

test('shadow code only talks to /shadow/* and cannot reach paper or live execution', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  const calls = fakeService({ pending: [{ coin: 'BTC', since_ms: NOW - 3600000 }] });
  await shadowObserve(0, { scan: researchScan(), signal }, 'EXECUTED', { body: {} }, {});
  assert.ok(calls.length > 0 && calls.every((c) => c.path.startsWith('/shadow/')));
  const src = readFileSync(new URL('./shadow_capture.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['/paper/', '/execution/', 'fetch(', 'hummingbot', 'mainnet', 'LIVE_']) assert.ok(!src.includes(forbidden), forbidden);
});

test('Risk Sizing V2 inputs: same-scan daily candles and venue precision, never substituted', () => {
  const scan = researchScan();
  scan.research.assetMeta = { BTC: { szDecimals: 5 } };
  const btc = riskInputsFor(scan.research, 'BTC');
  assert.equal(btc.vol.venue, 'HYPERLIQUID');
  assert.equal(btc.vol.interval, '1d');
  assert.equal(btc.vol.closes.length, 220);
  assert.equal(btc.vol.last_bar_open_ms, scan.research.markets[0].timeframes.d1.at(-1).time);
  assert.equal(btc.venue_rules.qty_decimals, 5);
  assert.equal(riskInputsFor(scan.research, 'NOPE'), null);
  const p = buildShadowPayload({ scan, signal }, { decision: 'NO_SIGNAL' });
  assert.deepEqual(Object.keys(p.scan.risk_inputs).sort(), ['BTC', 'ETH', 'SOL']);
});

test('the submitted signal carries V2 inputs; a failed order-book read is sent as missing, not faked', async () => {
  process.env.MARKET_EDGE_EXEC_API_KEY = 'k';
  let calls = fakeService();
  const book = { venue: 'HYPERLIQUID', bids: [[99.9, 5]], asks: [[100.1, 5]], at_ms: Date.now() };
  await runCycle(0, emptyMetrics(), { scan: scanDep(), mid: async () => ({ price: 100, at: Date.now() }), book: async () => book, shadow: false });
  let sent = calls.find((c) => c.path === '/paper/signal').body.risk_inputs;
  assert.equal(sent.vol.closes.length, 220);
  assert.deepEqual(sent.depth, book);
  calls = fakeService();
  await runCycle(0, emptyMetrics(), { scan: scanDep(), mid: async () => ({ price: 100, at: Date.now() }), book: async () => { throw new Error('HTTP 429'); }, shadow: false });
  sent = calls.find((c) => c.path === '/paper/signal').body.risk_inputs;
  assert.equal(sent.depth, undefined);
  assert.ok(sent.vol);
});
