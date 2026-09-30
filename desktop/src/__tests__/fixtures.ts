// EXPLICIT TEST FIXTURES ONLY. Never imported by application code.
import type { AppInfo, CandleSet, Health, Position, SignalRow, Trade, TradeDetail } from '../api';

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
  backend: { version: '0.1.0', schema_version: 2, build: { frozen: true, python: '3.12.8', git_sha: 'abc1234def' },
    research: { shadow_schema_version: 1, supported_shadow_schema_version: 1, label_version: 'SHADOW-LABELS-V1', classification_version: 'SHADOW-CLASS-V1-DIAGNOSTIC',
      datasets_written: ['FORWARD-SHADOW-RAW-V1', 'FORWARD-SHADOW-RESOLVED-V1', 'FORWARD-PAPER-EXECUTED-V1'] } },
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

export function tradeDetailFixture(over: { open?: boolean; price?: number; monitor?: 'LIVE' | 'STALE' | 'MARKET_DATA_OFFLINE'; hindsight?: boolean } = {}): TradeDetail {
  const open = over.open ?? true;
  const p = over.price ?? 104;
  const t0 = 1_790_000_000_000;
  const exits = open ? [] : [
    { kind: 'TP1', quantity: 5, fill_price: 109.97, level: 110, pnl: 49.85, at_ms: t0 + 3_600_000, trigger: 'WS_TRADE' },
    { kind: 'BREAKEVEN_STOP', quantity: 5, fill_price: 100.0, level: 100.03, pnl: 0, at_ms: t0 + 7_200_000, trigger: 'POLL_HEARTBEAT' },
  ];
  return {
    trade_id: 'scan-abc-ETH', status: open ? 'OPEN' : 'CLOSED', is_open: open, opened_at_ms: t0, closed_at_ms: open ? null : t0 + 7_200_000,
    exit_reason: open ? null : 'BREAKEVEN_STOP',
    decision: {
      asset: 'ETH', instrument: 'ETH-PERP', coin: 'ETH', direction: 'long', entry_time_ms: t0, signal_timestamp: t0 - 5000, signal_entry: 100,
      entry_price: 100.03, mark_at_entry: 100, quantity: 10, notional: 1000.3, risk_amount: 100, requested_leverage: 1, approved_leverage: 1,
      original_stop: 90, original_tp1: 110, original_tp2: 120, original_rr1: 1, original_rr2: 2, strategy: 'TREND CONTINUATION', regime: 'UPTREND',
      quant_score: 71, ml_score: 0.61, combined_score: 72.5, rank: 1, scan_id: 'scan-abc', observation_id: null, model_version: 'm-7',
      model_status: 'SHADOW', feature_version: null, market_price_source: 'HYPERLIQUID_ALLMIDS_LIVE', market_price_timestamp: t0 - 2000,
      market_price_age_ms: 2000, execution_mode: 'PAPER', backend: 'NAUTILUS_NATIVE', execution_status: open ? 'OPEN' : 'CLOSED',
    },
    live: {
      monitor: { status: open ? (over.monitor ?? 'LIVE') : 'CLOSED', detail: over.monitor === 'MARKET_DATA_OFFLINE' ? 'allMids: HTTP 503' : null,
        price: p, price_at_ms: Date.now() - 3000, price_source: 'HYPERLIQUID_ALLMIDS_LIVE', price_age_s: over.monitor === 'STALE' ? 95 : 3, max_price_age_s: 30 },
      current_price: p, unrealized_pnl: open ? (p - 100.03) * 10 : null, unrealized_r: open ? ((p - 100.03) * 10) / 100 : null, active_stop: 90,
      distance_to_stop: open ? { price: p - 90, pct: ((p - 90) / p) * 100 } : null, distance_to_tp1: open ? { price: 110 - p, pct: ((110 - p) / p) * 100 } : null,
      distance_to_tp2: open ? { price: 120 - p, pct: ((120 - p) / p) * 100 } : null, best_price: 111, worst_price: 97,
      mfe: { price: 10.97, pct: 10.97, usd: 109.7, r: 1.1 }, mae: { price: -3.03, pct: -3.03, usd: -30.3, r: -0.3 },
      position_age_s: 5400, remaining_qty: open ? 10 : 0,
      giveback: {
        peak_price: 111, peak_side: 'HIGHEST', mfe_r: 1.1, current_r: open ? ((p - 100.03) * 10) / 100 : 0.4985,
        current_r_basis: open ? 'REALISED_PLUS_UNREALISED' : 'REALISED',
        profit_giveback_r: open ? 1.1 - ((p - 100.03) * 10) / 100 : 1.1 - 0.4985,
        profit_giveback_pct: open ? ((1.1 - ((p - 100.03) * 10) / 100) / 1.1) * 100 : ((1.1 - 0.4985) / 1.1) * 100,
        distance_from_peak: open ? { price: 111 - p, pct: ((111 - p) / 111) * 100 } : null,
        time_since_mfe_s: null, time_since_mfe_reason: 'MFE_TIMESTAMP_NOT_TRACKED',
      },
      milestones: { tp1_hit: !open, tp1_fill_timestamp: open ? null : t0 + 3_600_000, tp1_fill_price: open ? null : 109.97, remaining_quantity: open ? 10 : 0,
        stop_status: open ? 'ACTIVE' : 'HIT', tp2_status: open ? 'PENDING' : 'CANCELLED' },
    },
    levels: [
      { kind: 'ENTRY', price: 100.03, label: 'ENTRY (LONG)' }, { kind: 'STOP', price: 90, label: 'STOP (below entry, LONG)' },
      { kind: 'TP1', price: 110, label: 'TP1 (LONG)' }, { kind: 'TP2', price: 120, label: 'TP2 (LONG)' },
    ],
    markers: [
      { kind: 'ENTRY', at_ms: t0, price: 100.03, side: 'BUY', label: 'LONG ENTRY (BUY)', quantity: 10 },
      ...exits.map((e) => ({ kind: e.kind, at_ms: e.at_ms, price: e.fill_price, side: 'SELL' as const, label: `${e.kind} (SELL ${e.quantity})`, quantity: e.quantity, trigger: e.trigger })),
    ],
    exit_explanations: exits.map((e) => ({
      kind: e.kind, at_ms: e.at_ms, quantity: e.quantity, why: e.kind === 'TP1' ? 'Price reached the first target, so half the position was sold and the stop moved to breakeven.' : 'After the first target, price came back to the entry price, so the remainder was closed at breakeven.',
      level: e.level, fill_price: e.fill_price, trigger: e.trigger, seen_by: e.trigger === 'WS_TRADE' ? 'a live exchange trade print' : "the monitor's polled price",
      observed_price: e.fill_price, expected_slippage_bps: 3, actual_slippage_bps: e.kind === 'TP1' ? 3 : 5.5, difference_bps: e.kind === 'TP1' ? 0 : 2.5, friction_provenance: 'measured' as const, friction_note: null,
      overshoot_bps: e.kind === 'BREAKEVEN_STOP' ? 2 : null, overshoot_R: e.kind === 'BREAKEVEN_STOP' ? 0.02 : null, first_observed_post_stop_price: null,
      decision_latency_ms: 400, since_previous_observation_ms: 5_000, recorded: { friction: true, stop_overshoot: e.kind === 'BREAKEVEN_STOP' },
    })),
    exit_coverage: {
      MANUAL: { distinguishable: false, exists: false, note: 'No manual-close path exists.' },
      KILL_SWITCH: { distinguishable: false, exists: true, note: 'An exit while the kill switch is engaged is recorded as an ordinary exit.' },
      ADAPTIVE: { distinguishable: false, exists: false, note: 'No adaptive exit is authoritative.' },
    },
    exits, realized_pnl: open ? 0 : 49.85, fees: 1.2, net_pnl: open ? -1.2 : 48.65,
    hindsight: over.hindsight
      ? { label: 'POST-OUTCOME / HINDSIGHT - computed after the trade resolved; the live model did not know this', post_outcome: true, known_at_decision_time: false,
        available: true, reason: null, resolved_at_ms: t0 + 9_000_000, source: 'USL-shadow', levels: { optimal_entry: 98, optimal_tp1: 112.5, optimal_tp2: 125, optimal_exit: 124 } }
      : { label: 'POST-OUTCOME / HINDSIGHT', post_outcome: true, known_at_decision_time: false, available: false, reason: open ? 'OUTCOME_NOT_RESOLVED' : 'NO_RESOLVED_RESEARCH_LABEL' },
    generated_at_ms: Date.now(),
  };
}

export function candleSetFixture(n = 60): CandleSet {
  const t0 = 1_790_000_000_000 - 4 * 3_600_000;
  const candles = Array.from({ length: n }, (_, i) => ({ time: t0 + i * 300_000, open: 100 + (i % 5), high: 102 + (i % 5), low: 98 + (i % 5), close: 101 + (i % 5) - (i % 2) * 2, volume: 5, complete: i < n - 1 }));
  return { available: true, reason: null, interval: '5m', coin: 'ETH', source: 'HYPERLIQUID_CANDLESNAPSHOT', start_ms: t0, end_ms: t0 + n * 300_000, candles, intervals: ['1m', '5m', '15m', '1h'] };
}
