const KEY = 'market-edge-customer-beta-journal-v1';

export function loadJournal() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => item && item.id && item.snapshot).slice(0, 250) : [];
  } catch { return []; }
}

function write(records) { localStorage.setItem(KEY, JSON.stringify(records.slice(0, 250))); }

export function saveAcceptedTrade(records, scan) {
  const trade = scan.bestTradeNow;
  if (!trade) return { records, added: false, reason: 'No actionable Worker recommendation is available.' };
  const id = `market-edge:${scan.scanId}:${trade.scanSnapshotId || trade.asset}`;
  const existing = records.find(item => item.id === id);
  if (existing) return { records, added: false, reason: 'This recommendation is already in My Trades.', record: existing };
  // Store the exact normalized Worker result plus its raw response. No browser calculation or rescan happens here.
  const record = { id, status: 'OPEN', source: 'MARKET EDGE', acceptedAt: Date.now(), scanId: scan.scanId, scannedAt: scan.scannedAt, snapshot: trade, rawWorkerResponse: scan.raw };
  const next = [record, ...records];
  write(next);
  return { records: next, added: true, record };
}

export function removeLocalTrade(records, id) {
  const next = records.filter(item => item.id !== id);
  write(next);
  return next;
}
