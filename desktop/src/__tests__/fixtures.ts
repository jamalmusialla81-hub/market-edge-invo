// EXPLICIT TEST FIXTURES ONLY. Never imported by application code.
import type { AppInfo, Health, Position, SignalRow, Trade } from '../api';

export const signalFixture: SignalRow = {
  row_id: 1, signal_id: 'scan-abc-ETH', at_ms: 1_790_000_000_000, outcome: 'EXECUTED', accepted: true, reason: null,
  asset: 'ETH', direction: 'long', strategy: 'TREND CONTINUATION', rank: 1, quant_score: 70, ml_score: 0.61,
  combined_score: 72.5, entry: 100, stop: 90, tp1: 110, tp2: 120, rr: 1, freshness_s: 12, mark_price: 100, requested_leverage: 1,
};
export const rejectedFixture: SignalRow = { ...signalFixture, row_id: 2, signal_id: 'scan-def-SOL', asset: 'SOL', direction: 'short', outcome: 'RISK_REJECTED', accepted: false, reason: 'LIQUIDATION_DISTANCE_TOO_TIGHT' };
export const positionFixture: Position = {
  signal_id: 'scan-abc-ETH', instrument: 'ETH-PERP', asset: 'ETH', direction: 'short', status: 'OPEN', strategy: 'MEAN REVERSION',
  entry: 100, current_price: 98, mark_source: 'last completed 5m candle close', mark_checked_ms: 1_790_000_000_000, quantity: 10,
  original_quantity: 10, leverage: 3, requested_leverage: 5, margin: 333.33, notional: 980, unrealized_pnl: 20, realized_pnl: 0,
  stop: 110, tp1: 90, tp2: 80, tp1_hit: false, risk_amount: 100, liquidation_estimate: 132.8, liquidation_buffer_pct: 22.8,
  backend: 'NAUTILUS_NATIVE', opened_at_ms: 1_790_000_000_000,
};
export const tradeFixture: Trade = {
  signal_id: 'scan-abc-ETH', instrument: 'ETH-PERP', asset: 'ETH', direction: 'long', status: 'CLOSED', strategy: 'TREND CONTINUATION',
  entry_at_ms: 1_790_000_000_000, exit_at_ms: 1_790_000_900_000, size: 10, leverage: 1, entry: 100, exit: 90, fees: 1.2,
  slippage: 0.4, realized_pnl: -100, net_pnl: -101.2, r_multiple: -1.012, exit_reason: 'STOP', risk_amount: 100, backend: 'NAUTILUS_NATIVE',
};
export const appInfoFixture: AppInfo = {
  mode: 'PAPER', live_trading_enabled: false, version: '0.1.0',
  modes: [
    { mode: 'BACKTEST', enabled: false, reason: 'not wired' }, { mode: 'PAPER', enabled: true, reason: null },
    { mode: 'TESTNET', enabled: false, reason: 'no backend' }, { mode: 'LIVE', enabled: false, reason: 'LIVE is disabled in this build.' },
  ],
  config: { repo_root: '/repo', python: 'python3', node: 'node', port: 8765, db_path: '/data/db', cycle_interval_ms: 300000, hummingbot_mode: 'disabled' },
};
export function healthFixture(over: { halted?: string | null; paused?: boolean; loop?: Health['forward_loop']['state'] } = {}): Health {
  return {
    components: [{ name: 'execution-service', status: 'OK', detail: 'Running' }],
    execution_service: { state: 'RUNNING', pid: 1, started_at_ms: 1, last_exit: null },
    forward_loop: { state: over.loop ?? 'STOPPED', pid: null, started_at_ms: null, last_exit: null },
    loop: { last_cycle_started_at: null, last_cycle_finished_at: null, last_outcome: null, last_reconciled: null, next_cycle_at: null, cycles_seen: 0, last_market_data_error: null, last_market_data_error_at_ms: null },
    status: { paper_only: true, execution_mode: 'PAPER', uptime_s: 5, halted: over.halted ?? null, entries_paused: over.paused ?? false, last_reconcile: null, latest_signal: null, open_positions: 0 },
    startup_error: null, mode: 'PAPER',
  };
}
