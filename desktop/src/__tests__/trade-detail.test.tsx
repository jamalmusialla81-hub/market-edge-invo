import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import App, { Warnings } from '../App';
import { PositionTable } from '../screens/Positions';
import { TradeTable } from '../screens/Trades';
import { GivebackStats, TradeDetailView } from '../screens/TradeDetail';
import { appInfoFixture, candleSetFixture, healthFixture, positionFixture, tradeDetailFixture, tradeFixture } from './fixtures';

afterEach(() => { cleanup(); invoke.mockReset(); });

function backend(detail = () => tradeDetailFixture(), candles = () => candleSetFixture(), cf: () => unknown = () => ({ label: 'RESEARCH ONLY', trade_id: 'scan-abc-ETH', trade_status: 'OPEN', counterfactuals: {} })) {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'app_info': return appInfoFixture;
      case 'system_health': return healthFixture();
      case 'get_positions': return { positions: [{ ...positionFixture, trade_id: 'scan-abc-ETH', monitor_status: 'LIVE', price_age_s: 4 }] };
      case 'get_trades': return { trades: [{ ...tradeFixture, trade_id: 'scan-abc-ETH' }] };
      case 'get_trade_detail': return detail();
      case 'get_trade_candles': return candles();
      case 'get_exit_counterfactuals': return cf();
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
    // the same figure also appears as "Current R" in the giveback tiles, so check the tile itself
    expect(screen.getByText('Unrealized R').closest('.stat')).toHaveTextContent('0.40R');
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

describe('profit giveback (SIDE 2)', () => {
  const tile = (root: HTMLElement, label: string) => within(root).getByText(label).closest('.stat') as HTMLElement;

  it('long: peak is the highest price, giveback = MFE R - current R, distance from peak shown', () => {
    const g = tradeDetailFixture({ price: 104 }).live.giveback!;
    render(<GivebackStats g={g} open />);
    const root = screen.getByLabelText('Profit giveback');
    expect(tile(root, 'MFE (R)')).toHaveTextContent('1.10R');
    expect(tile(root, 'Current R')).toHaveTextContent('0.40R');
    expect(tile(root, 'Profit giveback (R)')).toHaveTextContent('0.70R');
    expect(tile(root, 'Profit giveback (%)')).toHaveTextContent('63.9');
    expect(tile(root, 'Highest favourable price')).toHaveTextContent(/highest price since entry \(LONG\)/);
    expect(tile(root, 'Distance from peak')).toHaveTextContent('7');
    expect(tile(root, 'Time since MFE')).toHaveTextContent(/not tracked yet/);
  });

  it('short: peak is the LOWEST price and is labelled as such', () => {
    const g = { peak_price: 90, peak_side: 'LOWEST' as const, mfe_r: 2, current_r: 1.5, current_r_basis: 'REALISED_PLUS_UNREALISED' as const,
      profit_giveback_r: 0.5, profit_giveback_pct: 25, distance_from_peak: { price: 2.5, pct: 2.78 }, time_since_mfe_s: 600, time_since_mfe_reason: null };
    render(<GivebackStats g={g} open />);
    const root = screen.getByLabelText('Profit giveback');
    expect(tile(root, 'Highest favourable price')).toHaveTextContent(/lowest price since entry \(SHORT\)/);
    expect(tile(root, 'Profit giveback (R)')).toHaveTextContent('0.50R');
    expect(tile(root, 'Profit giveback (%)')).toHaveTextContent('25');
    expect(tile(root, 'Time since MFE')).toHaveTextContent('10m');
  });

  it('closed trade shows realised R and no live distance from peak', () => {
    const g = tradeDetailFixture({ open: false }).live.giveback!;
    render(<GivebackStats g={g} open={false} />);
    const root = screen.getByLabelText('Profit giveback');
    expect(tile(root, 'Realised R')).toHaveTextContent('0.50R');
    expect(tile(root, 'Distance from peak')).toHaveTextContent('closed');
  });

  it('is rendered inside Trade Detail', async () => {
    backend();
    render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => {}} />);
    expect(await screen.findByLabelText('Profit giveback')).toBeInTheDocument();
  });
});

describe('chart polish and exit-policy overlay (#33, #32)', () => {
  it('draws MFE / PEAK and MAE markers at the right height, apart from the real markers', async () => {
    backend();
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    const mfe = container.querySelector('[data-excursion="MFE"] circle')!;
    const mae = container.querySelector('[data-excursion="MAE"] circle')!;
    expect(mfe).not.toBeNull();
    expect(Number(mfe.getAttribute('cy'))).toBeLessThan(Number(mae.getAttribute('cy')));   // 111 (best) is above 97 (worst)
    expect(container.querySelector('[data-excursion="MFE"] text')!.textContent).toBe('MFE/PEAK');
    expect(container.querySelector('[data-excursion="MFE"] title')!.textContent).toMatch(/time reached not recorded/);
    expect(container.querySelectorAll('[data-marker]')).toHaveLength(1);   // real markers untouched
    expect(container.querySelectorAll('[data-tick]').length).toBe(3);
    expect(container.querySelector('[data-current-tag]')).not.toBeNull();
  });
  it('places the MFE marker at the time it was reached when the backend knows it', async () => {
    const t0 = 1_790_000_000_000;
    backend(() => {
      const d = tradeDetailFixture();
      d.live.best_price_at_ms = t0 + 1_800_000; d.live.best_price_precision = 'CANDLE_CLOSE_BOUND';
      return d;
    });
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    expect(container.querySelector('[data-excursion="MFE"] title')!.textContent).toMatch(/CANDLE_CLOSE_BOUND/);
  });
  it('exit-policy overlay is off by default and nothing is fetched until it is switched on', async () => {
    backend(() => tradeDetailFixture({ open: false }), undefined, () => ({
      label: 'RESEARCH ONLY', trade_id: 'scan-abc-ETH', trade_status: 'CLOSED',
      counterfactuals: {
        'BREAKEVEN_V1_R0.5': { finalized: 1, status: 'EXITED', counterfactual_exit_time: 1_790_000_000_000 + 4_000_000, counterfactual_exit_price: 104.2, counterfactual_R: 0.31, reason: 'POLICY_STOP', observations: 20 },
        TIME_DECAY_V1_H12: { finalized: 1, status: 'OPEN', counterfactual_exit_time: null, counterfactual_exit_price: null, counterfactual_R: null, reason: null, observations: 20 },
      },
    }));
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    expect(container.querySelector('[data-counterfactual]')).toBeNull();
    expect(screen.queryByText(/NOT AN ACTUAL FILL/)).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('get_exit_counterfactuals', expect.anything());
    fireEvent.click(screen.getByLabelText(/SHOW EXIT-POLICY COUNTERFACTUALS/));
    expect(await screen.findByText(/NOT AN ACTUAL FILL/)).toBeInTheDocument();
    expect(await screen.findByText('BREAKEVEN_V1_R0.5')).toBeInTheDocument();
    // only the policy that exited is drawn, as its own marker type, never as a real one
    expect(container.querySelectorAll('[data-counterfactual]')).toHaveLength(1);
    expect(container.querySelector('[data-counterfactual="BREAKEVEN_V1_R0.5"] title')!.textContent).toMatch(/COUNTERFACTUAL · NOT A FILL/);
    expect(container.querySelector('[data-counterfactual]')!.getAttribute('data-marker')).toBeNull();
    expect(container.querySelectorAll('[data-marker]')).toHaveLength(3);   // ENTRY, TP1, BREAKEVEN_STOP: unchanged
    expect(screen.getByText('still open')).toBeInTheDocument();
  });
  it('shows a graceful empty state for a trade with no counterfactuals', async () => {
    backend();
    const { container } = render(<TradeDetailView tradeId="scan-abc-ETH" onBack={() => undefined} />);
    await screen.findByRole('img', { name: 'ETH LONG trade chart' });
    fireEvent.click(screen.getByLabelText(/SHOW EXIT-POLICY COUNTERFACTUALS/));
    expect(await screen.findByText(/No counterfactual records for this trade/)).toBeInTheDocument();
    expect(container.querySelector('[data-counterfactual]')).toBeNull();
  });
});
