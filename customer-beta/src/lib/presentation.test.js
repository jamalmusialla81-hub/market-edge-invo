import test from 'node:test';
import assert from 'node:assert/strict';
import { getTradePresentation, STATUS_LABELS } from './presentation.js';
import { parseScanResponse } from './marketEdgeApi.js';
import { fixtures } from '../test/workerFixtures.js';

test('maps every Worker result state to the intended customer-safe presentation', () => {
  for (const [status, fixture] of Object.entries(fixtures)) {
    const parsed = parseScanResponse(fixture);
    const view = getTradePresentation(parsed, { now: parsed.scannedAt + 1 });
    assert.equal(view.label, STATUS_LABELS[status]);
    assert.equal(view.showTakeTrade, status === 'TRADE_READY');
    assert.equal(view.takeTradeEnabled, status === 'TRADE_READY');
  }
  assert.equal(getTradePresentation(parseScanResponse(fixtures.DATA_UNAVAILABLE)).focus, null);
  assert.equal(getTradePresentation(parseScanResponse(fixtures.NO_VALID_SETUP)).showTakeTrade, false);
  assert.equal(getTradePresentation(parseScanResponse(fixtures.WAIT_FOR_ENTRY)).focus.entryStatus, 'WAIT_FOR_ENTRY');
});

test('keeps a valid lower-ranked best trade primary when best opportunity is wait', () => {
  const parsed = parseScanResponse(fixtures.TRADE_READY);
  const view = getTradePresentation(parsed, { now: parsed.scannedAt + 1 });
  assert.equal(view.focus.scanSnapshotId, fixtures.TRADE_READY.bestTradeNow.scan_snapshot_id);
  assert.equal(view.showSeparateOpportunity, true);
  assert.equal(view.opportunity.entryStatus, 'WAIT_FOR_ENTRY');
});

test('expires acceptance without changing the Worker trade data', () => {
  const parsed = parseScanResponse(fixtures.TRADE_READY);
  const view = getTradePresentation(parsed, { now: parsed.scannedAt + 15 * 60 * 1000 });
  assert.equal(view.showTakeTrade, true);
  assert.equal(view.takeTradeEnabled, false);
  assert.equal(view.focus.entry, fixtures.TRADE_READY.bestTradeNow.entry);
});
