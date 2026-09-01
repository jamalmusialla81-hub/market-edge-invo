import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCompleteTrade, parseScanResponse } from './marketEdgeApi.js';

const ready = {
  scanId: 'scan-proof', scannedAt: 1730332800000, status: 'TRADE_READY',
  universe: { found: 40, scanned: 20, excluded: 20, dataFailures: 0 }, dataQuality: { status: 'MULTI_SOURCE', failures: [] },
  bestOpportunity: null,
  bestTradeNow: { asset: 'BTC', instrument: 'BTC', direction: 'short', strategy: 'TREND CONTINUATION', current_price: 72322.91, entry: 72450, entry_zone: { low: 72390, high: 72450 }, stop: 72663.19, tp1: 71710.4, tp2: 71070, rr1: 1.8, rr2: 3, setup_quality: 82, entry_status: 'TRADE_READY', strict_verdict: 'TAKE TRADE', quant_score: 82, ml_score: null, combined_score: 82, ml: { model_id: null, status: null, weight: 0 }, position: { notional: 70, margin: 7, leverage: 10, risk_amount: 0.07, estimated_costs: 0.11, allocation: 1 }, regime: 'DOWNTREND', reasoning: 'Test response', caution: null, source_count: 2, data_quality: 'MULTI_SOURCE', scan_snapshot_id: 'frozen-proof' }
};

test('normalizes Worker fields without changing underlying trade values', () => {
  const parsed = parseScanResponse(ready);
  assert.equal(parsed.bestTradeNow.entry, ready.bestTradeNow.entry);
  assert.equal(parsed.bestTradeNow.stop, ready.bestTradeNow.stop);
  assert.equal(parsed.bestTradeNow.tp1, ready.bestTradeNow.tp1);
  assert.equal(parsed.bestTradeNow.position.margin, ready.bestTradeNow.position.margin);
  assert.ok(hasCompleteTrade(parsed.bestTradeNow));
});

test('fails closed if TRADE_READY does not contain complete Worker geometry', () => {
  const malformed = structuredClone(ready);
  malformed.bestTradeNow.stop = null;
  assert.throws(() => parseScanResponse(malformed), /response rejected/);
});
