import { api, GroupStats } from '../api';
import { CountBars, Histogram, LineChart, PolarityBars } from '../components/Charts';
import { ErrorBanner, Panel, Stat, usePoll } from '../components/ui';
import { DASH, duration, lev, num, pct, ts, tone, usd } from '../format';

const groupBars = (groups: Record<string, GroupStats> | undefined) =>
  Object.entries(groups ?? {}).map(([label, g]) => ({
    label: label === 'None' ? 'unlabelled' : label, value: g.net_realized_pnl,
    note: `${g.trades_closed}/${g.trades_opened} closed · win ${g.win_rate_pct === null ? DASH : pct(g.win_rate_pct, 0)}`,
  }));

export function PerformanceScreen() {
  const perf = usePoll(api.performance, 10000);
  const p = perf.data;
  const x = (v: number) => ts(v).slice(5, 16);
  return (
    <div className="screen">
      <ErrorBanner error={perf.error} />
      <div className="muted small">Forward PAPER results from the persistent ledger only: live scans and live prices, simulated fills. Backtests are never mixed in.{p ? ` Runtime ${duration(p.runtime_hours * 3600)}.` : ''}</div>
      <div className="stat-grid">
        <Stat label="Return" value={pct(p?.return_pct, 2, { sign: true })} tone={tone(p?.return_pct)} />
        <Stat label="Win rate" value={pct(p?.win_rate_pct, 1)} sub={p ? `${p.wins}W / ${p.losses}L` : DASH} />
        <Stat label="Expectancy" value={usd(p?.expectancy_per_trade, { sign: true })} tone={tone(p?.expectancy_per_trade)} sub="per closed trade" />
        <Stat label="Profit factor" value={num(p?.profit_factor, 2)} />
        <Stat label="Max drawdown" value={pct(p?.max_drawdown_pct)} tone={p && p.max_drawdown_pct > 0 ? 'neg' : ''} sub={usd(p?.max_drawdown)} />
        <Stat label="Average win" value={usd(p?.average_win)} tone="pos" />
        <Stat label="Average loss" value={usd(p?.average_loss)} tone="neg" />
        <Stat label="Average R" value={p?.average_r == null ? DASH : `${num(p.average_r, 2)}R`} tone={tone(p?.average_r)} />
        <Stat label="Average leverage" value={lev(p?.average_leverage)} />
        <Stat label="Max leverage" value={lev(p?.max_leverage)} />
        <Stat label="Average risk / trade" value={usd(p?.average_risk_per_trade)} sub={pct(p?.average_risk_pct_per_trade)} />
        <Stat label="Trades" value={p?.number_of_trades ?? DASH} sub={p ? `${p.trades_closed} closed` : DASH} />
      </div>
      <div className="grid-2">
        <Panel title="Equity curve">
          <LineChart label="Equity curve" area points={(p?.equity_curve ?? []).map((q) => ({ x: q.at_ms, y: q.equity }))} yFormat={(v) => usd(v)} xFormat={x} />
        </Panel>
        <Panel title="Drawdown">
          <LineChart label="Drawdown curve" color="var(--neg)" points={(p?.drawdown_curve ?? []).map((q) => ({ x: q.at_ms, y: -q.drawdown_pct }))} yFormat={(v) => pct(v)} xFormat={x} />
        </Panel>
        <Panel title="Cumulative realized PnL (net of fees)">
          <LineChart label="Cumulative PnL" zeroLine points={(p?.cumulative_pnl ?? []).map((q) => ({ x: q.at_ms, y: q.pnl }))} yFormat={(v) => usd(v)} xFormat={x} />
        </Panel>
        <Panel title="Win / loss distribution (R per closed trade)">
          <Histogram label="R distribution" values={p?.r_distribution ?? []} format={(v) => `${v.toFixed(2)}R`} />
        </Panel>
        <Panel title="By asset (net realized)"><PolarityBars label="PnL by asset" items={groupBars(p?.by_asset)} format={(v) => usd(v, { sign: true })} /></Panel>
        <Panel title="By strategy (net realized)"><PolarityBars label="PnL by strategy" items={groupBars(p?.by_strategy)} format={(v) => usd(v, { sign: true })} /></Panel>
        <Panel title="Long vs short (net realized)"><PolarityBars label="PnL by direction" items={groupBars(p?.by_direction)} format={(v) => usd(v, { sign: true })} /></Panel>
        <Panel title="Leverage distribution (approved)">
          <CountBars label="Leverage distribution" items={Object.entries(p?.leverage_distribution ?? {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => ({ label: lev(Number(k)), value: v }))} />
        </Panel>
      </div>
    </div>
  );
}
