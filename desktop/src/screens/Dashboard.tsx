import { api, Health } from '../api';
import { LineChart } from '../components/Charts';
import { Badge, Dot, ErrorBanner, Panel, Stat, usePoll } from '../components/ui';
import { ago, DASH, lev, pct, price, ts, tone, usd } from '../format';

const isoMs = (s: string | null | undefined) => (s ? Date.parse(s) : null);

export function Dashboard({ health }: { health: Health | null }) {
  const account = usePoll(api.account, 3000);
  const positions = usePoll(api.positions, 5000);
  const perf = usePoll(api.performance, 15000);
  const a = account.data;
  const s = health?.status;
  const latest = s?.latest_signal;
  const loop = health?.loop;
  const reconcile = s?.last_reconcile;

  return (
    <div className="screen">
      <ErrorBanner error={account.error} />
      <div className="stat-grid">
        <Stat big label="Current equity" value={usd(a?.equity)} sub={a ? <>start {usd(a.starting_equity)}</> : DASH} />
        <Stat big label="Total PnL" value={usd(a?.total_pnl, { sign: true })} tone={tone(a?.total_pnl)}
          sub={a ? pct((a.total_pnl / a.starting_equity) * 100, 2, { sign: true }) : DASH} />
        <Stat big label="Daily PnL" value={usd(a?.daily_pnl, { sign: true })} tone={tone(a?.daily_pnl)} sub="since 00:00 UTC, net of fees" />
        <Stat label="Realized PnL" value={usd(a?.realized_pnl, { sign: true })} tone={tone(a?.realized_pnl)} sub={a ? <>fees {usd(a.fees)}</> : DASH} />
        <Stat label="Unrealized PnL" value={usd(a?.unrealized_pnl, { sign: true })} tone={tone(a?.unrealized_pnl)} sub="marked at last 5m close" />
        <Stat label="Max drawdown" value={pct(perf.data?.max_drawdown_pct)} tone={perf.data && perf.data.max_drawdown_pct > 0 ? 'neg' : ''} sub={a ? <>current {pct(a.drawdown_pct)}</> : DASH} />
        <Stat label="Exposure" value={pct(a?.exposure_pct)} sub={a ? <>{usd(a.open_notional)} notional</> : DASH} />
        <Stat label="Leverage" value={lev(a?.effective_leverage ?? null)} sub="open notional / equity" />
        <Stat label="Open positions" value={a?.open_positions ?? DASH} />
        <Stat label="Execution mode" value={<span className="mode-inline">{health?.mode ?? 'PAPER'}</span>} sub="LIVE disabled" />
      </div>

      <div className="grid-2">
        <Panel title="Equity">
          <LineChart label="Equity curve" area points={(perf.data?.equity_curve ?? []).map((p) => ({ x: p.at_ms, y: p.equity }))}
            yFormat={(v) => usd(v)} xFormat={(v) => ts(v).slice(5, 16)} />
        </Panel>
        <Panel title="Status">
          <dl className="kv">
            <dt>System</dt><dd>{health ? health.components.map((c) => <span key={c.name} className="kv-chip" title={c.detail}><Dot status={c.status} />{c.name}</span>) : DASH}</dd>
            <dt>Kill switch</dt><dd>{s?.halted ? <Badge kind="neg">ENGAGED · {s.halted}</Badge> : <Badge kind="pos">OFF</Badge>}</dd>
            <dt>New entries</dt><dd>{s?.entries_paused ? <Badge kind="warn">PAUSED</Badge> : <Badge kind="pos">ALLOWED</Badge>}</dd>
            <dt>Reconciliation</dt><dd>{reconcile ? (reconcile.reconciled ? <Badge kind="pos">RECONCILED</Badge> : <Badge kind="neg">FAILED</Badge>) : <Badge>NOT RUN</Badge>} {reconcile && <span className="muted">{ago(reconcile.at * 1000)}</span>}</dd>
            <dt>Forward loop</dt><dd>{health?.forward_loop.state ?? DASH} {loop?.last_outcome && <span className="muted">· last cycle {loop.last_outcome}</span>}</dd>
            <dt>Last scan</dt><dd>{loop?.last_cycle_started_at ? <>{ts(isoMs(loop.last_cycle_started_at))} <span className="muted">({ago(isoMs(loop.last_cycle_started_at))})</span></> : latest ? <>{ts(latest.at_ms)} <span className="muted">(from ledger)</span></> : DASH}</dd>
            <dt>Next scan</dt><dd>{loop?.next_cycle_at && health?.forward_loop.state === 'RUNNING' ? <>{ts(isoMs(loop.next_cycle_at))} <span className="muted">({ago(isoMs(loop.next_cycle_at))})</span></> : health?.forward_loop.state === 'RUNNING' ? 'cycle in progress' : 'loop not running'}</dd>
          </dl>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Latest signal">
          {latest ? (
            <dl className="kv">
              <dt>Time</dt><dd>{ts(latest.at_ms)} <span className="muted">({ago(latest.at_ms)})</span></dd>
              <dt>Decision</dt><dd>{latest.accepted ? <Badge kind="pos">ACCEPTED</Badge> : <Badge kind={latest.outcome === 'NO_TRADE' ? 'neutral' : 'warn'}>{latest.outcome}</Badge>} <span className="muted">{latest.reason}</span></dd>
              {latest.asset && <><dt>Setup</dt><dd><b>{latest.asset}</b> <span className={latest.direction === 'long' ? 'pos' : 'neg'}>{latest.direction?.toUpperCase()}</span> · {latest.strategy} · rank {latest.rank ?? DASH}</dd>
                <dt>Geometry</dt><dd>entry {price(latest.entry)} · stop {price(latest.stop)} · TP1 {price(latest.tp1)} · TP2 {price(latest.tp2)}</dd></>}
            </dl>
          ) : <div className="muted">No forward signals recorded yet. Press START PAPER to run the forward loop.</div>}
        </Panel>
        <Panel title={`Open positions (${positions.data?.positions.length ?? 0})`}>
          {positions.data?.positions.length ? (
            <table className="compact"><tbody>
              {positions.data.positions.map((p) => (
                <tr key={p.signal_id}>
                  <td><b>{p.asset}</b></td>
                  <td className={p.direction === 'long' ? 'pos' : 'neg'}>{p.direction.toUpperCase()}</td>
                  <td>{lev(p.leverage)}</td>
                  <td className="num">{price(p.current_price)}</td>
                  <td className={`num ${tone(p.unrealized_pnl)}`}>{usd(p.unrealized_pnl, { sign: true })}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="muted">No open positions.</div>}
        </Panel>
      </div>
    </div>
  );
}
