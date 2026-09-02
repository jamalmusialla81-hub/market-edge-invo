import { hasCompleteTrade } from './marketEdgeApi.js';

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
  const actionable = scan.status === 'TRADE_READY' && hasCompleteTrade(trade);
  return {
    kind: actionable ? 'TRADE' : focus ? 'OPPORTUNITY' : 'EMPTY_RESULT',
    label: STATUS_LABELS[scan.status],
    focus,
    trade,
    opportunity,
    showTakeTrade: actionable,
    takeTradeEnabled: actionable && isScanFresh(scan, now) && !alreadyAccepted,
    // A Worker may provide a non-actionable top opportunity alongside a lower
    // actionable trade. The Worker ranking is preserved; this is display only.
    showSeparateOpportunity: Boolean(actionable && opportunity && opportunity.scanSnapshotId !== trade?.scanSnapshotId)
  };
}
