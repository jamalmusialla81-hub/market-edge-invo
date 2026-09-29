import { api, PositionMonitorStatus, RateLimitDiagnostics } from '../api';
import { Badge, Panel, Stat, Table, usePoll } from '../components/ui';
import { DASH, duration, ts } from '../format';

const TIER_LABEL: Record<string, string> = {
  P0_POSITION_MONITOR: 'P0 position monitor',
  P1_RECONCILIATION: 'P1 reconciliation',
  P2_DISCOVERY: 'P2 discovery',
  P3_SHADOW_CAPTURE: 'P3 shadow capture',
  P4_SHADOW_RESOLUTION: 'P4 shadow resolution',
  P5_CHART_HISTORY: 'P5 chart history',
};
const STATE_KIND = { OK: 'pos', RECOVERING: 'warn', BACKOFF: 'neg' } as const;

/** Read-only view of the execution-service's rate-limit diagnostics. Display only: no control of any budget or retry. */
export function RateLimitView({ data, error, monitor, nowMs = Date.now() }: {
  data: RateLimitDiagnostics | null; error: string | null; monitor?: PositionMonitorStatus | null; nowMs?: number;
}) {
  if (!data) {
    return (
      <Panel title="Rate limits">
        <div className="muted">{error ? `No rate-limit data: ${error}. An older execution-service build does not report it.` : 'Loading rate-limit data…'}</div>
      </Panel>
    );
  }
  const n = data.node_budget;
  const chart = data.chart_candles;
  const stale = data.node_budget_age_s !== null && data.node_budget_age_s > 60;
  const backoffLeft = n?.cooldown_until_ms ? Math.max(0, (n.cooldown_until_ms - nowMs) / 1000) : 0;
  const tiers = data.priorities.length ? data.priorities : Object.keys(TIER_LABEL);
  return (
    <Panel title="Rate limits" right={n ? <Badge kind={STATE_KIND[n.state] ?? 'neutral'}>{n.state}</Badge> : <Badge kind="neutral">NO REPORT YET</Badge>}>
      <p className="muted small">Hyperliquid request budget as reported by the forward loop and position monitor. Display only; nothing here changes trading or retry behaviour.</p>
      {!n && <div className="muted">The forward loop has not reported a request budget yet.</div>}
      {n && (
        <>
          {stale && <div className="banner banner-warn" role="alert">Last report is {duration(data.node_budget_age_s ?? 0)} old; the figures may be out of date.</div>}
          {n.state === 'BACKOFF' && (
            <div className="banner banner-error" role="alert">
              Backing off after HTTP 429: all Hyperliquid requests are paused for {duration(backoffLeft)}
              {n.last_retry_after_ms !== null ? ` (server Retry-After ${duration(n.last_retry_after_ms / 1000)})` : ''}. Open-position monitoring (P0) is served first when it resumes.
            </div>
          )}
          <div className="stat-grid" aria-label="Rate-limit summary">
            <Stat label="HTTP 429 (total)" value={n.totals.http_429} tone={n.totals.http_429 ? 'warn' : ''} />
            <Stat label="Last 429" value={n.totals.last_429_at_ms ? ts(n.totals.last_429_at_ms) : 'none seen'} />
            <Stat label="Consecutive 429" value={n.consecutive_429} tone={n.consecutive_429 ? 'warn' : ''} />
            <Stat label="Current backoff" value={n.state === 'BACKOFF' ? duration(backoffLeft) : 'none'} sub="applies to the whole host, every tier" />
            <Stat label="Queue depth" value={n.queue_depth} sub={`${n.in_flight} in flight`} />
            <Stat label="Weight, last 60 s" value={`${n.weight_used_last_60s}${n.weight_limit_per_min ? ` / ${n.weight_limit_per_min}` : ''}`}
              sub={n.pacing === 'WEIGHT_BUDGET' ? `pacing to budget (exchange limit ${n.hyperliquid_limit_per_min}/min)` : 'reacting to 429 only'} />
            <Stat label="Requests (total)" value={n.totals.requests} sub={`${n.totals.deduplicated} de-duplicated · ${n.totals.deferred} deferred`} />
            <Stat label="Websocket" value={monitor?.ws_state ?? DASH} sub={monitor ? `monitor ${monitor.state}${monitor.market_ok === false ? ' · market data offline' : ''}` : 'position monitor not reporting'} />
          </div>
          <Table head={['Priority tier', 'Queued', 'Started', 'Deferred', 'Waited']}>
            {tiers.map((t) => {
              const b = n.by_priority[t];
              return (
                <tr key={t}>
                  <td><b>{TIER_LABEL[t] ?? t}</b></td>
                  <td>{n.queue_depth_by_priority[t] ?? 0}</td>
                  <td>{b?.started ?? 0}</td>
                  <td>{b?.deferred ?? 0}</td>
                  <td>{b ? duration(b.waited_ms / 1000) : DASH}</td>
                </tr>
              );
            })}
          </Table>
          <Table head={['Market-data endpoint', 'Requests', 'OK', 'Errors', '429', 'Last 429']}>
            {Object.entries(n.endpoints).length ? Object.entries(n.endpoints).map(([name, e]) => (
              <tr key={name}>
                <td className="mono small">{name}</td><td>{e.requests}</td><td>{e.ok}</td><td>{e.errors}</td>
                <td>{e.http_429 ? <Badge kind="warn">{e.http_429}</Badge> : 0}</td><td>{e.last_429_at_ms ? ts(e.last_429_at_ms) : DASH}</td>
              </tr>
            )) : <tr><td colSpan={6} className="muted">No requests recorded yet.</td></tr>}
          </Table>
        </>
      )}
      {chart && (
        <dl className="kv">
          <dt>Chart history (P5)</dt>
          <dd><Badge kind={chart.state === 'OK' ? 'pos' : 'neg'}>{chart.state}</Badge>{' '}
            <span className="muted small">{chart.state === 'BACKOFF' ? `paused ${duration(chart.backoff_remaining_s)} · ` : ''}{chart.http_429 ?? 0} × 429 · {chart.deferred ?? 0} deferred · {chart.cached_series} cached series</span></dd>
        </dl>
      )}
    </Panel>
  );
}

export function RateLimitPanel({ monitor }: { monitor?: PositionMonitorStatus | null }) {
  const { data, error } = usePoll(api.rateLimit, 5000);
  return <RateLimitView data={data} error={error} monitor={monitor} />;
}
