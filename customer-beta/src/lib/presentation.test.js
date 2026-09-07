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
    const expected = ['TRADE_READY', 'BEST_TRADE_NOW'].includes(status);
    assert.equal(view.showTakeTrade, expected);
    assert.equal(view.takeTradeEnabled, expected);
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

test('always-ranked current geometry can be accepted independently of the strict legacy verdict', () => {
  for (const entryQuality of ['IDEAL', 'ACCEPTABLE', 'EXTENDED']) {
    const raw = structuredClone(fixtures.BEST_TRADE_NOW);
    raw.bestTradeNow.entry_status = entryQuality;
    raw.bestTradeNow.entry_quality = entryQuality;
    raw.bestTradeNow.strict_verdict = entryQuality === 'IDEAL' ? 'TAKE TRADE' : 'WAIT';
    const view = getTradePresentation(parseScanResponse(raw), { now: raw.scannedAt + 1 });
    assert.equal(view.showTakeTrade, true, entryQuality);
    assert.equal(view.takeTradeEnabled, true, entryQuality);
  }
  const weak = structuredClone(fixtures.BEST_TRADE_NOW);
  weak.bestTradeNow.setup_quality = 39;
  weak.bestTradeNow.quant_score = 39;
  weak.bestTradeNow.combined_score = 39;
  assert.equal(getTradePresentation(parseScanResponse(weak), { now: weak.scannedAt + 1 }).showTakeTrade, true);
});

test('an invalid entry reconstruction is the one current-state condition that blocks acceptance', () => {
  const invalid = structuredClone(fixtures.BEST_TRADE_NOW);
  invalid.bestTradeNow.entry_status = 'INVALID';
  invalid.bestTradeNow.entry_quality = 'INVALID';
  const view = getTradePresentation(parseScanResponse(invalid), { now: invalid.scannedAt + 1 });
  assert.equal(view.showTakeTrade, false);
  assert.equal(view.takeTradeEnabled, false);
});

test('materially invalid price ordering is rejected before it can become a journal recommendation', () => {
  const invalid = structuredClone(fixtures.BEST_TRADE_NOW);
  invalid.bestTradeNow.stop = invalid.bestTradeNow.entry - 1;
  assert.throws(() => parseScanResponse(invalid), /BEST_TRADE_NOW requires valid current geometry/);
});

test('market geometry remains journal-eligible while user-specific sizing is blocked', () => {
  const constrained = structuredClone(fixtures.BEST_TRADE_NOW);
  constrained.bestTradeNow.position = null;
  constrained.bestTradeNow.user_executability = {status: 'BELOW_MINIMUM_ORDER', reason: 'ACCOUNT/MINIMUM SIZE CONSTRAINT'};
  constrained.bestTradeNow.market_geometry = 'COMPLETE';
  constrained.bestTradeNow.market_edge_recommendation = true;
  constrained.bestTradeNow.journal_eligible = true;
  constrained.bestTradeNow.user_executable_at_snapshot = false;
  const view = getTradePresentation(parseScanResponse(constrained), { now: constrained.scannedAt + 1 });
  assert.equal(view.kind, 'TRADE');
  assert.equal(view.showTakeTrade, true);
  assert.equal(view.takeTradeEnabled, true);
  assert.equal(view.userExecutable, false);
  assert.equal(view.marketValidity, 'COMPLETE');
  assert.equal(view.journalEligible, true);
  assert.equal(view.executabilityReason, 'ACCOUNT/MINIMUM SIZE CONSTRAINT');
});

test('a strict WAIT remains journal-eligible when account sizing is blocked', () => {
  const constrained = structuredClone(fixtures.BEST_TRADE_NOW);
  constrained.bestTradeNow.position = null;
  constrained.bestTradeNow.entry_status = 'EXTENDED';
  constrained.bestTradeNow.strict_verdict = 'WAIT';
  constrained.bestTradeNow.user_executability = {status: 'BLOCKED', reason: 'Insufficient margin at selected maximum leverage'};
  const view = getTradePresentation(parseScanResponse(constrained), { now: constrained.scannedAt + 1 });
  assert.equal(view.showTakeTrade, true);
  assert.equal(view.takeTradeEnabled, true);
  assert.equal(view.userExecutable, false);
});

test('expires acceptance without changing the Worker trade data', () => {
  const parsed = parseScanResponse(fixtures.TRADE_READY);
  const view = getTradePresentation(parsed, { now: parsed.scannedAt + 15 * 60 * 1000 });
  assert.equal(view.showTakeTrade, true);
  assert.equal(view.takeTradeEnabled, false);
  assert.equal(view.focus.entry, fixtures.TRADE_READY.bestTradeNow.entry);
});
