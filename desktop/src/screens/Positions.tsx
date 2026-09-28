import { api, Position } from '../api';
import { ErrorBanner, Panel, Table, usePoll } from '../components/ui';
import { ago, DASH, lev, pct, price, qty, tone, usd } from '../format';

export function PositionTable({ rows }: { rows: Position[] }) {
  return (
    <Table empty={rows.length ? false : 'No open positions.'}
      head={['Instrument', 'Side', 'Entry', 'Current', 'Qty', 'Leverage', 'Margin', 'Unrealized PnL', 'Stop', 'TP1', 'TP2', 'Risk', 'Liq. estimate', 'Liq. buffer', 'Backend']}>
      {rows.map((p) => (
        <tr key={p.signal_id}>
          <td><b>{p.instrument}</b>{p.tp1_hit && <span className="muted small"> · TP1 hit</span>}</td>
          <td className={p.direction === 'long' ? 'pos' : 'neg'}><b>{p.direction === 'long' ? 'LONG' : 'SHORT'}</b></td>
          <td className="num">{price(p.entry)}</td>
          <td className="num" title={`${p.mark_source}, checked ${ago(p.mark_checked_ms)}`}>{price(p.current_price)}</td>
          <td className="num">{qty(p.quantity)}</td>
          <td className="num">{lev(p.leverage)}{p.requested_leverage !== p.leverage && <span className="muted small"> (req {lev(p.requested_leverage)})</span>}</td>
          <td className="num">{usd(p.margin)}</td>
          <td className={`num ${tone(p.unrealized_pnl)}`}><b>{usd(p.unrealized_pnl, { sign: true })}</b></td>
          <td className="num neg">{price(p.stop)}</td>
          <td className="num">{price(p.tp1)}</td>
          <td className="num">{price(p.tp2)}</td>
          <td className="num">{usd(p.risk_amount)}</td>
          <td className="num">{price(p.liquidation_estimate)}</td>
          <td className="num">{p.liquidation_buffer_pct === null ? DASH : pct(p.liquidation_buffer_pct)}</td>
          <td className="small">{p.backend}</td>
        </tr>
      ))}
    </Table>
  );
}

export function Positions() {
  const positions = usePoll(api.positions, 3000);
  return (
    <div className="screen">
      <ErrorBanner error={positions.error} />
      <Panel title="Open positions" right={<span className="muted small">Current = last completed 5m candle close, updated each loop cycle</span>}>
        <PositionTable rows={positions.data?.positions ?? []} />
      </Panel>
    </div>
  );
}
