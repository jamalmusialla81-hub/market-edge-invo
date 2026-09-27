import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { Controls, ModeBar, Warnings } from '../App';
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
