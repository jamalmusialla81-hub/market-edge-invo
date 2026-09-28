import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import App from '../App';
import { Dashboard } from '../screens/Dashboard';
import { TradeDetailView } from '../screens/TradeDetail';
import { appInfoFixture, candleSetFixture, healthFixture, positionFixture, tradeDetailFixture, tradeFixture } from './fixtures';

afterEach(() => { cleanup(); invoke.mockReset(); vi.useRealTimers(); });

const account = (over: Record<string, number> = {}) => ({
  equity: 10_000, starting_equity: 10_000, total_pnl: 0, daily_pnl: 0, realized_pnl: 0, unrealized_pnl: 0, fees: 0, drawdown_pct: 0,
  open_notional: 981, exposure_pct: 9.81, effective_leverage: 0.0981, gross_exposure_multiple: 0.0981, open_positions: 1, execution_mode: 'PAPER', ...over,
});

function backend({ acct = () => account(), detail = () => tradeDetailFixture() } = {}) {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'app_info': return appInfoFixture;
      case 'system_health': return healthFixture();
      case 'get_account': return acct();
      case 'get_performance': return { equity_curve: [], max_drawdown_pct: 0 };
      case 'get_positions': return { positions: [{ ...positionFixture, trade_id: 'scan-abc-ETH', monitor_status: 'LIVE', price_age_s: 4 }] };
      case 'get_trades': return { trades: [{ ...tradeFixture, trade_id: 'scan-abc-ETH' }] };
      case 'get_trade_detail': return detail();
      case 'get_trade_candles': return candleSetFixture();
      default: return null;
    }
  });
}

describe('dashboard exposure terminology', () => {
  it('labels open notional / equity as GROSS EXPOSURE, never as leverage', async () => {
    backend();
    render(<Dashboard health={healthFixture()} />);
    expect(await screen.findByText('Gross exposure')).toBeInTheDocument();
    expect(await screen.findByText('0.10x')).toBeInTheDocument();
    expect(screen.getByText(/9\.81% of equity/)).toBeInTheDocument();
    expect(screen.queryByText('Leverage')).toBeNull();
  });

  it('open-position values refresh on their own ~3s poll, independent of the 5m discovery scan', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let unrealized = 5;
    backend({ acct: () => account({ unrealized_pnl: unrealized }) });
    render(<Dashboard health={healthFixture()} />);
    expect(await screen.findByText('+$5.00')).toBeInTheDocument();
    unrealized = 12.5;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(await screen.findByText('+$12.50')).toBeInTheDocument();
    // no discovery call is involved in the refresh
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('start_paper');
  });
});

describe('Trade Detail entry points', () => {
  it('opens from a Dashboard open-position row', async () => {
    backend();
    render(<App />);
    fireEvent.click((await screen.findAllByText('ETH'))[0].closest('tr')!);
    expect(await screen.findByRole('img', { name: 'ETH LONG trade chart' })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_trade_detail', { tradeId: 'scan-abc-ETH' });
  });

  it('opens from Trade History, and Escape returns', async () => {
    backend();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Trades' }));
    fireEvent.click((await screen.findByText('ETH-PERP')).closest('tr')!);
    expect(await screen.findByRole('img', { name: 'ETH LONG trade chart' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('img', { name: 'ETH LONG trade chart' })).toBeNull();
  });
});

describe('shadow link on Trade Detail', () => {
  it('shows the linked observation id and resolution progress', async () => {
    backend({ detail: () => ({ ...tradeDetailFixture(), shadow: { linked: true, observation_id: 'obs-123abc', scan_id: 'scan-link',
      resolution_status: 'PARTIAL', next_due_ts: null, resolved_horizons: ['15m', '30m', '1h', '2h'], unresolvable_horizons: [],
      pending_horizons: ['4h', '6h', '12h', '24h', '48h', '72h'], post_outcome_available: false } }) });
    render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    expect(await screen.findByText('Shadow learning link (research only)')).toBeInTheDocument();
    expect(screen.getAllByText('obs-123abc').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('15m · 30m · 1h · 2h')).toBeInTheDocument();
    expect(screen.getByText('4h · 6h · 12h · 24h · 48h · 72h')).toBeInTheDocument();
  });

  it('says plainly when a trade has no shadow observation', async () => {
    backend({ detail: () => ({ ...tradeDetailFixture(), shadow: { linked: false, reason: 'NO_SHADOW_OBSERVATION_FOR_THIS_SIGNAL' } }) });
    render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    expect(await screen.findByText(/Not linked to a shadow observation \(NO_SHADOW_OBSERVATION_FOR_THIS_SIGNAL\)/)).toBeInTheDocument();
  });
});
