// Deterministic contract fixtures. The BTC level data is frozen from the
// real persisted Market Edge historical chart signal ewr1-BTC-1730332800000-8cdd6d79
// (and the second BTC signal below from the same Worker chart response). These
// tests do not claim these are current/live trade recommendations.
const SOURCE_SIGNAL = Object.freeze({
  asset: 'BTC', instrument: 'BTC', direction: 'short', strategy: 'Liquidity-Sweep Reversal', current_price: 72322.91,
  entry: 72450, entry_zone: { low: 72390, high: 72450 }, stop: 72663.1937142857,
  tp1: 71710.39931428574, tp2: 71302.0588571429, rr1: 1.8, rr2: 3, setup_quality: 39,
  quant_score: 39, ml_score: null, combined_score: 39, regime: 'STRONG UPTREND', source_count: 1,
  data_quality: 'MULTI_SOURCE', scan_snapshot_id: 'ewr1-BTC-1730332800000-8cdd6d79',
  ml: { model_id: null, status: null, weight: 0 }
});

const SECOND_REAL_SIGNAL = Object.freeze({
  asset: 'BTC', instrument: 'BTC', direction: 'long', strategy: 'Trend Continuation', current_price: 80428.92,
  entry: 79447.66459435443, entry_zone: { low: 79144.52451711269, high: 80428.92 }, stop: 78054.9736681184,
  tp1: 84702.02339738687, tp2: 87550.75899564479, rr1: 1.8, rr2: 3, setup_quality: 90,
  quant_score: 90, ml_score: null, combined_score: 90, regime: 'BREAKOUT', source_count: 1,
  data_quality: 'MULTI_SOURCE', scan_snapshot_id: 'ewr1-BTC-1731283200000-3eeff1d0',
  ml: { model_id: null, status: null, weight: 0 }
});

// These values are the server quant engine's riskPlan output for SOURCE_SIGNAL
// with balance=1000, riskPct=.01, maxLeverage=10, maxExposurePct=1. They are
// contract metadata used only to exercise the client acceptance flow.
const SERVER_POSITION = Object.freeze({ notional: 1000, margin: 1000, leverage: 1, risk_amount: 10, estimated_costs: 1.6, allocation: 1 });
const NOW = 1_730_332_800_000;

function trade(source, { entryStatus, strictVerdict, reasoning, caution = null, position = null } = {}) {
  return { ...source, entry_status: entryStatus, strict_verdict: strictVerdict, reasoning, caution, position };
}
function envelope({ status, scanId, bestOpportunity, bestTradeNow, failures = [] }) {
  return { scanId, scannedAt: NOW, status, universe: { found: 177, scanned: 40, excluded: 137, dataFailures: failures.length }, dataQuality: { status: failures.length ? 'PARTIAL' : 'MULTI_SOURCE', failures }, bestOpportunity, bestTradeNow };
}

export const fixtures = Object.freeze({
  TRADE_READY: envelope({
    status: 'TRADE_READY', scanId: 'contract-ready-1',
    bestOpportunity: trade(SECOND_REAL_SIGNAL, { entryStatus: 'WAIT_FOR_ENTRY', strictVerdict: 'WAIT', reasoning: 'Frozen historical setup shown only for deterministic UI testing.', caution: 'Do not chase this historical setup.' }),
    bestTradeNow: trade(SOURCE_SIGNAL, { entryStatus: 'TRADE_READY', strictVerdict: 'TAKE TRADE', reasoning: 'Frozen historical recommendation used only for deterministic contract testing.', position: SERVER_POSITION })
  }),
  WAIT_FOR_ENTRY: envelope({ status: 'WAIT_FOR_ENTRY', scanId: 'contract-wait-1', bestOpportunity: trade(SECOND_REAL_SIGNAL, { entryStatus: 'WAIT_FOR_ENTRY', strictVerdict: 'WAIT', reasoning: 'Price is outside the valid entry zone.', caution: 'Do not chase.' }), bestTradeNow: null }),
  ENTRY_EXPIRED: envelope({ status: 'ENTRY_EXPIRED', scanId: 'contract-expired-1', bestOpportunity: trade(SOURCE_SIGNAL, { entryStatus: 'ENTRY_EXPIRED', strictVerdict: 'WAIT', reasoning: 'The entry window has passed.', caution: 'Rescan for a current setup.' }), bestTradeNow: null }),
  NO_VALID_SETUP: envelope({ status: 'NO_VALID_SETUP', scanId: 'contract-none-1', bestOpportunity: trade(SOURCE_SIGNAL, { entryStatus: 'NO_VALID_SETUP', strictVerdict: 'NO TRADE', reasoning: 'Risk checks did not produce a valid current entry.', caution: 'No current trade.' }), bestTradeNow: null }),
  DATA_UNAVAILABLE: envelope({ status: 'DATA_UNAVAILABLE', scanId: 'contract-data-1', bestOpportunity: null, bestTradeNow: null, failures: ['All feeds unavailable for BTC'] })
});

export const REAL_SIGNAL_SOURCE = SOURCE_SIGNAL;
