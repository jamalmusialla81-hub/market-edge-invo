import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInvoSetup } from './invoSetup.js';
import { parseScanResponse } from './marketEdgeApi.js';
import { fixtures } from '../test/workerFixtures.js';

test('copies exact frozen Worker setup values without recording a trade', () => {
  const trade = parseScanResponse(fixtures.BEST_TRADE_NOW).bestTradeNow;
  const copied = formatInvoSetup(trade);
  assert.match(copied, /Invo instrument: BTC/);
  assert.match(copied, new RegExp(`Entry: ${trade.entry}`));
  assert.match(copied, new RegExp(`Stop: ${trade.stop}`));
  assert.match(copied, new RegExp(`TP1: ${trade.tp1}`));
});
