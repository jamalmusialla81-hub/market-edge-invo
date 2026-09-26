'use strict';

// Shared domain objects for the Nautilus/Hummingbot execution architecture
// (paper-only prototype). These are plain, framework-free shapes so Market
// Edge's alpha code never imports a Nautilus or Hummingbot type directly —
// the alpha layer only ever produces/consumes these objects, which keeps the
// execution backend swappable. No network calls, no D1, no production import.
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const REQUIRED = (obj, fields) => fields.filter(field => obj?.[field] === undefined || obj?.[field] === null);

function AlphaSignal(input) {
  const missing = REQUIRED(input, ['signal_id', 'asset', 'direction', 'timestamp']);
  if (missing.length || !['long', 'short'].includes(input.direction)) {
    throw new Error(`ALPHA_SIGNAL_INVALID: missing/invalid ${missing.join(',') || 'direction'}`);
  }
  return Object.freeze({
    signal_id: String(input.signal_id), asset: String(input.asset), direction: input.direction,
    timestamp: Number(input.timestamp), entry: finite(input.entry), stop: finite(input.stop),
    targets: Array.isArray(input.targets) ? input.targets.map(finite) : [],
    quant_score: finite(input.quant_score), strategy_id: input.strategy_id ? String(input.strategy_id) : null
  });
}

function RiskDecision(input) {
  const missing = REQUIRED(input, ['signal_id', 'approved']);
  if (missing.length) throw new Error(`RISK_DECISION_INVALID: missing ${missing.join(',')}`);
  return Object.freeze({
    signal_id: String(input.signal_id), approved: Boolean(input.approved),
    approved_leverage: finite(input.approved_leverage) ?? 1, max_position_notional: finite(input.max_position_notional),
    reason: input.reason ? String(input.reason) : null
  });
}

function PortfolioDecision(input) {
  const missing = REQUIRED(input, ['signal_id', 'quantity']);
  if (missing.length) throw new Error(`PORTFOLIO_DECISION_INVALID: missing ${missing.join(',')}`);
  return Object.freeze({signal_id: String(input.signal_id), quantity: finite(input.quantity), reduce_only: Boolean(input.reduce_only)});
}

function ExecutionIntent(input) {
  const missing = REQUIRED(input, ['signal_id', 'instrument', 'side', 'quantity', 'order_type', 'strategy_id']);
  if (missing.length || !['buy', 'sell'].includes(input.side)) {
    throw new Error(`EXECUTION_INTENT_INVALID: missing/invalid ${missing.join(',') || 'side'}`);
  }
  return Object.freeze({
    signal_id: String(input.signal_id), instrument: String(input.instrument), side: input.side,
    quantity: finite(input.quantity), order_type: String(input.order_type), limit_price: finite(input.limit_price),
    stop: finite(input.stop), targets: Array.isArray(input.targets) ? input.targets.map(finite) : [],
    leverage: finite(input.leverage) ?? 1, reduce_only: Boolean(input.reduce_only),
    time_in_force: input.time_in_force ? String(input.time_in_force) : 'GTC',
    venue_preference: input.venue_preference || null, strategy_id: String(input.strategy_id)
  });
}

function ExecutionFill(input) {
  const missing = REQUIRED(input, ['signal_id', 'fill_id', 'status', 'quantity_filled']);
  if (missing.length) throw new Error(`EXECUTION_FILL_INVALID: missing ${missing.join(',')}`);
  if (!['FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED'].includes(input.status)) {
    throw new Error(`EXECUTION_FILL_INVALID: unknown status ${input.status}`);
  }
  return Object.freeze({
    signal_id: String(input.signal_id), fill_id: String(input.fill_id), status: input.status,
    quantity_filled: finite(input.quantity_filled), avg_price: finite(input.avg_price),
    fee: finite(input.fee) ?? 0, backend: String(input.backend || 'UNKNOWN'), timestamp: Number(input.timestamp) || Date.now()
  });
}

function PositionSnapshot(input) {
  const missing = REQUIRED(input, ['instrument', 'quantity']);
  if (missing.length) throw new Error(`POSITION_SNAPSHOT_INVALID: missing ${missing.join(',')}`);
  return Object.freeze({
    instrument: String(input.instrument), quantity: finite(input.quantity), avg_entry: finite(input.avg_entry),
    unrealized_pnl: finite(input.unrealized_pnl) ?? 0, realized_pnl: finite(input.realized_pnl) ?? 0,
    backend: String(input.backend || 'UNKNOWN')
  });
}

module.exports = {AlphaSignal, RiskDecision, PortfolioDecision, ExecutionIntent, ExecutionFill, PositionSnapshot};
