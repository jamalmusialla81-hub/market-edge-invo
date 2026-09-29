import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { Controls, ModeBar, StartupScreen, Warnings } from '../App';
import { About, commitsDiffer, versionReport } from '../screens/About';
import { LogView } from '../screens/System';
import { RateLimitView } from '../screens/RateLimit';
import { SignalTable } from '../screens/Signals';
import { PositionTable } from '../screens/Positions';
import { TradeTable } from '../screens/Trades';
import { UsageRow } from '../screens/Risk';
import { ShadowDetailView, ShadowTable } from '../screens/Shadow';
import { RiskSizingPanel, TradeRiskSizingView } from '../screens/RiskSizing';
import { appInfoFixture, healthFixture, positionFixture, rejectedFixture, signalFixture, tradeFixture } from './fixtures';

afterEach(() => { cleanup(); invoke.mockReset(); });

describe('mode bar', () => {
  it('shows LIVE but never lets it be selected', () => {
    const onSelect = vi.fn();
    render(<ModeBar info={appInfoFixture} mode="PAPER" onSelect={onSelect} />);
    const live = screen.getByRole('radio', { name: /LIVE/ });
    expect(live).toBeDisabled();
    expect(live.getAttribute('title')).toMatch(/disabled/i);
    fireEvent.click(live);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'PAPER' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('controls', () => {
  it('kill switch requires typing KILL before it calls the backend', async () => {
    invoke.mockResolvedValue({ halted: true });
    const onDone = vi.fn();
    render(<Controls health={healthFixture()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'KILL SWITCH' }));
    const engage = screen.getByRole('button', { name: 'ENGAGE KILL SWITCH' });
    expect(engage).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type KILL to confirm'), { target: { value: 'kill' } });
    expect(engage).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Type KILL to confirm'), { target: { value: 'KILL' } });
    fireEvent.click(engage);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('kill_switch', { confirm: 'KILL' }));
  });

  it('when halted, RESUME goes through reconcile-and-clear confirmation', async () => {
    invoke.mockResolvedValue({});
    render(<Controls health={healthFixture({ halted: 'MANUAL_KILL_SWITCH' })} onDone={() => undefined} />);
    expect(screen.getByRole('button', { name: 'KILL SWITCH ENGAGED' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'RESUME' }));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Type CLEAR_HALT to confirm'), { target: { value: 'CLEAR_HALT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile and clear' }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('clear_halt', { confirm: 'CLEAR_HALT' }));
  });

  it('START is disabled while the loop runs; STOP only while running', () => {
    render(<Controls health={healthFixture({ loop: 'RUNNING' })} onDone={() => undefined} />);
    expect(screen.getByRole('button', { name: 'START PAPER' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'STOP PAPER' })).toBeEnabled();
    cleanup();
    render(<Controls health={healthFixture()} onDone={() => undefined} />);
    expect(screen.getByRole('button', { name: 'START PAPER' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'STOP PAPER' })).toBeDisabled();
  });

  it('controls are disabled when the execution-service is unreachable', () => {
    render(<Controls health={{ ...healthFixture(), status: null }} onDone={() => undefined} />);
    for (const name of ['START PAPER', 'RECONCILE NOW', 'PAUSE NEW ENTRIES', 'KILL SWITCH']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });
});

describe('warnings', () => {
  it('surfaces halt and pause prominently', () => {
    render(<Warnings health={healthFixture({ halted: 'RECONCILIATION_FAILED', paused: true })} healthError={null} />);
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts.some((t) => t?.includes('RECONCILIATION_FAILED'))).toBe(true);
    expect(alerts.some((t) => t?.includes('PAUSED'))).toBe(true);
  });
});

describe('tables render backend rows as given', () => {
  it('signals: accepted and rejected with reason and signal_id', () => {
    render(<SignalTable rows={[signalFixture, rejectedFixture]} />);
    expect(screen.getByText('ACCEPTED')).toBeInTheDocument();
    expect(screen.getByText('LIQUIDATION_DISTANCE_TOO_TIGHT')).toBeInTheDocument();
    expect(screen.getByText('scan-def-SOL')).toBeInTheDocument();
    expect(screen.getAllByText('72.5')).toHaveLength(2);
  });
  it('positions: side, green PnL, requested vs approved leverage', () => {
    render(<PositionTable rows={[positionFixture]} />);
    expect(screen.getByText('SHORT')).toBeInTheDocument();
    expect(screen.getByText('+$20.00').closest('td')).toHaveClass('pos');
    expect(screen.getByText('(req 5x)')).toBeInTheDocument();
  });
  it('trades: red net PnL, R multiple, exit reason', () => {
    render(<TradeTable rows={[tradeFixture]} />);
    expect(screen.getByText('-$101.20').closest('td')).toHaveClass('neg');
    expect(screen.getByText('-1.01R')).toBeInTheDocument();
    expect(screen.getByText('STOP')).toBeInTheDocument();
  });
  it('empty states say so rather than showing sample rows', () => {
    render(<><SignalTable rows={[]} /><PositionTable rows={[]} /><TradeTable rows={[]} /></>);
    expect(screen.getByText('No forward signals recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('No open positions.')).toBeInTheDocument();
    expect(screen.getByText('No paper trades yet.')).toBeInTheDocument();
  });
  it('risk usage marks a breached limit', () => {
    const { container } = render(<UsageRow u={{ key: 'drawdown_limit_pct', label: 'Drawdown', current: 16, limit: 15, unit: '%' }} />);
    expect(container.querySelector('.usage-breach')).not.toBeNull();
  });
});

describe('offline, supervision and startup', () => {
  it('market data offline: banner, no RESUME, no invented prices', () => {
    const h = healthFixture({ offline: true, paused: true, pausedReason: 'MARKET_DATA_OFFLINE' });
    render(<><Warnings health={h} healthError={null} /><Controls health={h} onDone={() => undefined} /></>);
    expect(screen.getByText(/MARKET DATA OFFLINE: no new trades/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'RESUME' })).toBeDisabled();
    expect(screen.queryByText(/New entries are PAUSED/)).toBeNull();
  });
  it('explains a supervisor pause and a service that will not be restarted', () => {
    render(<Warnings health={healthFixture({ paused: true, pausedReason: 'SUPERVISOR_RECOVERY', gaveUp: 'crashed 4 times within 10 minutes; automatic restarts stopped' })} healthError={null} />);
    expect(screen.getByText(/execution-service is DOWN: crashed 4 times/)).toBeInTheDocument();
    expect(screen.getByText(/recovering from a crash/)).toBeInTheDocument();
  });
  it('startup screen shows progress, then the error if services cannot start', () => {
    const { rerender } = render(<StartupScreen health={healthFixture({ phase: 'STARTING_SERVICE' })} info={appInfoFixture} error={null} />);
    expect(screen.getByText(/Starting the execution-service/)).toBeInTheDocument();
    const failed = { ...healthFixture({ phase: 'ERROR' }), fatal: 'installed app is incomplete; missing runtime/node' };
    rerender(<StartupScreen health={failed} info={appInfoFixture} error={null} />);
    expect(screen.getByText(/installed app is incomplete/)).toBeInTheDocument();
  });
});

describe('about and backup', () => {
  it('shows version, commit, build time, backend and schema versions', () => {
    render(<About info={appInfoFixture} />);
    expect(screen.getByText('0.1.0', { selector: 'b' })).toBeInTheDocument();
    const about = screen.getByText('About Market Edge').closest('section')!;
    expect(within(about).getByText('abc1234def')).toBeInTheDocument();
    expect(screen.getByText('2026-09-27T06:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText(/Installed app/)).toBeInTheDocument();
  });
  it('shows the research versions the backend reports, and no invented policy version', () => {
    render(<About info={appInfoFixture} />);
    const panel = screen.getByText('Versions (for bug reports)').closest('section')!;
    expect(within(panel).getByText('abc1234def')).toBeInTheDocument();   // service build commit (app commit is in About)
    expect(within(panel).queryByText('DIFFERS FROM APP COMMIT')).toBeNull();
    expect(within(panel).getByText('v1')).toBeInTheDocument();
    expect(within(panel).getByText('(this build supports v1)')).toBeInTheDocument();
    expect(within(panel).getByText('SHADOW-LABELS-V1')).toBeInTheDocument();
    expect(within(panel).getByText('SHADOW-CLASS-V1-DIAGNOSTIC')).toBeInTheDocument();
    expect(within(panel).getByText(/FORWARD-SHADOW-RAW-V1, FORWARD-SHADOW-RESOLVED-V1, FORWARD-PAPER-EXECUTED-V1/)).toBeInTheDocument();
    expect(within(panel).getByText('not versioned yet')).toBeInTheDocument();
  });
  it('flags a service built from a different commit, and handles a dev backend or missing research versions', () => {
    expect(commitsDiffer('abc1234def', 'abc1234')).toBe(false);
    expect(commitsDiffer('abc1234def', 'fff9999')).toBe(true);
    expect(commitsDiffer('abc1234def', 'dev')).toBe(false);
    const other = { ...appInfoFixture, backend: { ...appInfoFixture.backend, build: { git_sha: 'fff9999' }, research: { error: 'database is locked' } } };
    render(<About info={other} />);
    expect(screen.getByText('DIFFERS FROM APP COMMIT')).toBeInTheDocument();
    expect(screen.getByText(/Research versions unavailable: database is locked/)).toBeInTheDocument();
    cleanup();
    render(<About info={{ ...appInfoFixture, backend: { version: null, schema_version: null, build: { git_sha: 'dev' }, research: null } }} />);
    expect(screen.getByText('dev (source checkout)')).toBeInTheDocument();
    expect(screen.getByText(/appear once the execution service is running/)).toBeInTheDocument();
  });
  it('copies a plain-text version report for bug reports', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<About info={appInfoFixture} />);
    fireEvent.click(screen.getByRole('button', { name: 'COPY VERSION INFO' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toBe(versionReport(appInfoFixture));
    expect(text).toContain('App commit: abc1234def');
    expect(text).toContain('Shadow schema: v1 (supported v1)');
    expect(text).toContain('LIVE disabled');
  });
  it('import validates first and restores only after typing RESTORE', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'inspect_backup') return { path: '/tmp/b.mebackup', manifest: { format: 'market-edge-backup', format_version: 1, created_at: '2026-09-27T06:00:00Z', app_version: '0.1.0', git_sha: 'x', schema_version: 2, db_sha256: 'h', db_bytes: 1, counts: { paper_trades: 3, paper_signals: 9 }, starting_equity: 10000, secrets_included: false, contents: [] } };
      if (cmd === 'restore_backup') return { restored: '/tmp/b.mebackup', previous_database_kept_at: '/data/backups/pre-restore.sqlite3', reconciled: true };
      return null;
    });
    render(<About info={appInfoFixture} />);
    fireEvent.click(screen.getByRole('button', { name: 'IMPORT BACKUP' }));
    const confirm = await screen.findByRole('button', { name: 'Restore backup' });
    expect(screen.getByText(/3 trades, 9 signals/)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith('restore_backup', expect.anything());
    fireEvent.change(screen.getByLabelText('Type RESTORE to confirm'), { target: { value: 'RESTORE' } });
    fireEvent.click(confirm);
    expect(await screen.findByText(/Restored. Reconciliation clean/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('restore_backup', { confirm: 'RESTORE' });
  });
  it('log view reads the selected log file', async () => {
    invoke.mockImplementation(async (_cmd: string, args: { file: string }) => ({ file: args.file, path: `/data/logs/${args.file}.log`, entries: [{ seq: 1, at_ms: 1790488849670, source: 'app', level: 'INFO', event: 'reconcile', message: `line from ${args.file}` }] }));
    render(<LogView />);
    expect(await screen.findByText('line from desktop')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Log file'), { target: { value: 'reconciliation' } });
    expect(await screen.findByText('line from reconciliation')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_logs', { file: 'reconciliation', limit: 1500 });
  });
});

describe('shadow learning (research only)', () => {
  const row = {
    observation_id: 'obs-1', scan_id: 'scan-1', kind: 'CANDIDATE' as const, asset: 'ETH', direction: 'long' as const, strategy: 'TREND CONTINUATION',
    decision_ts: 1790000000000, production_rank: 2, scan_candidate_rank: 3, is_production_pick: 1, production_state: 'RANKED_WITH_GEOMETRY',
    execution_status: 'REJECTED', execution_rejection_reason: 'ENTRIES_PAUSED', research_candidate_valid: 1, invalid_reason: null,
    observation_cluster_id: 'clu-ETH-CANDIDATE-long-TREND-1790000000000', market_episode_id: 'ep-ETH-1', overlap_fraction: 0.98,
    resolution_status: 'PENDING', classification: null,
  };

  it('lists rejected candidates as tracked, with the execution reason kept separate', () => {
    const onOpen = vi.fn();
    render(<ShadowTable rows={[row, { ...row, observation_id: 'obs-2', kind: 'MARKET_STATE', direction: null, strategy: null, production_state: 'NO_TRADE', execution_status: 'NOT_APPLICABLE', execution_rejection_reason: null }]} onOpen={onOpen} />);
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
    expect(screen.getByText(/ENTRIES_PAUSED/)).toBeInTheDocument();
    expect(screen.getByText('NO-TRADE STATE')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('ETH')[0]);
    expect(onOpen).toHaveBeenCalledWith('obs-1');
  });

  it('shows no future labels before the window closes', () => {
    render(<ShadowDetailView d={{ ...row, resolution: { resolution_status: 'PENDING', batches_done: '[]', next_due_ts: 1 }, decision_hash_ok: true,
      DECISION_TIME_DATA: { market: { price: 100 }, candidate: { entry: 100, stop: 98 } }, FUTURE_LABEL_DATA: {}, POST_OUTCOME_RESEARCH_ONLY: null }} />);
    expect(screen.getByText(/No window has closed yet/)).toBeInTheDocument();
    expect(screen.getByText(/Available only after the full 72h window/)).toBeInTheDocument();
    expect(screen.getByText('hash verified')).toBeInTheDocument();
  });

  it('labels hindsight as POST-OUTCOME RESEARCH ONLY, never as a prediction', () => {
    render(<ShadowDetailView d={{ ...row, resolution: null, decision_hash_ok: true, DECISION_TIME_DATA: { market: { price: 100 } },
      FUTURE_LABEL_DATA: { B1: { label_status: 'OK', window_end_ts: 1, label_hash_ok: true, labels: { '1h': { label_status: 'OK', mfe_pct: 0.02, mae_pct: 0.01, stop_hit: false, tp1_hit: true, tp2_hit: false, first_touch_order: 'TP1', policy_r: 0.8 } } } },
      POST_OUTCOME_RESEARCH_ONLY: { notice: 'Hindsight labels describe what the market offered after the fact. They are not predictions and are never model features.', classification: 'GOOD_TRADE_MISSED',
        current_policy_outcome_r: 0.8, executable_within_stop_r: 1.6, strategy_efficiency: 0.5, best_direction: 'long', optimal_long_net_pct: 0.03, optimal_short_net_pct: 0, theoretical_long_move_pct: 0.04, theoretical_short_move_pct: 0.01, optimal_entry: 99, optimal_exit: 102 } }} />);
    expect(screen.getByText('POST-OUTCOME RESEARCH ONLY')).toBeInTheDocument();
    expect(screen.getByText(/They are not predictions/)).toBeInTheDocument();
    expect(screen.getByText('GOOD_TRADE_MISSED')).toBeInTheDocument();
    expect(screen.getByText(/unvalidated; not a training target/)).toBeInTheDocument();
    expect(screen.getAllByText('0.80R')).toHaveLength(2);   // horizon policy R and the current-policy result
  });
});

describe('risk sizing V2', () => {
  const status = {
    mode: 'SHADOW' as const, kelly: 'OFF' as const, live: 'DISABLED' as const, sizing_rule_version: 'RISK-SIZING-V2.0',
    policy: { base_risk_pct: 0.005, max_position_notional_pct: 0.05, max_portfolio_gross_pct: 0.2, max_open_planned_risk_pct: 0.02,
      max_cluster_planned_risk_pct: 0.01, max_positions: 4, max_leverage: 1, execution_buffer_floor_pct: 0.0025, max_expected_entry_slippage_bps: 25, dd_pause_pct: 0.15 },
    equity: 10000, peak_equity: 10000, drawdown_pct: 0, drawdown_multiplier: 1, drawdown_pause: false, base_risk_pct: 0.005,
    effective_risk_pct_before_vol: 0.005, open_planned_risk_dollars: 50, open_planned_risk_pct: 0.005,
    cluster_planned_risk: { L1_PLATFORMS: { dollars: 50, pct: 0.005 } }, gross_exposure_dollars: 488, gross_exposure_multiple: 0.0488, open_positions: 1,
    positions: [{ signal_id: 's1', asset: 'SOL', direction: 'long', notional: 488, notional_pct_equity: 0.0488, planned_loss_dollars: 50,
      planned_loss_pct_equity: 0.005, original_planned_loss_dollars: 50, stop_distance_pct: 0.1, active_stop: 90, cluster_id: 'L1_PLATFORMS',
      binding_constraint: 'RISK_BUDGET', sizing_rule_version: 'RISK-SIZING-V2.0', position_leverage: 1 }],
  };

  it('shows the policy, the mode and gross exposure separately from position leverage', () => {
    render(<RiskSizingPanel s={status} />);
    expect(screen.getByText('MODE SHADOW')).toBeInTheDocument();
    expect(screen.getByText('KELLY OFF')).toBeInTheDocument();
    expect(screen.getByText('Base risk / trade').parentElement).toHaveTextContent('0.50%');
    expect(screen.getByText('Max position notional').parentElement).toHaveTextContent('5%');
    expect(screen.getByText('Max open planned risk').parentElement).toHaveTextContent('2%');
    expect(screen.getByText('Gross exposure').parentElement).toHaveTextContent('0.05x');
    expect(screen.getByText(/ceiling, never a target/)).toBeInTheDocument();
    expect(screen.getByText(/open notional — not leverage/)).toBeInTheDocument();
    expect(screen.getByText('Position leverage')).toBeInTheDocument();
    expect(screen.getByText('RISK_BUDGET')).toBeInTheDocument();
  });

  it('shows DRAWDOWN_RISK_PAUSE', () => {
    render(<RiskSizingPanel s={{ ...status, drawdown_pct: 0.16, drawdown_multiplier: null, drawdown_pause: true }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('DRAWDOWN_RISK_PAUSE');
  });

  it('never presents counterfactual sizing as the executed quantity', () => {
    const rec = (over: Record<string, unknown>) => ({ decision_id: String(over.id), mode: 'SHADOW', policy_version: String(over.v), approved: true, reason: null,
      created_at_ms: 1790000000000, record_hash_ok: true, role: over.role as 'AUTHORITATIVE' | 'COUNTERFACTUAL',
      record: { sizing_rule_version: String(over.v), approved: true, final_notional: over.n as number, final_quantity: over.q as number, wallet_equity: 10000, sizing_binding_constraint: 'RISK_BUDGET' } });
    render(<TradeRiskSizingView s={{ mode: 'SHADOW', executed_quantity: 10, current_risk: null, outcome: null, note: null,
      executed: rec({ id: 'a', v: 'RISK-V1-LEGACY', role: 'AUTHORITATIVE', n: 1000, q: 10 }),
      counterfactual: [rec({ id: 'b', v: 'RISK-SIZING-V2.0', role: 'COUNTERFACTUAL', n: 488, q: 4.88 })] }} />);
    expect(screen.getByText('COUNTERFACTUAL RISK SIZING')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/RESEARCH ONLY · NOT USED FOR EXECUTION/);
    expect(screen.getByText(/this is the size actually used/)).toHaveTextContent('Executed quantity 10');
  });
});

describe('rate-limit panel (#30)', () => {
  const budget = (over: Record<string, unknown> = {}) => ({
    schema: 'rate-limit-health/v1', host: 'https://api.hyperliquid.xyz/info', at_ms: 1_000_000, received_at_ms: 1_000_000, state: 'OK' as const,
    cooldown_until_ms: null, consecutive_429: 0, last_retry_after_ms: null, weight_used_last_60s: 120, weight_limit_per_min: 600,
    pacing: 'WEIGHT_BUDGET', hyperliquid_limit_per_min: 1200, in_flight: 1, queue_depth: 3,
    queue_depth_by_priority: { P0_POSITION_MONITOR: 0, P2_DISCOVERY: 3 },
    by_priority: { P0_POSITION_MONITOR: { started: 50, deferred: 0, waited_ms: 0 }, P2_DISCOVERY: { started: 20, deferred: 4, waited_ms: 8000 } },
    endpoints: { allMids: { requests: 70, ok: 68, errors: 0, http_429: 2, last_429_at_ms: 900_000, deduplicated: 5, deferred: 4, retry_after_seen: 1 } },
    totals: { requests: 70, http_429: 2, deduplicated: 5, deferred: 4, last_429_at_ms: 900_000, last_ok_at_ms: 999_000 }, ...over,
  });
  const diag = (node: ReturnType<typeof budget> | null, over: Record<string, unknown> = {}) => ({
    schema: 'rate-limit-diagnostics/v1', node_budget: node, node_budget_age_s: node ? 4 : null,
    chart_candles: { schema: 'rate-limit-health/v1', source: 'x', priority: 'P5_CHART_HISTORY', state: 'OK' as const, backoff_remaining_s: 0, consecutive_429: 0, cached_series: 2, http_429: 0, deferred: 0 },
    priorities: ['P0_POSITION_MONITOR', 'P1_RECONCILIATION', 'P2_DISCOVERY', 'P3_SHADOW_CAPTURE', 'P4_SHADOW_RESOLUTION', 'P5_CHART_HISTORY'], ...over,
  });
  it('shows counts, tiers, endpoints and websocket state in the normal case', () => {
    render(<RateLimitView data={diag(budget())} error={null} monitor={{ state: 'LIVE', ws_state: 'CONNECTED', open_positions: 1, stale_positions: 0, max_price_age_s: 30 }} nowMs={1_000_000} />);
    expect(screen.getAllByText('OK').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('P2 discovery')).toBeInTheDocument();
    expect(screen.getByText('allMids')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('120 / 600')).toBeInTheDocument();
  });
  it('shows the backoff clearly while backing off', () => {
    const b = budget({ state: 'BACKOFF', cooldown_until_ms: 1_030_000, consecutive_429: 3, last_retry_after_ms: 30_000 });
    render(<RateLimitView data={diag(b)} error={null} nowMs={1_000_000} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Backing off after HTTP 429/);
    expect(screen.getByText('BACKOFF')).toBeInTheDocument();
  });
  it('says so, without crashing, when the endpoint is unavailable or nothing was reported yet', () => {
    render(<RateLimitView data={null} error="404 not found" />);
    expect(screen.getByText(/No rate-limit data: 404 not found/)).toBeInTheDocument();
    cleanup();
    render(<RateLimitView data={diag(null)} error={null} />);
    expect(screen.getByText(/has not reported a request budget yet/)).toBeInTheDocument();
    expect(screen.getByText('NO REPORT YET')).toBeInTheDocument();
  });
});
