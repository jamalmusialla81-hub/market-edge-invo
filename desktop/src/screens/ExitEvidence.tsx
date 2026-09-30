import { api, ExitEvidence as ExitEvidenceData } from '../api';
import { Badge, Panel, Stat, Table, usePoll } from '../components/ui';
import { DASH, num } from '../format';

// Display only. It explains why adaptive exits stay disabled: it counts what the completeness check and the Shadow replay
// recorded, next to the fixed evidence bar. Nothing here can change a mode, a trade, an exit or the bar.

const COHORT_LABEL: Record<string, string> = { B_EXECUTABLE_SHADOW: 'Executable Shadow (Cohort B)', C_RESEARCH_ONLY: 'Research-only (Cohort C)' };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const r = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${num(v, 3)} R`);

export function ExitEvidenceView({ data, error }: { data: ExitEvidenceData | null; error: string | null }) {
  if (!data) {
    return (
      <Panel title="Adaptive exit evidence">
        <div className="muted">{error ? `No exit evidence: ${error}. An older execution-service build does not report it.` : 'Loading exit evidence…'}</div>
      </Panel>
    );
  }
  const g = data.gate;
  const degraded = data.pipeline.status !== 'OK';
  return (
    <section aria-label="ADAPTIVE EXIT EVIDENCE" className="exit-evidence">
      <Panel title="Adaptive exit evidence" right={<Badge kind="warn">POST-OUTCOME RESEARCH ONLY · NOT AN ACTION THE BOT TOOK</Badge>}>
        <p className="muted small">Read-only. Adaptive exits are disabled in PAPER and PAPER_CANARY. This is why: no policy has passed the evidence bar.</p>
        {degraded && (
          <div className="banner neg" role="alert">
            <b>RESEARCH_PIPELINE_DEGRADED.</b> {data.pipeline.degraded_trades.length} finalized trade(s) have incomplete exit research:{' '}
            {data.pipeline.degraded_trades.map((t) => `${t.trade_id} (${t.label}${t.missing_policies.length ? `, missing ${t.missing_policies.join(' ')}` : ''})`).join('; ')}
          </div>
        )}
        <div className="stat-grid" aria-label="Evidence against the bar">
          <Stat label="Paper finalized" value={`${g.paper_finalized} / ${g.paper_finalized_needed}`} sub={`${data.paper.complete_path_finalized_trades} complete-path`} big />
          <Stat label="Independent episodes" value={`${g.independent_episodes} / ${g.independent_episodes_needed}`} />
          <Stat label="Passing policies" value={g.passing_summary} />
          <Stat label="Entry-failure episodes" value={data.entry_failure_episodes} />
          <Stat label="Giveback-failure episodes" value={data.giveback_failure_episodes} />
          <Stat label="Adaptive exits in PAPER" value={data.adaptive_exits_enabled.PAPER ? 'ON' : 'OFF'} sub={`PAPER_CANARY ${data.adaptive_exits_enabled.PAPER_CANARY ? 'ON' : 'OFF'}`} />
        </div>
        <p className="small"><b>Next evaluation condition.</b> {data.next_evaluation_condition}</p>

        <h3>What has been observed</h3>
        <dl className="kv">
          <dt>Raw Shadow observations</dt><dd>{data.shadow.raw_observations} <span className="muted small">({data.shadow.candidate_observations} candidates)</span></dd>
          <dt>Candidates not executed for a selection reason</dt><dd>{data.shadow.candidates_not_executed_for_a_selection_reason}</dd>
          <dt>Research-only candidates</dt><dd>{data.shadow.candidates_research_only}</dd>
          <dt>Unique market episodes</dt><dd>{data.shadow.unique_market_episodes}</dd>
          <dt>Unique clusters</dt><dd>{data.shadow.unique_observation_clusters}</dd>
          <dt>Paper trades: complete-path / legacy / open</dt><dd>{data.paper.complete_path_finalized_trades} / {data.paper.legacy_unlinked} / {data.paper.open}</dd>
        </dl>

        <h3>Replayed Shadow episodes, by cohort</h3>
        <Table head={['Cohort', 'Replayed', 'Clusters', 'Market episodes', '3H units']} empty={Object.keys(data.executable_shadow).length ? false : 'Nothing replayed yet.'}>
          {Object.entries(data.executable_shadow).map(([k, v]) => (
            <tr key={k} data-cohort={k}><td>{COHORT_LABEL[k] ?? k}</td><td>{v.replayed_observations}</td><td>{v.observation_clusters}</td><td>{v.market_episodes}</td><td>{v.independence_units_3h}</td></tr>
          ))}
        </Table>
        <p className="muted small">{data.cohort_B_C_note}</p>

        <h3>CURRENT policy vs adaptive policies (paper, complete path)</h3>
        <Table head={['Policy', 'Trades', 'Mean R', 'CURRENT mean R', 'Difference', 'Verdict']} empty="No finalized complete-path trade has a counterfactual yet.">
          {Object.entries(data.current_vs_adaptive).map(([name, m]) => (
            <tr key={name}><td className="mono small">{name}</td><td>{m.trades}</td><td>{r(m.mean_R)}</td><td>{r(m.baseline_mean_R)}</td><td>{r(m.delta_mean_R)}</td>
              <td><Badge kind={m.verdict === 'PASS' ? 'pos' : m.verdict === 'FAIL' ? 'neg' : 'neutral'}>{m.verdict}</Badge></td></tr>
          ))}
        </Table>

        <h3>Evidence per day</h3>
        <Table head={['Day (UTC)', 'Shadow replays', 'Complete-path paper trades']} empty="No evidence has been recorded yet.">
          {data.daily.map((d) => <tr key={d.day_utc_ms}><td>{day(d.day_utc_ms)}</td><td>{d.shadow_replays}</td><td>{d.paper_complete_trades}</td></tr>)}
        </Table>
      </Panel>
    </section>
  );
}

export function ExitEvidence() {
  const { data, error } = usePoll(api.exitEvidence, 15000);
  return <ExitEvidenceView data={data} error={error} />;
}
