import { api, Trade } from '../api';
import { Badge, ErrorBanner, Panel, Table, usePoll } from '../components/ui';
import { DASH, lev, num, price, qty, ts, tone, usd } from '../format';

export function TradeTable({ rows }: { rows: Trade[] }) {
  return (
    <Table empty={rows.length ? false : 'No paper trades yet.'}
      head={['Entry time', 'Exit time', 'Instrument', 'Dir', 'Size', 'Lev', 'Entry', 'Exit', 'Fees', 'Slippage', 'Net PnL', 'R', 'Exit reason', 'Strategy', 'signal_id']}>
      {rows.map((t) => (
        <tr key={t.signal_id}>
          <td className="nowrap">{ts(t.entry_at_ms)}</td>
          <td className="nowrap">{t.exit_at_ms ? ts(t.exit_at_ms) : <Badge kind="info">{t.status}</Badge>}</td>
          <td><b>{t.instrument}</b></td>
          <td className={t.direction === 'long' ? 'pos' : 'neg'}>{t.direction.toUpperCase()}</td>
          <td className="num">{qty(t.size)}</td>
          <td className="num">{lev(t.leverage)}</td>
          <td className="num">{price(t.entry)}</td>
          <td className="num">{price(t.exit)}</td>
          <td className="num">{usd(t.fees)}</td>
          <td className="num">{usd(t.slippage)}</td>
          <td className={`num ${tone(t.net_pnl)}`}><b>{usd(t.net_pnl, { sign: true })}</b></td>
          <td className={`num ${tone(t.r_multiple)}`}>{t.r_multiple === null ? DASH : `${num(t.r_multiple, 2)}R`}</td>
          <td>{t.exit_reason ?? DASH}</td>
          <td>{t.strategy ?? DASH}</td>
          <td className="mono small">{t.signal_id}</td>
        </tr>
      ))}
    </Table>
  );
}

export function Trades() {
  const trades = usePoll(api.trades, 5000);
  const rows = trades.data?.trades ?? [];
  return (
    <div className="screen">
      <ErrorBanner error={trades.error} />
      <Panel title={`Trade history (${rows.length})`} right={<span className="muted small">Net PnL = realized − fees. Exit = quantity-weighted average of partial exits.</span>}>
        <TradeTable rows={rows} />
      </Panel>
    </div>
  );
}
