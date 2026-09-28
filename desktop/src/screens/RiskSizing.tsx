import { Fragment } from 'react';
import { RiskSizingStatus, SizingRecordRow, TradeRiskSizing } from '../api';
import { Badge, Panel, Stat, Table } from '../components/ui';
import { DASH, num, pct, price, qty, ts, usd } from '../format';

// Values from the backend here are FRACTIONS (0.005 = 0.50%); format.pct expects percent.
const fpct = (v: number | null | undefined, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? pct(v * 100, digits) : DASH);

// Risk Sizing V2. Planned LOSS drives size; notional follows from stop
// distance + costs and is cut by the hard caps. 5% notional is a ceiling,
// never a target. Gross exposure (open notional / equity) is NOT leverage.

const ratio = (v: number | null | undefined, digits = 2) => fpct(v, digits);

export function RiskSizingPanel({ s }: { s: RiskSizingStatus }) {
  const p = s.policy;
  return (
    <Panel title="Risk Sizing V2" right={
      <span>
        <Badge kind={s.mode === 'PAPER' ? 'pos' : 'info'}>MODE {s.mode}</Badge>{' '}
        <Badge kind="neutral">KELLY {s.kelly}</Badge>{' '}<Badge kind="neutral">LIVE {s.live}</Badge>
      </span>}>
      {s.mode === 'SHADOW' && <p className="muted small">V2 is computed and recorded for every signal as a counterfactual; the existing sizing still sets executed quantities.</p>}
      {s.drawdown_pause && <div className="banner banner-error" role="alert">DRAWDOWN_RISK_PAUSE: drawdown {fpct(s.drawdown_pct)} ≥ {fpct(p.dd_pause_pct, 0)}. New entries paused; open positions are still managed.</div>}
      <div className="stat-grid" aria-label="Risk sizing policy">
        <Stat label="Current equity" value={usd(s.equity)} big />
        <Stat label="Base risk / trade" value={ratio(p.base_risk_pct)} sub="planned-loss budget, a maximum" />
        <Stat label="Effective risk / trade" value={ratio(s.effective_risk_pct_before_vol)} sub="after drawdown; volatility may cut further per asset" />
        <Stat label="Max position notional" value={ratio(p.max_position_notional_pct, 0)} sub="ceiling, never a target" />
        <Stat label="Max gross exposure" value={ratio(p.max_portfolio_gross_pct, 0)} />
        <Stat label="Max open planned risk" value={ratio(p.max_open_planned_risk_pct, 0)} />
        <Stat label="Max cluster planned risk" value={ratio(p.max_cluster_planned_risk_pct, 0)} />
        <Stat label="Max positions" value={p.max_positions} />
        <Stat label="Current open planned risk" value={ratio(s.open_planned_risk_pct)} sub={usd(s.open_planned_risk_dollars)}
          tone={(s.open_planned_risk_pct ?? 0) > p.max_open_planned_risk_pct * 0.8 ? 'warn' : ''} />
        <Stat label="Current drawdown" value={ratio(s.drawdown_pct)} tone={s.drawdown_pause ? 'neg' : ''} />
        <Stat label="Drawdown multiplier" value={s.drawdown_multiplier === null ? 'PAUSED' : num(s.drawdown_multiplier, 2)} />
        <Stat label="Gross exposure" value={s.gross_exposure_multiple === null ? DASH : `${num(s.gross_exposure_multiple, 2)}x`} sub={`${usd(s.gross_exposure_dollars)} open notional — not leverage`} />
        <Stat label="Risk sizing mode" value={s.mode} />
        <Stat label="Kelly" value={s.kelly} />
      </div>
      {Object.keys(s.cluster_planned_risk).length > 0 && (
        <p className="small">Cluster planned risk: {Object.entries(s.cluster_planned_risk).map(([k, v]) => `${k} ${ratio(v.pct)}`).join(' · ')}</p>
      )}
      <Table empty={s.positions.length ? false : 'No open positions.'}
        head={['Asset', 'Dir', 'Notional', 'Notional % eq', 'Planned loss $', 'Planned loss % eq', 'Stop distance', 'Cluster', 'Binding sizing constraint', 'Position leverage']}>
        {s.positions.map((x) => (
          <tr key={x.signal_id}>
            <td><b>{x.asset}</b></td>
            <td className={x.direction === 'long' ? 'pos' : 'neg'}>{x.direction.toUpperCase()}</td>
            <td className="num">{usd(x.notional)}</td>
            <td className="num">{ratio(x.notional_pct_equity)}</td>
            <td className="num">{usd(x.planned_loss_dollars)}</td>
            <td className="num">{ratio(x.planned_loss_pct_equity, 3)}</td>
            <td className="num">{ratio(x.stop_distance_pct)}</td>
            <td>{x.cluster_id}</td>
            <td className="small">{x.binding_constraint ?? DASH}</td>
            <td className="num">{x.position_leverage === null ? DASH : `${num(x.position_leverage, 0)}x`}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

const ROWS: [string, string, 'pct' | 'usd' | 'mult' | 'text' | 'qty'][] = [
  ['wallet_equity', 'Equity', 'usd'], ['base_risk_pct', 'Base risk', 'pct'], ['effective_risk_pct', 'Effective risk', 'pct'],
  ['stop_distance_pct', 'Stop distance', 'pct'], ['vol_multiplier', 'Vol multiplier', 'mult'], ['drawdown_multiplier', 'DD multiplier', 'mult'],
  ['execution_buffer_pct', 'Execution allowance', 'pct'], ['raw_risk_notional', 'Raw risk-based size', 'usd'],
  ['position_notional_cap', '5% cap', 'usd'], ['portfolio_cap_notional', 'Portfolio planned-risk capacity', 'usd'],
  ['portfolio_gross_cap_notional', 'Gross exposure capacity', 'usd'], ['cluster_cap_notional', 'Cluster capacity', 'usd'],
  ['liquidity_cap_notional', 'Liquidity capacity', 'usd'], ['final_notional', 'Final size', 'usd'], ['final_quantity', 'Final quantity', 'qty'],
  ['planned_loss_dollars', 'Planned loss', 'usd'], ['sizing_binding_constraint', 'Binding constraint', 'text'],
  ['cluster_id', 'Cluster', 'text'], ['sizing_rule_version', 'Sizing rule version', 'text'],
];

function fmt(v: unknown, kind: string) {
  if (v === null || v === undefined) return DASH;
  if (kind === 'text' || typeof v !== 'number') return String(v);
  return kind === 'pct' ? fpct(v, 3) : kind === 'usd' ? usd(v) : kind === 'qty' ? qty(v) : num(v, 2);
}

export function SizingRecordView({ row }: { row: SizingRecordRow }) {
  const r = row.record;
  return (
    <dl className="kv">
      {ROWS.filter(([k]) => k in r).map(([k, label, kind]) => <Fragment key={k}><dt>{label}</dt><dd className="mono">{fmt(r[k], kind)}</dd></Fragment>)}
      {!row.approved && <><dt>Rejected</dt><dd className="neg">{row.reason}</dd></>}
      <dt>Recorded</dt><dd className="small">{ts(row.created_at_ms)} · {row.record_hash_ok ? 'hash verified' : 'HASH MISMATCH'}</dd>
    </dl>
  );
}

export function TradeRiskSizingView({ s }: { s: TradeRiskSizing }) {
  return (
    <div className="grid-2">
      <Panel title={`Risk sizing — original decision (${s.executed?.record.sizing_rule_version ?? 'not recorded'})`}>
        {s.note && <p className="muted small">{s.note}</p>}
        {s.executed && <><p className="muted small">Executed quantity {qty(s.executed_quantity)} · this is the size actually used.</p><SizingRecordView row={s.executed} /></>}
        {s.current_risk && (
          <>
            <h4>Current risk (recomputed; the original above never changes)</h4>
            <dl className="kv">
              <dt>Remaining qty</dt><dd className="mono">{qty(s.current_risk.remaining_qty)}</dd>
              <dt>Active stop</dt><dd className="mono">{price(s.current_risk.active_stop)}</dd>
              <dt>Current planned loss</dt><dd className="mono">{usd(s.current_risk.current_planned_loss)}</dd>
            </dl>
          </>
        )}
        {s.outcome && (
          <>
            <h4>After-trade measurement (outcome)</h4>
            <dl className="kv">
              <dt>Realised R</dt><dd className="mono">{typeof s.outcome.realised_R === 'number' ? `${num(s.outcome.realised_R, 2)}R` : DASH}</dd>
              <dt>Realised fees</dt><dd className="mono">{usd(s.outcome.realised_fees as number)}</dd>
              <dt>Stop slippage</dt><dd className="mono">{usd(s.outcome.realised_stop_slippage as number)}</dd>
              <dt>Max loss seen</dt><dd className="mono">{usd(s.outcome.realised_max_loss as number)}</dd>
            </dl>
          </>
        )}
      </Panel>
      {s.counterfactual.map((row) => (
        <Panel key={row.decision_id} title="COUNTERFACTUAL RISK SIZING" className="panel-research">
          <div className="banner banner-warn" role="note">RESEARCH ONLY · NOT USED FOR EXECUTION · this is what {row.record.sizing_rule_version} would have sized, not the executed quantity.</div>
          <SizingRecordView row={row} />
        </Panel>
      ))}
    </div>
  );
}
