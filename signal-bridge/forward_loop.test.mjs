import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, emptyMetrics } from './forward_loop.mjs';
import { bestTradeNowToAlphaSignal, toInstrument } from './fetch_signal.mjs';

test('classify counts NO_VALID_CANDIDATE when the scan has no bestTradeNow', () => {
  const metrics = emptyMetrics();
  const outcome = classify({ signal: null }, metrics);
  assert.equal(outcome, 'NO_VALID_CANDIDATE');
  assert.equal(metrics.no_valid_candidate, 1);
  assert.equal(metrics.signals_observed, 0);
});

test('classify counts a real fill as EXECUTED and increments fills', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 200, body: { accepted: true, fill: { status: 'FILLED' } } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'EXECUTED');
  assert.equal(metrics.valid_intents, 1);
  assert.equal(metrics.risk_approvals, 1);
  assert.equal(metrics.fills, 1);
  assert.equal(metrics.signals_observed, 1);
});

test('classify counts a stale rejection without counting it as a risk rejection', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 409, body: { detail: { reason: 'STALE_SIGNAL' } } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'STALE');
  assert.equal(metrics.stale_signals_blocked, 1);
  assert.equal(metrics.risk_rejections, 0);
});

test('classify counts a duplicate rejection separately from a risk rejection', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 409, body: { reason: 'EXECUTION_ROUTER_DUPLICATE_SIGNAL: s1' } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'DUPLICATE');
  assert.equal(metrics.duplicate_signals_blocked, 1);
});

test('classify falls back to a risk rejection for any other reason', () => {
  const metrics = emptyMetrics();
  const result = { signal: { signal_id: 's1' }, posted: { status: 409, body: { detail: { reason: 'MAX_PORTFOLIO_EXPOSURE_EXCEEDED' } } } };
  const outcome = classify(result, metrics);
  assert.equal(outcome, 'REJECTED:MAX_PORTFOLIO_EXPOSURE_EXCEEDED');
  assert.equal(metrics.risk_rejections, 1);
});

test('bestTradeNowToAlphaSignal maps the real scan-core.mjs field names, not guessed ones', () => {
  const scan = {
    scanId: 'scan-abc123', scannedAt: 1700000000000,
    bestTradeNow: { asset: 'BTC', direction: 'long', entry: 60000, stop: 58000, tp1: 62000, tp2: 64000, combined_score: 88, strategy: 'TREND CONTINUATION' },
  };
  const signal = bestTradeNowToAlphaSignal(scan);
  assert.deepEqual(signal, {
    signal_id: 'scan-abc123-BTC', asset: 'BTC', direction: 'long', timestamp: 1700000000000,
    entry: 60000, stop: 58000, targets: [62000, 64000], quant_score: 88, strategy_id: 'TREND CONTINUATION',
  });
});

test('bestTradeNowToAlphaSignal returns null when the scan found no valid candidate', () => {
  assert.equal(bestTradeNowToAlphaSignal({ scanId: 's', scannedAt: 0, bestTradeNow: null }), null);
});

test('toInstrument appends -PERP to the asset', () => {
  assert.equal(toInstrument('ETH'), 'ETH-PERP');
});
