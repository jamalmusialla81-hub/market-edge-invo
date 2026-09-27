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
  mode: 'PAPER', live_trading_enabled: false, version: '0.1.0', git_sha: 'abc1234def', build_timestamp: '2026-09-27T06:00:00.000Z',
  build_info: { target: 'darwin-arm64', packaging: { 'execution-service': 'PyInstaller one-folder', 'forward-loop': 'official Node.js runtime v22' } },
  backend: { version: '0.1.0', schema_version: 2, build: { frozen: true, python: '3.12.8' } },
  node_version: 'v22.22.2', data_dir: '/Users/x/Library/Application Support/Market Edge', fatal: null,
  user_config: { auto_start_paper: true, first_run_at: '2026-09-27T06:01:00.000Z', versions_seen: ['0.1.0'] },
  modes: [
    { mode: 'BACKTEST', enabled: false, reason: 'not wired' }, { mode: 'PAPER', enabled: true, reason: null },
    { mode: 'TESTNET', enabled: false, reason: 'no backend' }, { mode: 'LIVE', enabled: false, reason: 'LIVE is disabled in this build.' },
  ],
  config: {
    layout: 'BUNDLED', resource_dir: '/Applications/Market Edge.app/Contents/Resources', repo_root: null,
    execution_service: '/Applications/Market Edge.app/Contents/Resources/execution-service/market-edge-exec',
    node: '/Applications/Market Edge.app/Contents/Resources/runtime/node', forward_loop: '/Applications/Market Edge.app/Contents/Resources/signal-bridge/signal-bridge/forward_loop.mjs',
    port: 8765, db_path: '/data/db', logs_dir: '/data/logs', backups_dir: '/data/backups', cycle_interval_ms: 300000, hummingbot_mode: 'disabled',
  },
};
type LoopState = NonNullable<Health['forward_loop']>['state'];
export function healthFixture(over: { halted?: string | null; paused?: boolean; pausedReason?: string | null; loop?: LoopState; offline?: boolean; phase?: Health['startup']['phase']; gaveUp?: string | null } = {}): Health {
  return {
    components: [{ name: 'execution-service', status: 'OK', detail: 'Running' }],
    execution_service: { state: 'RUNNING', pid: 1, started_at_ms: 1, last_exit: null },
    forward_loop: { state: over.loop ?? 'STOPPED', pid: null, started_at_ms: null, last_exit: null },
    loop: { last_cycle_started_at: null, last_cycle_finished_at: null, last_outcome: null, last_reconciled: null, next_cycle_at: null, cycles_seen: 0, last_market_data_error: null, last_market_data_error_at_ms: null },
    status: { paper_only: true, execution_mode: 'PAPER', uptime_s: 5, halted: over.halted ?? null, entries_paused: over.paused ?? false, entries_paused_reason: over.pausedReason ?? null, last_reconcile: null, latest_signal: null, open_positions: 0 },
    startup_error: null, mode: 'PAPER', fatal: null,
    market: { online: over.offline ? false : true, detail: over.offline ? 'market data unreachable: connection refused' : 'Hyperliquid allMids: 200 markets', checked_at_ms: 1, offline_since_ms: over.offline ? 1 : null, last_fresh_at_ms: over.offline ? null : 1, markets: over.offline ? 0 : 200 },
    supervisor: { exec_restarts_in_window: 0, loop_restarts_in_window: 0, exec_gave_up: over.gaveUp ?? null, loop_gave_up: null, last_action: null, recovering: false, market: { online: true, detail: '', checked_at_ms: 1, offline_since_ms: null, last_fresh_at_ms: 1, markets: 200 } },
    startup: { phase: over.phase ?? 'READY', message: 'services running', first_run: { first_run: false, upgraded_from: null } },
  };
}
