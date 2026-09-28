import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import App, { Warnings } from '../App';
import { PositionTable } from '../screens/Positions';
import { TradeTable } from '../screens/Trades';
import { TradeDetailView } from '../screens/TradeDetail';
import { appInfoFixture, candleSetFixture, healthFixture, positionFixture, tradeDetailFixture, tradeFixture } from './fixtures';

afterEach(() => { cleanup(); invoke.mockReset(); });

function backend(detail = () => tradeDetailFixture(), candles = () => candleSetFixture()) {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'app_info': return appInfoFixture;
      case 'system_health': return healthFixture();
      case 'get_positions': return { positions: [{ ...positionFixture, trade_id: 'scan-abc-ETH', monitor_status: 'LIVE', price_age_s: 4 }] };
      case 'get_trades': return { trades: [{ ...tradeFixture, trade_id: 'scan-abc-ETH' }] };
      case 'get_trade_detail': return detail();
      case 'get_trade_candles': return candles();
      default: return null;
    }
  });
}

describe('open trades are clickable', () => {
  it('rows show they are interactive and open on click or Enter', () => {
    const onOpen = vi.fn();
    render(<PositionTable rows={[{ ...positionFixture, trade_id: 'scan-abc-ETH' }]} onOpen={onOpen} />);
    const row = screen.getByText('ETH-PERP').closest('tr')!;
    expect(row).toHaveClass('clickable');
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row.getAttribute('title')).toMatch(/trade detail/i);
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith('scan-abc-ETH');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
  it('trade history rows are clickable too', () => {
    const onOpen = vi.fn();
    render(<TradeTable rows={[{ ...tradeFixture, trade_id: 'scan-abc-ETH' }]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('ETH-PERP').closest('tr')!);
    expect(onOpen).toHaveBeenCalledWith('scan-abc-ETH');
  });
  it('clicking an open trade in the app opens Trade Detail with its chart, and Back returns', async () => {
    backend();
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Positions' }));
    fireEvent.click((await screen.findByText('ETH-PERP')).closest('tr')!);
    expect(await screen.findByRole('img', { name: 'ETH LONG trade chart' })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_trade_detail', { tradeId: 'scan-abc-ETH' });
    expect(invoke).toHaveBeenCalledWith('get_trade_candles', { tradeId: 'scan-abc-ETH', interval: '5m' });
    expect(container.querySelectorAll('[data-candle]').length).toBe(60);
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    expect(await screen.findByText('ETH-PERP')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'ETH LONG trade chart' })).toBeNull();
  });
});

describe('trade detail chart', () => {
  it('shows ENTRY / STOP / TP1 / TP2 lines, the entry marker and explicit LONG labels', async () => {
    backend();
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    for (const kind of ['ENTRY', 'STOP', 'TP1', 'TP2', 'CURRENT']) expect(container.querySelector(`[data-level="${kind}"]`)).not.toBeNull();
    expect(container.querySelectorAll('[data-marker]')).toHaveLength(1);
    expect(container.querySelector('[data-marker="ENTRY"]')!.textContent).toContain('LONG ENTRY (BUY)');
    expect(screen.getByText(/STOP \(below entry, LONG\)/)).toBeInTheDocument();
    expect(screen.getByText(/LONG: stop below entry/)).toBeInTheDocument();
  });

  it('shows the live position figures', async () => {
    backend();
    render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    for (const label of ['Current price', 'Unrealized PnL', 'Unrealized R', 'Distance to stop', 'Distance to TP1', 'Distance to TP2', 'Position age']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('+$39.70')).toBeInTheDocument();
    expect(screen.getByText('0.40R')).toBeInTheDocument();
  });

  it('a closed trade shows its actual exit markers', async () => {
    backend(() => tradeDetailFixture({ open: false }));
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    expect([...container.querySelectorAll('[data-marker]')].map((m) => m.getAttribute('data-marker'))).toEqual(['ENTRY', 'TP1', 'BREAKEVEN_STOP']);
    expect(container.querySelector('[data-level="CURRENT"]')).toBeNull();
    expect(screen.getByText('Net PnL')).toBeInTheDocument();
  });

  it('an open trade chart updates without a page reload', async () => {
    let n = 0;
    backend(() => tradeDetailFixture({ price: n++ === 0 ? 104 : 107.5 }));
    render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} pollMs={30} candlePollMs={30} />);
    expect(await screen.findByText('CURRENT 104.00')).toBeInTheDocument();
    expect(await screen.findByText('CURRENT 107.50', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(invoke.mock.calls.filter(([c]) => c === 'get_trade_candles').length).toBeGreaterThan(1);
  });

  it('timeframe selection re-reads candles for that interval', async () => {
    backend();
    render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('get_trade_candles', { tradeId: 'scan-abc-ETH', interval: '1h' }));
  });

  it('unavailable candles are reported, never drawn', async () => {
    backend(undefined, () => ({ ...candleSetFixture(), available: false, reason: 'CANDLES_UNAVAILABLE: HTTP 503', candles: [] }));
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    expect(await screen.findByText(/Candles unavailable \(CANDLES_UNAVAILABLE: HTTP 503\)/)).toBeInTheDocument();
    expect(container.querySelector('[data-candle]')).toBeNull();
  });

  it('stale market data is surfaced prominently', async () => {
    backend(() => tradeDetailFixture({ monitor: 'STALE' }));
    render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    expect(await screen.findByText(/MARKET DATA STALE/)).toHaveAttribute('role', 'alert');
    expect(screen.getByText('MONITOR STALE')).toBeInTheDocument();
  });
});

describe('research / hindsight overlay', () => {
  it('is unavailable (and off) before the outcome is resolved', async () => {
    backend();
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    const toggle = await screen.findByRole('checkbox', { name: /SHOW RESEARCH OVERLAY/ });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(toggle.closest('label')!.getAttribute('title')).toMatch(/OUTCOME_NOT_RESOLVED/);
    expect(container.querySelector('[data-hindsight]')).toBeNull();
  });

  it('is off by default, clearly labelled, and kept apart from decision-time values', async () => {
    backend(() => tradeDetailFixture({ open: false, hindsight: true }));
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    const toggle = await screen.findByRole('checkbox', { name: /SHOW RESEARCH OVERLAY/ });
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();
    expect(container.querySelector('[data-hindsight]')).toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelectorAll('[data-hindsight]')).toHaveLength(4);
    expect(screen.getByText(/HINDSIGHT optimal TP1 112.50/)).toBeInTheDocument();
    const panel = screen.getByText('Research overlay — POST-OUTCOME / HINDSIGHT').closest('section')!;
    expect(within(panel).getByText(/not decision-time values/)).toBeInTheDocument();
    const decision = screen.getByText('Original decision (as recorded at entry)').closest('section')!;
    expect(within(decision).getByText('110.00')).toBeInTheDocument(); // original TP1 unchanged
    expect(within(decision).queryByText('112.50')).toBeNull();        // hindsight TP1 not in decision block
  });
});

describe('monitor warnings', () => {
  it('stale positions raise a banner', () => {
    const h = healthFixture();
    h.status = { ...h.status!, position_monitor: { state: 'ACTIVE', open_positions: 2, stale_positions: 1, max_price_age_s: 30, error: 'allMids: HTTP 503' } };
    render(<Warnings health={h} healthError={null} />);
    expect(screen.getByText(/OPEN-POSITION MONITOR: 1 of 2 open position/)).toBeInTheDocument();
  });
});
