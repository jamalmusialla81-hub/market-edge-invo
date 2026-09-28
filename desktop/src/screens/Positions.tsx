import { api, Position } from '../api';
import { Badge, ErrorBanner, Panel, Table, usePoll } from '../components/ui';
import { ago, DASH, duration, lev, num, pct, price, qty, tone, usd } from '../format';

/** Row props that make a table row open Trade Detail (click or Enter). */
export function openRow(id: string, onOpen?: (id: string) => void) {
  if (!onOpen) return {};
  return {
    className: 'clickable', tabIndex: 0, title: 'Open trade detail', 'aria-label': `Open trade detail for ${id}`,
    onClick: () => onOpen(id),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(id); } },
  };
}

export function MonitorBadge({ p }: { p: Position }) {
  if (!p.monitor_status) return <span className="muted small">{DASH}</span>;
  const kind = p.monitor_status === 'LIVE' ? 'pos' : p.monitor_status === 'AWAITING_PRICE' ? 'warn' : 'neg';
  const age = p.price_age_s === null || p.price_age_s === undefined ? '' : ` · ${duration(p.price_age_s)}`;
  return <span title={p.monitor_detail ?? p.mark_source}><Badge kind={kind}>{p.monitor_status === 'MARKET_DATA_OFFLINE' ? 'OFFLINE' : p.monitor_status}</Badge><span className="muted small">{age}</span></span>;
}

export function PositionTable({ rows, onOpen }: { rows: Position[]; onOpen?: (id: string) => void }) {
  return (
    <Table empty={rows.length ? false : 'No open positions.'}
      head={['Instrument', 'Side', 'Entry', 'Current', 'Monitor', 'Qty', 'Leverage', 'Margin', 'Unrealized PnL', 'R', 'Stop', 'TP1', 'TP2', 'Age', 'Risk', 'Liq. estimate', 'Liq. buffer', 'Backend']}>
      {rows.map((p) => (
        <tr key={p.signal_id} {...openRow(p.trade_id ?? p.signal_id, onOpen)}>
          <td><b>{p.instrument}</b>{p.tp1_hit && <span className="muted small"> · TP1 hit</span>}</td>
          <td className={p.direction === 'long' ? 'pos' : 'neg'}><b>{p.direction === 'long' ? 'LONG' : 'SHORT'}</b></td>
          <td className="num">{price(p.entry)}</td>
          <td className="num" title={`${p.mark_source}, ${ago(p.mark_checked_ms)}`}>{price(p.current_price)}</td>
          <td className="nowrap"><MonitorBadge p={p} /></td>
          <td className="num">{qty(p.quantity)}</td>
          <td className="num">{lev(p.leverage)}{p.requested_leverage !== p.leverage && <span className="muted small"> (req {lev(p.requested_leverage)})</span>}</td>
          <td className="num">{usd(p.margin)}</td>
          <td className={`num ${tone(p.unrealized_pnl)}`}><b>{usd(p.unrealized_pnl, { sign: true })}</b></td>
          <td className={`num ${tone(p.unrealized_r)}`}>{p.unrealized_r === null || p.unrealized_r === undefined ? DASH : `${num(p.unrealized_r, 2)}R`}</td>
          <td className="num neg">{price(p.stop)}</td>
          <td className="num">{price(p.tp1)}</td>
          <td className="num">{price(p.tp2)}</td>
          <td className="num">{p.position_age_s === undefined ? DASH : duration(p.position_age_s)}</td>
          <td className="num">{usd(p.risk_amount)}</td>
          <td className="num">{price(p.liquidation_estimate)}</td>
          <td className="num">{p.liquidation_buffer_pct === null ? DASH : pct(p.liquidation_buffer_pct)}</td>
          <td className="small">{p.backend}</td>
        </tr>
      ))}
    </Table>
  );
}

export function Positions({ onOpen }: { onOpen?: (id: string) => void }) {
  const positions = usePoll(api.positions, 3000);
  return (
    <div className="screen">
      <ErrorBanner error={positions.error} />
      <Panel title="Open positions" right={<span className="muted small">Current = live price from the open-position monitor (~10s; exchange trade stream where available). Click a row for the trade chart.</span>}>
        <PositionTable rows={positions.data?.positions ?? []} onOpen={onOpen} />
      </Panel>
    </div>
  );
}
