import { hasCompleteTrade, hasValidGeometry } from './marketEdgeApi.js';

export const STATUS_LABELS = Object.freeze({
  BEST_TRADE_NOW: 'BEST AVAILABLE NOW',
  TRADE_READY: 'TRADE READY',
  WAIT_FOR_ENTRY: 'GOOD SETUP — WAIT FOR ENTRY',
  ENTRY_EXPIRED: 'ENTRY EXPIRED',
  NO_VALID_SETUP: 'NO VALID SETUP',
  DATA_UNAVAILABLE: 'DATA UNAVAILABLE'
});

export function isScanFresh(scan, now = Date.now()) {
  return Boolean(scan && Number.isFinite(scan.scannedAt) && now - scan.scannedAt >= 0 && now - scan.scannedAt < 15 * 60 * 1000);
}

export function getTradePresentation(scan, { now = Date.now(), alreadyAccepted = false } = {}) {
  if (!scan) return { kind: 'EMPTY', label: 'AWAITING SCAN', focus: null, showTakeTrade: false, takeTradeEnabled: false };
  if (scan.status === 'DATA_UNAVAILABLE') return { kind: 'UNAVAILABLE', label: STATUS_LABELS.DATA_UNAVAILABLE, focus: null, showTakeTrade: false, takeTradeEnabled: false };
  const trade = scan.bestTradeNow || null;
  const opportunity = scan.bestOpportunity || null;
  const focus = trade || opportunity;
  // BEST_TRADE_NOW is the server-authoritative Phase 3 selection. The legacy
  // strict verdict remains context only. A market can be legitimate while a
  // specific account cannot meet its minimum position/risk constraints.
  const marketReady = ['BEST_TRADE_NOW', 'TRADE_READY'].includes(scan.status) && hasValidGeometry(trade) && trade.entryStatus !== 'INVALID' && trade.entryQuality !== 'INVALID';
  const actionable = marketReady && hasCompleteTrade(trade);
  const executabilityReason = !marketReady ? 'The Worker no longer considers this market plan current.' : !actionable ? trade?.userExecutability?.reason || 'Position sizing is unavailable under your saved risk settings.' : null;
  return {
    kind: marketReady ? 'TRADE' : focus ? 'OPPORTUNITY' : 'EMPTY_RESULT',
    label: STATUS_LABELS[scan.status],
    focus,
    trade,
    opportunity,
    showTakeTrade: marketReady,
    takeTradeEnabled: actionable && isScanFresh(scan, now) && !alreadyAccepted,
    executabilityReason,
    // The Worker rank is preserved; browser code never substitutes a trade.
    showSeparateOpportunity: Boolean(marketReady && opportunity && opportunity.scanSnapshotId !== trade?.scanSnapshotId)
  };
}
