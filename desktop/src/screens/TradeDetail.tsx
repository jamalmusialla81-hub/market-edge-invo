import { Fragment, useEffect, useState } from 'react';
import { api, CandleInterval, Distance, Excursion, ExitCoverage, ExitExplanation, TradeDetail } from '../api';
import { CandleChart, CounterfactualPoint, ExcursionPoint, HindsightLine } from '../components/CandleChart';
import { Badge, ErrorBanner, Panel, Stat, usePoll } from '../components/ui';
import { ago, DASH, duration, lev, num, pct, price, qty, tone, ts, usd } from '../format';
import { TradeRiskSizingView } from './RiskSizing';

const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h'];
const HINDSIGHT_LABELS: Record<string, string> = { optimal_entry: 'optimal entry', optimal_tp1: 'optimal TP1', optimal_tp2: 'optimal TP2', optimal_exit: 'optimal exit' };

function dist(d: Distance | null | undefined, hit?: string) {
  if (hit) return hit;
  if (!d) return DASH;
  return <>{price(d.price)} <span className="muted small">({pct(d.pct)})</span></>;
}

function exc(e: Excursion | undefined) {
  if (!e) return DASH;
  return <>{price(e.price)} <span className="muted small">{e.r === null ? '' : `${num(e.r, 2)}R · `}{usd(e.usd, { sign: true })}</span></>;
}

const bps = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${num(v, 1)} bps`);
const millis = (v: number | null | undefined) => (v === null || v === undefined ? DASH : v < 1000 ? `${Math.round(v)} ms` : duration(v / 1000));

/** "Why did this trade exit?" One row per real exit, from recorded facts only: a dash means it was not recorded for that exit
 *  (it predates the measurement), never a guessed value. Exit reasons the ledger cannot tell apart are stated below. */
export function ExitExplanations({ rows, coverage }: { rows: ExitExplanation[]; coverage?: Record<string, ExitCoverage> }) {
  return (
    <Panel title="Why did this trade exit?" right={<span className="muted small">Display only. Built from what was recorded at each exit.</span>}>
      {!rows.length && <div className="muted small">No exits yet.</div>}
      {rows.map((x) => (
        <div key={x.kind} className="exit-why" data-exit={x.kind}>
          <div><b>{x.kind}</b> <span className="muted small">{ts(x.at_ms)} · fill {price(x.fill_price)}{x.level === null ? '' : ` (level ${price(x.level)})`}</span></div>
          <div>{x.why}</div>
          <dl className="kv">
            <dt>Seen by</dt><dd>{x.seen_by}{x.observed_price === null ? '' : <span className="muted small"> · observed {price(x.observed_price)}</span>}</dd>
            <dt>Slippage</dt>
            <dd>{x.friction_provenance === 'measured'
              ? <>expected {bps(x.expected_slippage_bps)} · actual {bps(x.actual_slippage_bps)} · difference {bps(x.difference_bps)}</>
              : x.recorded.friction ? <>expected {bps(x.expected_slippage_bps)} <span className="muted small">· not measured: {x.friction_note ?? 'no live input'}</span></> : <span className="muted small">not recorded for this exit (predates friction measurement)</span>}</dd>
            {['STOP', 'BREAKEVEN_STOP'].includes(x.kind) && <>
              <dt>Stop overshoot</dt>
              <dd>{x.recorded.stop_overshoot
                ? (x.overshoot_bps === null ? <span className="muted small">no price was observed past the stop (candle-path exit)</span> : <>{bps(x.overshoot_bps)} · {x.overshoot_R === null ? DASH : `${num(x.overshoot_R, 2)}R`}</>)
                : <span className="muted small">not recorded for this exit (predates overshoot measurement)</span>}</dd>
            </>}
            <dt>Decision latency</dt>
            <dd>{millis(x.decision_latency_ms)}{x.since_previous_observation_ms === null ? '' : <span className="muted small"> · {millis(x.since_previous_observation_ms)} since the monitor's previous price</span>}</dd>
          </dl>
        </div>
      ))}
      {coverage && (
        <div className="muted small exit-coverage" aria-label="Exit reasons that cannot be told apart">
          <b>Not distinguishable in the ledger:</b>
          <ul>{Object.entries(coverage).filter(([, c]) => !c.distinguishable).map(([k, c]) => <li key={k}><b>{k.replace('_', ' ').toLowerCase()}</b>: {c.note}</li>)}</ul>
        </div>
      )}
    </Panel>
  );
}

const rMult = (r: number | null) => (r === null ? DASH : `${num(r, 2)}R`);

/** Profit giveback (MFE R - current/realised R) for the trade's own live
 *  figures. All numbers come from the backend; nothing is computed here. */
export function GivebackStats({ g, open }: { g: NonNullable<TradeDetail['live']['giveback']>; open: boolean }) {
  const peakWord = g.peak_side === 'HIGHEST' ? 'highest' : 'lowest';
  return (
    <div className="stat-grid" aria-label="Profit giveback">
      <Stat label="MFE (R)" value={rMult(g.mfe_r)} tone="pos" />
      <Stat label={open ? 'Current R' : 'Realised R'} value={rMult(g.current_r)} tone={tone(g.current_r)} sub={open ? 'realised + unrealised, before fees' : 'before fees'} />
      <Stat label="Profit giveback (R)" value={rMult(g.profit_giveback_r)} tone={g.profit_giveback_r ? 'neg' : undefined} sub="MFE R minus current R" />
      <Stat label="Profit giveback (%)" value={g.profit_giveback_pct === null ? DASH : pct(g.profit_giveback_pct)} sub="share of peak profit given back" />
      <Stat label="Highest favourable price" value={price(g.peak_price)} sub={`${peakWord} price since entry (${g.peak_side === 'HIGHEST' ? 'LONG' : 'SHORT'})`} />
      <Stat label="Distance from peak" value={open ? dist(g.distance_from_peak) : DASH} sub={open ? 'back from the peak, against the trade' : 'closed'} />
      <Stat label="Time since MFE" value={g.time_since_mfe_s === null ? DASH : duration(g.time_since_mfe_s)} sub={g.time_since_mfe_s === null ? 'not tracked yet' : undefined} />
    </div>
  );
}

/** Labelled list of the counterfactual exits. Never styled or worded as a fill. */
export function ExitCounterfactualNote({ data, error }: { data: import('../api').ExitCounterfactuals | null; error: string | null }) {
  const rows = data ? Object.entries(data.counterfactuals) : [];
  return (
    <div className="cf-note" role="note">
      <b>RESEARCH ONLY · COUNTERFACTUAL · NOT AN ACTUAL FILL.</b> Alternative exit policies replayed on the prices seen during this trade; they never changed the real exits and used no capital. Hollow diamonds on the chart mark where each would have exited. No policy has been shown to work.
      {error && <div className="neg small">Could not load counterfactuals: {error}</div>}
      {data && !rows.length && <div className="muted small">No counterfactual records for this trade (it was opened before exit shadowing existed, or the switch is off).</div>}
      {rows.length > 0 && (
        <table className="compact">
          <thead><tr><th>Policy</th><th>Would have</th><th>At</th><th>Price</th><th>R (after fees)</th></tr></thead>
          <tbody>
            {rows.map(([name, r]) => (
              <tr key={name} data-counterfactual-row={name}>
                <td className="mono small">{name}</td>
                <td className="small">{r.status === 'EXITED' ? `exited (${r.reason ?? DASH})` : 'still open'}</td>
                <td className="nowrap small">{r.counterfactual_exit_time ? ts(r.counterfactual_exit_time) : DASH}</td>
                <td className="num">{r.counterfactual_exit_price === null ? DASH : price(r.counterfactual_exit_price)}</td>
                <td className={`num ${tone(r.counterfactual_R)}`}>{r.counterfactual_R === null ? DASH : `${num(r.counterfactual_R, 2)}R`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function MonitorBanner({ d }: { d: TradeDetail }) {
  if (!d.is_open) return null;
  const m = d.live.monitor;
  const age = m.price_age_s === null ? 'no price yet' : `${duration(m.price_age_s)} old`;
  if (m.status === 'MARKET_DATA_OFFLINE') {
    return <div className="banner banner-error" role="alert">MARKET DATA OFFLINE for this position: {m.detail ?? 'no live price'}. The position is preserved; stop/TP are not evaluated until a fresh price arrives. Last real price {price(m.price)} ({age}).</div>;
  }
  if (m.status === 'STALE') {
    return <div className="banner banner-error" role="alert">MARKET DATA STALE: last real price {price(m.price)} is {age} (limit {m.max_price_age_s}s, source {m.price_source ?? DASH}). No trigger is evaluated on it; figures below use that last real price.</div>;
  }
  if (m.status === 'AWAITING_PRICE') {
    return <div className="banner banner-warn" role="status">Waiting for the first live price from the open-position monitor.</div>;
  }
  return null;
}

export function TradeDetailView({ tradeId, onBack, pollMs = 2000, candlePollMs = 10000 }: {
  tradeId: string; onBack: () => void; pollMs?: number; candlePollMs?: number;
}) {
  const [interval, setIntervalSel] = useState<CandleInterval>('5m');
  const [showHindsight, setShowHindsight] = useState(false);
  const [showExitCf, setShowExitCf] = useState(false);
  const detail = usePoll(() => api.tradeDetail(tradeId), pollMs, [tradeId]);
  const d = detail.data;
  // Open trades refresh their candles while the view is open; a closed
  // trade's window is fixed, so it is read once per timeframe.
  const candles = usePoll(() => api.tradeCandles(tradeId, interval), d && !d.is_open ? 24 * 3_600_000 : candlePollMs, [tradeId, interval, d?.is_open]);

  // Counterfactual exits are read only when the overlay is switched on; off by default.
  const cf = usePoll(() => (showExitCf ? api.exitCounterfactuals(tradeId) : Promise.resolve(null)), 15000, [tradeId, showExitCf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const back = <button className="btn" onClick={onBack} aria-label="Back to list">← Back</button>;
  if (!d) {
    return <div className="screen">{back}<ErrorBanner error={detail.error} />{!detail.error && <div className="muted">Loading trade…</div>}</div>;
  }
  const dec = d.decision;
  const live = d.live;
  const dir = dec.direction.toUpperCase();
  const hs = d.hindsight;
  const hindsightLines: HindsightLine[] = showHindsight && hs.available && hs.levels
    ? Object.entries(hs.levels).filter(([, v]) => typeof v === 'number').map(([k, v]) => ({ key: k, label: HINDSIGHT_LABELS[k] ?? k, price: v as number }))
    : [];
  const cs = candles.data;
  const excursions = ([
    { kind: 'MFE', price: live.best_price, at_ms: live.best_price_at_ms ?? null, precision: live.best_price_precision },
    { kind: 'MAE', price: live.worst_price, at_ms: live.worst_price_at_ms ?? null, precision: live.worst_price_precision },
  ] as ExcursionPoint[]).filter((e) => Number.isFinite(e.price) && e.price !== dec.entry_price);
  const cfRows = showExitCf && cf.data ? Object.entries(cf.data.counterfactuals) : [];
  const cfPoints: CounterfactualPoint[] = cfRows
    .filter(([, r]) => r.status === 'EXITED' && typeof r.counterfactual_exit_price === 'number' && typeof r.counterfactual_exit_time === 'number')
    .map(([name, r]) => ({ key: name, label: name, price: r.counterfactual_exit_price as number, at_ms: r.counterfactual_exit_time as number, r: r.counterfactual_R }));
  const netR = dec.risk_amount ? d.net_pnl / dec.risk_amount : null;

  return (
    <div className="screen trade-detail">
      <div className="detail-head">
        {back}
        <h1><b>{dec.asset}</b> <span className={dec.direction === 'long' ? 'pos' : 'neg'}>{dir}</span></h1>
        <Badge kind={d.is_open ? 'info' : 'neutral'}>{d.status}</Badge>
        {d.is_open && <Badge kind={live.monitor.status === 'LIVE' ? 'pos' : 'neg'}>MONITOR {live.monitor.status}</Badge>}
        <span className="mono small muted">{d.trade_id}</span>
        <span className="topbar-spacer" />
        <span className="muted small">{d.is_open ? `updated ${ago(detail.updatedAt)}` : `closed ${ts(d.closed_at_ms)} · ${d.exit_reason}`}</span>
      </div>
      <ErrorBanner error={detail.error} />
      <MonitorBanner d={d} />

      <div className="stat-grid">
        {d.is_open ? (
          <>
            <Stat label="Current price" value={price(live.current_price)} sub={live.monitor.price_at_ms ? <>{live.monitor.price_source} · {ago(live.monitor.price_at_ms)}</> : 'awaiting monitor price'} />
            <Stat label="Unrealized PnL" value={usd(live.unrealized_pnl, { sign: true })} tone={tone(live.unrealized_pnl)} sub={`remaining ${qty(live.remaining_qty)}`} />
            <Stat label="Unrealized R" value={live.unrealized_r === null ? DASH : `${num(live.unrealized_r, 2)}R`} tone={tone(live.unrealized_r)} />
            <Stat label={live.milestones.stop_status === 'BREAKEVEN' ? 'Distance to stop (breakeven)' : 'Distance to stop'} value={dist(live.distance_to_stop)} sub={`active stop ${price(live.active_stop)}`} />
            <Stat label="Distance to TP1" value={dist(live.distance_to_tp1, live.milestones.tp1_hit ? 'HIT' : undefined)} />
            <Stat label="Distance to TP2" value={dist(live.distance_to_tp2)} />
            <Stat label="Position age" value={duration(live.position_age_s)} sub={`opened ${ts(d.opened_at_ms)}`} />
          </>
        ) : (
          <>
            <Stat label="Net PnL" value={usd(d.net_pnl, { sign: true })} tone={tone(d.net_pnl)} sub={`fees ${usd(d.fees)}`} />
            <Stat label="Result" value={netR === null ? DASH : `${num(netR, 2)}R`} tone={tone(netR)} sub={d.exit_reason ?? DASH} />
            <Stat label="Held" value={duration(live.position_age_s)} sub={`${ts(d.opened_at_ms)} → ${ts(d.closed_at_ms)}`} />
          </>
        )}
        <Stat label={`MFE (best ${d.is_open ? 'so far' : ''})`} value={exc(live.mfe)} tone="pos" sub={`best price ${price(live.best_price)}`} />
        <Stat label="MAE (worst)" value={exc(live.mae)} tone="neg" sub={`worst price ${price(live.worst_price)}`} />
      </div>
      {live.giveback && <GivebackStats g={live.giveback} open={d.is_open} />}

      <Panel title={`${dec.asset} ${dir} · ${interval} candles`} right={
        <div className="seg">
          {INTERVALS.map((iv) => (
            <button key={iv} className={`seg-btn ${iv === interval ? 'active' : ''}`} aria-pressed={iv === interval} onClick={() => setIntervalSel(iv)}>{iv}</button>
          ))}
          <label className={`hindsight-toggle ${hs.available ? '' : 'disabled'}`} title={hs.available ? hs.label : `Unavailable: ${hs.reason}`}>
            <input type="checkbox" checked={showHindsight} disabled={!hs.available} onChange={(e) => setShowHindsight(e.target.checked)} />
            SHOW RESEARCH OVERLAY
          </label>
          <label className="hindsight-toggle cf-toggle" title="Alternative exits replayed beside this trade. Research only; never a fill.">
            <input type="checkbox" checked={showExitCf} onChange={(e) => setShowExitCf(e.target.checked)} />
            SHOW EXIT-POLICY COUNTERFACTUALS
          </label>
        </div>
      }>
        <ErrorBanner error={candles.error} />
        {cs && !cs.available && <div className="chart-empty">Candles unavailable ({cs.reason}). {cs.reason === 'RANGE_TOO_LARGE_FOR_INTERVAL' ? 'Pick a coarser timeframe.' : 'Nothing is drawn in their place.'}</div>}
        {cs?.available && (
          <CandleChart label={`${dec.asset} ${dir} trade chart`} candles={cs.candles} interval={interval} levels={d.levels} markers={d.markers}
            currentPrice={d.is_open ? live.current_price : null} hindsight={hindsightLines}
            excursions={excursions} counterfactuals={cfPoints} />
        )}
        {!cs && !candles.error && <div className="muted">Loading candles…</div>}
        <div className="muted small chart-foot">
          {cs ? <>Source {cs.source} ({cs.coin}) · {ts(cs.start_ms)} → {ts(cs.end_ms)}{d.is_open ? ` · refreshes every ${Math.round(candlePollMs / 1000)}s` : ''}. </> : null}
          {dec.direction === 'long' ? 'LONG: stop below entry, targets above; entry is a BUY, exits are SELLs.' : 'SHORT: stop above entry, targets below; entry is a SELL, exits are BUYs.'}
        </div>
        {showExitCf && <ExitCounterfactualNote data={cf.data} error={cf.error} />}
        {showHindsight && hs.available && (
          <div className="hindsight-note" role="note"><b>POST-OUTCOME / HINDSIGHT.</b> {hs.label}. Source {hs.source}, resolved {ts(hs.resolved_at_ms)}. Shown for research only; it never changes the original trade record.</div>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Original decision (as recorded at entry)">
          <dl className="kv">
            <dt>Asset</dt><dd>{dec.asset} <span className="muted">({dec.instrument})</span></dd>
            <dt>Direction</dt><dd className={dec.direction === 'long' ? 'pos' : 'neg'}>{dir}</dd>
            <dt>Entry time</dt><dd>{ts(dec.entry_time_ms)}</dd>
            <dt>Entry price</dt><dd>{price(dec.entry_price)} <span className="muted small">signal entry {price(dec.signal_entry)} · mark {price(dec.mark_at_entry)}</span></dd>
            <dt>Quantity / notional</dt><dd>{qty(dec.quantity)} · {usd(dec.notional)} <span className="muted small">lev {lev(dec.approved_leverage)} (req {lev(dec.requested_leverage)}) · risk {usd(dec.risk_amount)}</span></dd>
            <dt>Original stop</dt><dd className="neg">{price(dec.original_stop)}</dd>
            <dt>Original TP1</dt><dd className="pos">{price(dec.original_tp1)}</dd>
            <dt>Original TP2</dt><dd className="pos">{price(dec.original_tp2)}</dd>
            <dt>Original RR</dt><dd>TP1 {num(dec.original_rr1, 2)} · TP2 {num(dec.original_rr2, 2)}</dd>
            <dt>Strategy / setup</dt><dd>{dec.strategy ?? DASH}{dec.regime ? <span className="muted"> · {dec.regime}</span> : null}</dd>
            <dt>Quant score</dt><dd>{num(dec.quant_score, 1)} <span className="muted small">rank {dec.rank ?? DASH}</span></dd>
            <dt>Model score</dt><dd>{dec.ml_score === null ? 'n/a' : num(dec.ml_score, 3)} <span className="muted small">combined {num(dec.combined_score, 1)}</span></dd>
            <dt>scan_id</dt><dd className="mono small">{dec.scan_id ?? DASH}</dd>
            <dt>Shadow observation</dt><dd className="mono small">{d.shadow?.linked ? d.shadow.observation_id : dec.observation_id ?? 'not shadow-linked'}</dd>
            <dt>Model version</dt><dd className="mono small">{dec.model_version ?? DASH}{dec.model_status ? ` (${dec.model_status})` : ''}</dd>
            <dt>Feature version</dt><dd className="mono small">{dec.feature_version ?? DASH}</dd>
            <dt>Price provenance</dt><dd>{dec.market_price_source ?? DASH} <span className="muted small">{ts(dec.market_price_timestamp)} · {dec.market_price_age_ms === null ? DASH : `${num(dec.market_price_age_ms / 1000, 1)}s old at entry`}</span></dd>
            <dt>Execution</dt><dd>{dec.execution_mode} · {dec.backend} · {dec.execution_status}</dd>
          </dl>
        </Panel>
        <Panel title="Position management">
          <dl className="kv">
            <dt>TP1</dt><dd>{live.milestones.tp1_hit ? <>HIT {price(live.milestones.tp1_fill_price)} <span className="muted small">{ts(live.milestones.tp1_fill_timestamp)}</span></> : 'PENDING'}</dd>
            <dt>TP2</dt><dd>{live.milestones.tp2_status}</dd>
            <dt>Stop</dt><dd>{live.milestones.stop_status}</dd>
            <dt>Remaining qty</dt><dd>{qty(live.milestones.remaining_quantity)}</dd>
          </dl>
          <table className="compact exits">
            <thead><tr><th>Exit</th><th>Time</th><th>Fill</th><th>Qty</th><th>PnL</th><th>Seen by</th></tr></thead>
            <tbody>
              {d.exits.length ? d.exits.map((e) => (
                <tr key={e.kind}><td>{e.kind}</td><td className="nowrap">{ts(e.at_ms)}</td><td className="num">{price(e.fill_price)}</td>
                  <td className="num">{qty(e.quantity)}</td><td className={`num ${tone(e.pnl)}`}>{usd(e.pnl, { sign: true })}</td><td className="small">{e.trigger ?? 'CANDLE_5M'}</td></tr>
              )) : <tr><td colSpan={6} className="empty">No exits yet.</td></tr>}
            </tbody>
          </table>
        </Panel>
      </div>

      {d.exit_explanations && <ExitExplanations rows={d.exit_explanations} coverage={d.exit_coverage} />}

      {d.risk_sizing && <TradeRiskSizingView s={d.risk_sizing} />}

      <Panel title="Shadow learning link (research only)">
        {d.shadow?.linked ? (
          <dl className="kv">
            <dt>Observation ID</dt><dd className="mono small">{d.shadow.observation_id}</dd>
            <dt>Shadow scan</dt><dd className="mono small">{d.shadow.scan_id}</dd>
            <dt>Resolution</dt><dd>{d.shadow.resolution_status ?? DASH}{d.shadow.next_due_ts ? <span className="muted small"> · next window closes {ts(d.shadow.next_due_ts)}</span> : null}</dd>
            <dt>Resolved horizons</dt><dd>{d.shadow.resolved_horizons?.length ? d.shadow.resolved_horizons.join(' · ') : 'none yet'}</dd>
            {d.shadow.unresolvable_horizons?.length ? <><dt>Unresolved (data)</dt><dd>{d.shadow.unresolvable_horizons.join(' · ')}</dd></> : null}
            <dt>Pending horizons</dt><dd>{d.shadow.pending_horizons?.length ? d.shadow.pending_horizons.join(' · ') : 'none'}</dd>
          </dl>
        ) : <div className="muted">Not linked to a shadow observation ({d.shadow?.reason ?? 'shadow data unavailable'}).</div>}
      </Panel>

      {showHindsight && hs.available && hs.levels && (
        <Panel title="Research overlay — POST-OUTCOME / HINDSIGHT" className="panel-hindsight">
          <p className="muted small">{hs.label}. These are not decision-time values.</p>
          <dl className="kv">
            {Object.entries(hs.levels).map(([k, v]) => <Fragment key={k}><dt>{HINDSIGHT_LABELS[k] ?? k}</dt><dd>{price(v)}</dd></Fragment>)}
            {hs.diagnostics && Object.entries(hs.diagnostics).map(([k, v]) => <Fragment key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{typeof v === 'number' ? num(v, 3) : v ?? DASH}</dd></Fragment>)}
          </dl>
          {hs.diagnostics && <p className="muted small">Missed-opportunity classification is diagnostic and unvalidated.</p>}
        </Panel>
      )}
    </div>
  );
}
