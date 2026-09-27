// The only way the UI talks to the trading stack: Tauri IPC commands handled
// by the Rust controller (src-tauri/src/lib.rs). No fetch() to the service, no
// database access, no API key in the webview.
import { invoke } from '@tauri-apps/api/core';

export type Mode = 'BACKTEST' | 'PAPER' | 'TESTNET' | 'LIVE';
export type Level = 'INFO' | 'WARN' | 'ERROR' | 'RISK' | 'EXECUTION';
export type ComponentStatus = 'OK' | 'WARN' | 'DOWN' | 'DISABLED' | 'STARTING';

export interface ModeAvailability { mode: Mode; enabled: boolean; reason: string | null }
export interface AppInfo {
  mode: Mode; modes: ModeAvailability[]; live_trading_enabled: boolean; version: string;
  config: { repo_root: string | null; python: string; node: string; port: number; db_path: string; cycle_interval_ms: number; hummingbot_mode: string };
}
export interface ProcStatus { state: 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ADOPTED' | 'FAILED'; pid: number | null; started_at_ms: number | null; last_exit: string | null }
export interface LoopTelemetry {
  last_cycle_started_at: string | null; last_cycle_finished_at: string | null; last_outcome: string | null;
  last_reconciled: boolean | null; next_cycle_at: string | null; cycles_seen: number;
  last_market_data_error: string | null; last_market_data_error_at_ms: number | null;
}
export interface HealthComponent { name: string; status: ComponentStatus; detail: string }
export interface SystemStatus {
  paper_only: boolean; execution_mode: string; uptime_s: number; halted: string | null; entries_paused: boolean;
  last_reconcile: ({ reconciled: boolean; at: number } & Record<string, unknown>) | null;
  latest_signal: SignalRow | null; open_positions: number;
}
export interface Health {
  components: HealthComponent[]; execution_service: ProcStatus; forward_loop: ProcStatus; loop: LoopTelemetry;
  status: SystemStatus | null; startup_error: string | null; mode: Mode;
}
export interface Account {
  starting_equity: number; equity: number; balance: number; realized_pnl: number; unrealized_pnl: number; fees: number;
  slippage_cost: number; open_positions: number; open_notional: number; daily_pnl: number; peak_equity: number;
  total_pnl: number; drawdown_pct: number; exposure_pct: number | null; effective_leverage: number | null; execution_mode: string;
}
export interface SignalRow {
  row_id: number; signal_id: string | null; at_ms: number; outcome: string; accepted: boolean; reason: string | null;
  asset: string | null; direction: 'long' | 'short' | null; strategy: string | null; rank: number | null;
  quant_score: number | null; ml_score: number | null; combined_score: number | null; entry: number | null; stop: number | null;
  tp1: number | null; tp2: number | null; rr: number | null; freshness_s: number | null; mark_price: number | null;
  requested_leverage: number | null;
}
export interface Position {
  signal_id: string; instrument: string; asset: string; direction: 'long' | 'short'; status: string; strategy: string | null;
  entry: number; current_price: number; mark_source: string; mark_checked_ms: number | null; quantity: number;
  original_quantity: number; leverage: number; requested_leverage: number; margin: number; notional: number;
  unrealized_pnl: number; realized_pnl: number; stop: number; tp1: number | null; tp2: number | null; tp1_hit: boolean;
  risk_amount: number; liquidation_estimate: number | null; liquidation_buffer_pct: number | null; backend: string; opened_at_ms: number;
}
export interface Trade {
  signal_id: string; instrument: string; asset: string; direction: 'long' | 'short'; status: string; strategy: string | null;
  entry_at_ms: number; exit_at_ms: number | null; size: number; leverage: number; entry: number; exit: number | null;
  fees: number; slippage: number; realized_pnl: number; net_pnl: number; r_multiple: number | null; exit_reason: string | null;
  risk_amount: number; backend: string;
}
export interface GroupStats { trades_opened: number; trades_closed: number; wins: number; losses: number; win_rate_pct: number | null; net_realized_pnl: number }
export interface Performance {
  starting_equity: number; ending_equity: number; return_pct: number; win_rate_pct: number | null; expectancy_per_trade: number | null;
  expectancy_r: number | null; profit_factor: number | null; max_drawdown: number; max_drawdown_pct: number;
  average_win: number | null; average_loss: number | null; average_r: number | null; average_leverage: number | null;
  max_leverage: number | null; average_risk_per_trade: number | null; average_risk_pct_per_trade: number | null;
  number_of_trades: number; trades_closed: number; wins: number; losses: number; realized_pnl: number; unrealized_pnl: number; fees: number;
  equity_curve: { at_ms: number; equity: number }[]; drawdown_curve: { at_ms: number; drawdown_pct: number }[];
  cumulative_pnl: { at_ms: number; pnl: number }[]; r_distribution: number[]; pnl_distribution: number[];
  by_asset: Record<string, GroupStats>; by_strategy: Record<string, GroupStats>; by_direction: Record<string, GroupStats>;
  leverage_distribution: Record<string, number>; runtime_hours: number; halted: string | null;
}
export interface RiskConfig { settings: Record<string, number>; bounds: Record<string, [number, number]>; starting_equity: number; starting_equity_editable: boolean }
export interface RiskUsage { key: string; label: string; current: number | null; limit: number; unit: string; floor?: boolean }
export interface LogEntry { seq: number; at_ms: number; source: string; level: Level; event: string | null; message: string }
export interface SecretsStatus {
  store: string; secrets: { name: string; configured: boolean; error: string | null }[];
  service_api_key: { persisted: boolean; store: string; warning: string | null };
}

export const api = {
  appInfo: () => invoke<AppInfo>('app_info'),
  health: () => invoke<Health>('system_health'),
  account: () => invoke<Account>('get_account'),
  positions: () => invoke<{ positions: Position[] }>('get_positions'),
  trades: () => invoke<{ trades: Trade[] }>('get_trades'),
  signals: (limit = 500) => invoke<{ signals: SignalRow[] }>('get_signals', { limit }),
  performance: () => invoke<Performance>('get_performance'),
  riskConfig: () => invoke<RiskConfig>('get_risk_config'),
  riskUsage: () => invoke<{ usage: RiskUsage[] }>('get_risk_usage'),
  updateRiskConfig: (update: Record<string, number>) => invoke<RiskConfig>('update_risk_config', { update }),
  logs: (afterSeq = 0, limit = 1000) => invoke<LogEntry[]>('get_logs', { afterSeq, limit }),
  startPaper: () => invoke<ProcStatus>('start_paper'),
  stopPaper: () => invoke<ProcStatus>('stop_paper'),
  reconcile: () => invoke<Record<string, unknown>>('reconcile_now'),
  pause: () => invoke('pause_entries'),
  resume: () => invoke<{ entries_paused: boolean; halted: string | null }>('resume_entries'),
  killSwitch: (confirm: string) => invoke('kill_switch', { confirm }),
  clearHalt: (confirm: string) => invoke('clear_halt', { confirm }),
  restartServices: () => invoke<ProcStatus>('restart_services'),
  setMode: (mode: Mode) => invoke<Mode>('set_mode', { mode }),
  secretsStatus: () => invoke<SecretsStatus>('secrets_status'),
  setSecret: (name: string, value: string) => invoke<SecretsStatus>('set_secret', { name, value }),
  deleteSecret: (name: string) => invoke<SecretsStatus>('delete_secret', { name }),
};

export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
