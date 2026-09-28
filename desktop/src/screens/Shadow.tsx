import { useState } from 'react';
import { api, ShadowDetail, ShadowRow, ShadowSummary } from '../api';
import { Badge, ErrorBanner, Panel, Stat, Table, usePoll } from '../components/ui';
import { DASH, num, pct, price, ts } from '../format';

// Values from the backend here are FRACTIONS (0.005 = 0.50%); format.pct expects percent.
const fpct = (v: number | null | undefined, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? pct(v * 100, digits) : DASH);

// Research-only view. Shadow observations are hypothetical: they consume no
// capital, never change exposure and can never be executed. Hindsight labels
// are shown only under POST-OUTCOME RESEARCH ONLY and are never predictions.

const CLASS_KIND: Record<string, 'pos' | 'neg' | 'warn' | 'neutral' | 'info'> = {
  GOOD_TRADE_TAKEN: 'pos', BAD_TRADE_AVOIDED: 'pos', NO_TRADE_CORRECT: 'pos',
  GOOD_TRADE_MISSED: 'warn', MISSED_OPPORTUNITY: 'warn', BAD_TRADE_TAKEN: 'neg',
  AMBIGUOUS: 'neutral', NO_REAL_OPPORTUNITY: 'neutral', OPPORTUNITY_PRESENT: 'info',
};

export function ShadowStats({ s }: { s: ShadowSummary }) {
  return (
    <div className="stat-grid" aria-label="Shadow learning today">
      <Stat label="Shadow observations today" value={s.observations} sub={`${s.candidate_observations} candidates · ${s.market_state_observations} market states`} big />
      <Stat label="Resolved" value={s.resolved} sub={`${s.partially_resolved} partially`} />
      <Stat label="Unresolved" value={s.unresolved} />
      <Stat label="Paper executed" value={s.paper_executed} />
      <Stat label="Rejected but tracked" value={s.rejected_but_tracked} sub={`${s.not_submitted_tracked} not submitted`} />
      <Stat label="No-trade states tracked" value={s.no_trade_states} sub={`${s.no_trade_scans} no-trade scans`} />
      <Stat label="Missed opportunities" value={s.missed_opportunities} tone={s.missed_opportunities ? 'warn' : ''} sub="post-outcome, diagnostic" />
      <Stat label="Bad trades avoided" value={s.bad_trades_avoided} sub="post-outcome, diagnostic" />
      <Stat label="Independent clusters" value={s.clusters} sub={`${s.episodes} market episodes`} />
    </div>
  );
}

export function ShadowTable({ rows, onOpen }: { rows: ShadowRow[]; onOpen: (id: string) => void }) {
  return (
    <Table empty={rows.length ? false : 'No shadow observations yet. They are recorded from every scan the paper loop runs.'}
      head={['Time', 'Asset', 'Kind', 'Dir', 'Strategy', 'Rank', 'Execution', 'Valid', 'Resolution', 'Post-outcome class', 'Cluster']}>
      {rows.map((r) => (
        <tr key={r.observation_id} className="clickable" onClick={() => onOpen(r.observation_id)}>
          <td className="nowrap">{ts(r.decision_ts)}</td>
          <td><b>{r.asset}</b></td>
          <td>{r.kind === 'MARKET_STATE' ? (r.production_state === 'NO_TRADE' ? 'NO-TRADE STATE' : 'MARKET STATE') : 'CANDIDATE'}</td>
          <td className={r.direction === 'long' ? 'pos' : r.direction === 'short' ? 'neg' : ''}>{r.direction?.toUpperCase() ?? DASH}</td>
          <td>{r.strategy ?? DASH}</td>
          <td className="num">{r.production_rank ?? (r.scan_candidate_rank ? `(${r.scan_candidate_rank})` : DASH)}</td>
          <td>
            <Badge kind={r.execution_status === 'EXECUTED' ? 'pos' : r.execution_status === 'REJECTED' ? 'neg' : 'neutral'}>{r.execution_status}</Badge>
            {r.execution_rejection_reason && <span className="muted small"> {r.execution_rejection_reason}</span>}
          </td>
          <td>{r.research_candidate_valid ? 'yes' : <span className="neg">{r.invalid_reason}</span>}</td>
          <td>{r.resolution_status ?? DASH}</td>
          <td>{r.classification ? <Badge kind={CLASS_KIND[r.classification] ?? 'neutral'}>{r.classification}</Badge> : DASH}</td>
          <td className="mono small">{r.observation_cluster_id.slice(-13)}{r.overlap_fraction > 0 ? ` · ${fpct(r.overlap_fraction, 0)} overlap` : ''}</td>
        </tr>
      ))}
    </Table>
  );
}

function Kv({ data }: { data: Record<string, unknown> | undefined | null }) {
  if (!data) return <span className="muted">{DASH}</span>;
  return (
    <dl className="kv">
      {Object.entries(data).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd className="mono">{typeof v === 'number' ? num(v, 6) : String(v ?? DASH)}</dd></div>
      ))}
    </dl>
  );
}

export function ShadowDetailView({ d }: { d: ShadowDetail }) {
  const cand = d.DECISION_TIME_DATA.candidate as Record<string, unknown> | undefined;
  const horizons = Object.entries(d.FUTURE_LABEL_DATA).flatMap(([, batch]) => Object.entries(batch.labels));
  const hs = d.POST_OUTCOME_RESEARCH_ONLY;
  return (
    <div className="grid-2">
      <Panel title="Decision-time snapshot (immutable)" right={<Badge kind={d.decision_hash_ok ? 'pos' : 'neg'}>{d.decision_hash_ok ? 'hash verified' : 'HASH MISMATCH'}</Badge>}>
        <p className="muted small">Only what was known at {ts(d.decision_ts)}. Execution: <b>{d.execution_status}</b>{d.execution_rejection_reason ? ` (${d.execution_rejection_reason})` : ''}.</p>
        <h4>Market</h4><Kv data={d.DECISION_TIME_DATA.market as Record<string, unknown>} />
        {cand && <><h4>Candidate</h4><Kv data={cand} /></>}
      </Panel>
      <Panel title="Future path (labelled after each window closed)">
        {horizons.length === 0 ? <p className="muted">No window has closed yet. Labels appear only after the evaluation window ends.</p> : (
          <Table head={['Horizon', 'Status', 'MFE', 'MAE', 'Stop', 'TP1', 'TP2', 'Touch order', 'Current-policy R']}>
            {horizons.map(([h, l]) => (
              <tr key={h}>
                <td>{h}</td>
                <td>{String(l.label_status)}</td>
                <td className="num">{l.mfe_pct !== undefined ? fpct(l.mfe_pct as number) : l.up_excursion_pct !== undefined ? fpct(l.up_excursion_pct as number) : DASH}</td>
                <td className="num">{l.mae_pct !== undefined ? fpct(l.mae_pct as number) : l.down_excursion_pct !== undefined ? fpct(l.down_excursion_pct as number) : DASH}</td>
                <td>{l.stop_hit === undefined ? DASH : l.stop_hit ? 'hit' : 'no'}</td>
                <td>{l.tp1_hit === undefined ? DASH : l.tp1_hit ? 'hit' : 'no'}</td>
                <td>{l.tp2_hit === undefined ? DASH : l.tp2_hit ? 'hit' : 'no'}</td>
                <td className="small">{String(l.first_touch_order ?? DASH)}</td>
                <td className="num">{typeof l.policy_r === 'number' ? `${num(l.policy_r, 2)}R` : DASH}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <Panel title="POST-OUTCOME RESEARCH ONLY" className="panel-research">
        {!hs ? <p className="muted">Available only after the full 72h window has closed.</p> : (
          <>
            <div className="banner banner-warn" role="note">{hs.notice}</div>
            <p>Diagnostic class: <Badge kind={CLASS_KIND[hs.classification] ?? 'neutral'}>{hs.classification}</Badge> <span className="muted small">(unvalidated; not a training target)</span></p>
            <dl className="kv">
              <dt>Current-policy result</dt><dd className="mono">{typeof hs.current_policy_outcome_r === 'number' ? `${num(hs.current_policy_outcome_r as number, 2)}R` : DASH}</dd>
              <dt>Executable (within stop)</dt><dd className="mono">{typeof hs.executable_within_stop_r === 'number' ? `${num(hs.executable_within_stop_r as number, 2)}R` : DASH}</dd>
              <dt>Strategy efficiency</dt><dd className="mono">{typeof hs.strategy_efficiency === 'number' ? num(hs.strategy_efficiency as number, 2) : DASH}</dd>
              <dt>Best direction</dt><dd className="mono">{String(hs.best_direction)}</dd>
              <dt>Executable long / short</dt><dd className="mono">{fpct(hs.optimal_long_net_pct as number)} / {fpct(hs.optimal_short_net_pct as number)}</dd>
              <dt>Theoretical long / short</dt><dd className="mono">{fpct(hs.theoretical_long_move_pct as number)} / {fpct(hs.theoretical_short_move_pct as number)} <span className="muted small">(not tradable)</span></dd>
              <dt>Optimal entry → exit</dt><dd className="mono">{price(hs.optimal_entry as number)} → {price(hs.optimal_exit as number)}</dd>
            </dl>
          </>
        )}
      </Panel>
    </div>
  );
}

const FILTERS: { label: string; filter: Record<string, string> }[] = [
  { label: 'All', filter: {} },
  { label: 'Candidates', filter: { kind: 'CANDIDATE' } },
  { label: 'Market states', filter: { kind: 'MARKET_STATE' } },
  { label: 'Paper executed', filter: { execution_status: 'EXECUTED' } },
  { label: 'Rejected', filter: { execution_status: 'REJECTED' } },
  { label: 'Missed', filter: { classification: 'GOOD_TRADE_MISSED' } },
  { label: 'Avoided', filter: { classification: 'BAD_TRADE_AVOIDED' } },
];

export function Shadow() {
  const [filterIdx, setFilterIdx] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const summary = usePoll(api.shadowSummary, 15000);
  const rows = usePoll(() => api.shadowObservations({ limit: 300, ...FILTERS[filterIdx].filter }), 15000, [filterIdx]);
  const detail = usePoll(() => (open ? api.shadowObservation(open) : Promise.resolve(null)), 30000, [open]);
  return (
    <div className="screen">
      <div className="banner banner-info" role="note">
        RESEARCH ONLY · Shadow observations are hypothetical. They use no paper capital, never affect exposure or PnL and can never be executed.
      </div>
      <ErrorBanner error={summary.error ?? rows.error} />
      {summary.data && <ShadowStats s={summary.data} />}
      <Panel title="Observations" right={
        <span role="group" aria-label="Filter">{FILTERS.map((f, i) => (
          <button key={f.label} className={`btn btn-small ${i === filterIdx ? 'active' : ''}`} aria-pressed={i === filterIdx} onClick={() => setFilterIdx(i)}>{f.label}</button>
        ))}</span>}>
        <ShadowTable rows={rows.data?.observations ?? []} onOpen={setOpen} />
      </Panel>
      {open && detail.data && <ShadowDetailView d={detail.data} />}
    </div>
  );
}
