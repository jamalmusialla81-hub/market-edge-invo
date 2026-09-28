import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { Controls, ModeBar, StartupScreen, Warnings } from '../App';
import { About } from '../screens/About';
import { LogView } from '../screens/System';
import { SignalTable } from '../screens/Signals';
import { PositionTable } from '../screens/Positions';
import { TradeTable } from '../screens/Trades';
import { UsageRow } from '../screens/Risk';
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
    expect(screen.getByText('abc1234def')).toBeInTheDocument();
    expect(screen.getByText('2026-09-27T06:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText(/Installed app/)).toBeInTheDocument();
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
