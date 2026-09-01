const KEY = 'market-edge-customer-beta-journal-v1';
export const STORAGE_MODE = 'TEMPORARY_LOCAL_STORAGE';

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function loadJournal() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => item && item.id && item.snapshot).slice(0, 250) : [];
  } catch { return []; }
}

function write(records) { localStorage.setItem(KEY, JSON.stringify(records.slice(0, 250))); }

export function recommendationId(scan) {
  const trade = scan?.bestTradeNow;
  return trade?.scanSnapshotId || (scan?.scanId && trade?.asset ? `${scan.scanId}:${trade.asset}` : null);
}

export function hasJournalAcceptance(records, scan) {
  const id = recommendationId(scan);
  return Boolean(id && records.some(record => record.recommendationId === id || record.id === `market-edge:${id}`));
}

export function saveAcceptedTrade(records, scan) {
  const trade = scan.bestTradeNow;
  if (!trade) return { records, added: false, reason: 'No actionable Worker recommendation is available.' };
  const recommendation = recommendationId(scan);
  if (!recommendation) return { records, added: false, reason: 'The Worker recommendation is missing its immutable identifier.' };
  const id = `market-edge:${recommendation}`;
  const existing = records.find(item => item.recommendationId === recommendation || item.id === id);
  if (existing) return { records, added: false, reason: 'This recommendation is already in My Trades.', record: existing };
  // Store an immutable client copy of the exact normalized Worker result plus
  // its raw response. No browser calculation or rescan happens here.
  const record = {
    id, recommendationId: recommendation, status: 'OPEN', source: 'MARKET EDGE', storage: STORAGE_MODE,
    acceptedAt: Date.now(), scanId: scan.scanId, scannedAt: scan.scannedAt,
    snapshot: clone(trade), rawWorkerResponse: clone(scan.raw),
    metadata: clone({ scanId: scan.scanId, scannedAt: scan.scannedAt, scanSnapshotId: trade.scanSnapshotId || null, universe: scan.universe, dataQuality: scan.dataQuality })
  };
  const next = [record, ...records];
  write(next);
  return { records: next, added: true, record };
}

export function removeLocalTrade(records, id) {
  const next = records.filter(item => item.id !== id);
  write(next);
  return next;
}
