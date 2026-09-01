import test from 'node:test';
import assert from 'node:assert/strict';
import { saveAcceptedTrade } from './journal.js';

globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.get(key) || null; },
  setItem(key, value) { this.store.set(key, value); }
};

const scan = {
  scanId: 'server-scan-1', scannedAt: 1730332800000,
  raw: { scanId: 'server-scan-1', proof: 'exact-worker-response' },
  bestTradeNow: { asset: 'BTC', direction: 'short', entry: 72450, stop: 72663.19, tp1: 71710.4, tp2: 71070, rr1: 1.8, scanSnapshotId: 'frozen-1' }
};

test('freezes one exact Worker recommendation and blocks duplicate confirmation', () => {
  const first = saveAcceptedTrade([], scan);
  assert.equal(first.added, true);
  assert.equal(first.record.snapshot.entry, 72450);
  assert.deepEqual(first.record.rawWorkerResponse, scan.raw);
  const second = saveAcceptedTrade(first.records, scan);
  assert.equal(second.added, false);
  assert.equal(second.records.length, 1);
});
