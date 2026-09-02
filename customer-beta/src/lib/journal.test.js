import test from 'node:test';
import assert from 'node:assert/strict';
import { hasJournalAcceptance, loadJournal, saveAcceptedTrade, STORAGE_MODE } from './journal.js';
import { parseScanResponse } from './marketEdgeApi.js';
import { fixtures } from '../test/workerFixtures.js';

globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.get(key) || null; },
  setItem(key, value) { this.store.set(key, value); }
};

const scan = parseScanResponse(fixtures.TRADE_READY);
const rankedWaitScan = parseScanResponse(fixtures.BEST_TRADE_NOW);

test('freezes one exact Worker recommendation and blocks duplicate confirmation', () => {
  globalThis.localStorage.store.clear();
  const first = saveAcceptedTrade([], scan);
  assert.equal(first.added, true);
  assert.deepEqual(first.record.snapshot, scan.bestTradeNow);
  assert.deepEqual(first.record.rawWorkerResponse, scan.raw);
  assert.equal(first.record.storage, STORAGE_MODE);
  scan.bestTradeNow.entry = 1;
  assert.notEqual(first.record.snapshot.entry, 1);
  const second = saveAcceptedTrade(first.records, scan);
  assert.equal(second.added, false);
  assert.equal(second.records.length, 1);
});

test('survives refresh and blocks the same recommendation under a new scan id', () => {
  globalThis.localStorage.store.clear();
  const original = parseScanResponse(fixtures.TRADE_READY);
  const first = saveAcceptedTrade([], original);
  const reloaded = loadJournal();
  const repeatRaw = structuredClone(fixtures.TRADE_READY);
  repeatRaw.scanId = 'server-scan-after-refresh';
  const repeat = parseScanResponse(repeatRaw);
  assert.equal(hasJournalAcceptance(reloaded, repeat), true);
  const second = saveAcceptedTrade(reloaded, repeat);
  assert.equal(second.added, false);
  assert.equal(second.records.length, 1);
});

test('freezes an always-ranked strict-WAIT recommendation with no browser recalculation', () => {
  globalThis.localStorage.store.clear();
  const saved = saveAcceptedTrade([], rankedWaitScan);
  assert.equal(saved.added, true);
  assert.equal(saved.record.snapshot.strictVerdict, 'WAIT');
  assert.equal(saved.record.snapshot.entryQuality, 'EXTENDED');
  assert.deepEqual(saved.record.snapshot, rankedWaitScan.bestTradeNow);
});
