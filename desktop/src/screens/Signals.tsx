import { useState } from 'react';
import { api, SignalRow } from '../api';
import { Badge, ErrorBanner, Panel, Table, usePoll } from '../components/ui';
import { DASH, duration, num, price, ts } from '../format';

type Filter = 'all' | 'accepted' | 'rejected' | 'no_trade';

export function outcomeBadge(row: SignalRow) {
  if (row.accepted) return <Badge kind="pos">ACCEPTED</Badge>;
  if (row.outcome === 'NO_TRADE') return <Badge>NO TRADE</Badge>;
  return <Badge kind="warn">{row.outcome.replace('_', ' ')}</Badge>;
}

export function SignalTable({ rows }: { rows: SignalRow[] }) {
  return (
    <Table empty={rows.length ? false : 'No forward signals recorded yet.'}
      head={['Time', 'Asset', 'Dir', 'Rank', 'Strategy', 'Quant', 'Combined', 'Entry', 'Stop', 'TP1', 'TP2', 'RR', 'Fresh', 'Decision', 'Reason', 'signal_id']}>
      {rows.map((r) => (
        <tr key={r.row_id}>
          <td className="nowrap">{ts(r.at_ms)}</td>
          <td><b>{r.asset ?? DASH}</b></td>
          <td className={r.direction === 'long' ? 'pos' : r.direction === 'short' ? 'neg' : ''}>{r.direction?.toUpperCase() ?? DASH}</td>
          <td className="num">{r.rank ?? DASH}</td>
          <td>{r.strategy ?? DASH}</td>
          <td className="num">{num(r.quant_score, 1)}</td>
          <td className="num">{num(r.combined_score, 1)}</td>
          <td className="num">{price(r.entry)}</td>
          <td className="num">{price(r.stop)}</td>
          <td className="num">{price(r.tp1)}</td>
          <td className="num">{price(r.tp2)}</td>
          <td className="num">{num(r.rr, 2)}</td>
          <td className="num" title="signal age when the execution-service evaluated it">{r.freshness_s === null ? DASH : duration(r.freshness_s)}</td>
          <td>{outcomeBadge(r)}</td>
          <td className="reason">{r.reason ?? DASH}</td>
          <td className="mono small">{r.signal_id ?? DASH}</td>
        </tr>
      ))}
    </Table>
  );
}

export function Signals() {
  const signals = usePoll(() => api.signals(1000), 5000);
  const [filter, setFilter] = useState<Filter>('all');
  const rows = (signals.data?.signals ?? []).filter((r) =>
    filter === 'all' ? true : filter === 'accepted' ? r.accepted : filter === 'no_trade' ? r.outcome === 'NO_TRADE' : !r.accepted && r.outcome !== 'NO_TRADE');
  const counts = (signals.data?.signals ?? []).reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  return (
    <div className="screen">
      <ErrorBanner error={signals.error} />
      <Panel title="Forward signals" right={
        <div className="seg">
          {(['all', 'accepted', 'rejected', 'no_trade'] as Filter[]).map((f) => (
            <button key={f} className={`seg-btn ${f === filter ? 'active' : ''}`} onClick={() => setFilter(f)}>{f.replace('_', ' ')}</button>
          ))}
        </div>}>
        <div className="muted small legend-row">
          {Object.entries(counts).map(([k, v]) => <span key={k}>{k}: {v}</span>)}
          <span>Rank #1 Best Trade Now from the live Market Edge scan; scores are display-only and never size a trade.</span>
        </div>
        <SignalTable rows={rows} />
      </Panel>
    </div>
  );
}
