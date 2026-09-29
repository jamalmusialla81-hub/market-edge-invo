import { api, ResearchStatus } from '../api';
import { Badge, Panel, Stat, Table, usePoll } from '../components/ui';
import { DASH, num, ts } from '../format';

// Display only. Nothing on this screen starts, stops, promotes or deploys anything. PRODUCTION, SHADOW and
// POST-OUTCOME RESEARCH are separate sections with separate labels, the same discipline as Trade Detail's
// hindsight overlay: a research figure can never be mistaken for a production one.

type Kind = 'pos' | 'neg' | 'warn' | 'neutral' | 'info';
const STATE_KIND: Record<string, Kind> = { RESEARCH: 'neutral', SHADOW: 'info', PAPER: 'pos', DEMOTED: 'neg' };
const STATUS_KIND: Record<string, Kind> = { PROMISING: 'info', SHADOW_CANDIDATE: 'info', NO_EVIDENCE: 'neutral', FAILED: 'neg', REJECTED: 'neg', RUNNING: 'warn', PLANNED: 'neutral', SUPERSEDED: 'neutral' };
const LEVEL_KIND: Record<string, Kind> = { ALERT: 'neg', FLAG: 'warn', OK: 'pos' };

const ci = (v: [number, number] | null | undefined) => (v ? `[${num(v[0], 3)}, ${num(v[1], 3)}] R` : 'no interval');

export function ResearchView({ data, error }: { data: ResearchStatus | null; error: string | null }) {
  if (!data) {
    return (
      <Panel title="Research pipeline">
        <div className="muted">{error ? `No research status: ${error}. An older execution-service build does not report it.` : 'Loading research status…'}</div>
      </Panel>
    );
  }
  const { production: prod, shadow: sh, post_outcome_research: post } = data;
  const c = sh.counts;
  const nothingRun = sh.experiments.total === 0;
  return (
    <div className="research">
      <p className="muted small">Read-only. Nothing on this screen changes trading, sizing, exits, research or any deployment. The observation table and filters are on the Shadow screen.</p>

      <section aria-label="PRODUCTION">
        <Panel title="PRODUCTION" right={<Badge kind="pos">PAPER ONLY · LIVE {prod.live}</Badge>}>
          <div className="muted small">{prod.label}</div>
          <dl className="kv">
            <dt>Risk sizing mode</dt><dd>{prod.risk_sizing_mode ?? DASH}</dd>
            <dt>Controlled by research</dt><dd><Badge kind="pos">NO</Badge> <span className="muted small">{prod.statement}</span></dd>
          </dl>
        </Panel>
      </section>

      <section aria-label="SHADOW">
        <Panel title="SHADOW" right={<Badge kind="info">NO CAPITAL · NO ORDERS</Badge>}>
          <div className="muted small">{sh.label}</div>
          <div className="stat-grid" aria-label="Forward evidence counts">
            <Stat label="Forward observations" value={c.observations} sub={`${c.candidate_observations} candidates · ${c.scans} scans`} big />
            <Stat label="Resolved" value={c.resolved} sub={`${c.unresolved} still unresolved`} />
            <Stat label="Independent episodes" value={c.independent_episodes} />
            <Stat label="Choice scans" value={c.choice_scans} sub="two or more valid candidates" />
            <Stat label="Paper executed" value={c.paper_executed} />
            <Stat label="Dataset versions" value={c.dataset_versions.length ? c.dataset_versions.join(', ') : DASH} />
          </div>

          <h3>Experiment history</h3>
          {nothingRun ? <div className="muted">No experiment has been recorded yet. Nothing has been trained, evaluated or gated.</div> : (
            <>
              <div className="row">{Object.entries(sh.experiments.by_status).map(([k, n]) => <Badge key={k} kind={STATUS_KIND[k] ?? 'neutral'}>{k} {n}</Badge>)}</div>
              <Table head={['Experiment', 'Type', 'Status', 'Dataset', 'Attempt']}>
                {sh.experiments.recent.map((e) => (
                  <tr key={e.experiment_id}><td className="mono small">{e.experiment_id}</td><td>{e.model_type}</td>
                    <td><Badge kind={STATUS_KIND[e.status] ?? 'neutral'}>{e.status}</Badge></td><td className="small">{e.dataset_version}</td><td>{e.attempt}</td></tr>
                ))}
              </Table>
            </>
          )}

          <h3>Shadow challengers</h3>
          <Table head={['Challenger', 'Mode', 'Forward validation', 'Evidence']} empty={sh.challengers_deployed.length ? false : 'No challenger is deployed. A challenger needs a passed placebo gate first.'}>
            {sh.challengers_deployed.map((m) => {
              const v = m.forward_validation;
              return (
                <tr key={m.model_key}>
                  <td><b>{m.model_name}</b><div className="mono small">{m.model_key}</div></td>
                  <td><Badge kind="info">{m.mode}</Badge></td>
                  <td>{v ? <Badge kind={v.verdict === 'FORWARD_PROMISING' ? 'info' : 'neutral'}>{v.verdict ?? DASH}</Badge> : <span className="muted">not validated yet</span>}</td>
                  <td className="small">{v?.evidence ? `${v.evidence.resolved_scans ?? 0} scans · ${v.evidence.independent_episodes ?? 0} episodes · ${v.evidence.forward_days ?? 0} days` : DASH}
                    {v?.evidence_missing?.length ? <div className="muted">{v.evidence_missing.join('; ')}</div> : null}</td>
                </tr>
              );
            })}
          </Table>

          <h3>Placebo gate</h3>
          <Table head={['Model', 'Result', 'p-values (need ≤ alpha)']} empty={sh.placebo_gates.length ? false : 'The placebo gate has not run.'}>
            {sh.placebo_gates.map((g) => (
              <tr key={g.experiment_id}>
                <td>{g.model ?? DASH}</td>
                <td><Badge kind={g.passed ? 'pos' : 'neg'}>{g.passed ? 'PASSED' : 'NOT PASSED'}</Badge></td>
                <td className="small">{Object.entries(g.variants).map(([k, x]) => `${k} ${x.p_value === null ? DASH : num(x.p_value, 3)}`).join(' · ') || DASH}{g.alpha !== null ? ` (alpha ${g.alpha})` : ''}</td>
              </tr>
            ))}
          </Table>

          <h3>Promotion state</h3>
          <Table head={['Policy', 'Type', 'State']} empty={sh.lifecycle.length ? false : 'No policy has been registered in the lifecycle yet.'}>
            {sh.lifecycle.map((p) => (
              <tr key={p.policy_id}><td className="mono small">{p.policy_id}</td><td>{p.policy_type}</td><td><Badge kind={STATE_KIND[p.state] ?? 'neutral'}>{p.state}</Badge></td></tr>
            ))}
          </Table>
          <p className="muted small">Every move forward needs a person's logged authorization. There is no LIVE state.</p>

          <h3>Drift and health warnings</h3>
          <Table head={['When', 'Baseline', 'Dimension', 'Level']} empty={sh.drift_alerts.length ? false : 'No drift or health alerts recorded.'}>
            {sh.drift_alerts.map((a) => (
              <tr key={a.alert_id}><td>{ts(a.at_ms)}</td><td>{a.baseline}</td><td>{a.dimension}</td><td><Badge kind={LEVEL_KIND[a.level] ?? 'neutral'}>{a.level}</Badge></td></tr>
            ))}
          </Table>
        </Panel>
      </section>

      <section aria-label="POST-OUTCOME RESEARCH">
        <Panel title="POST-OUTCOME RESEARCH" right={<Badge kind="warn">COMPUTED FROM RESOLVED OUTCOMES</Badge>}>
          <div className="muted small">{post.label}</div>
          <h3>Walk-forward evidence</h3>
          {post.walk_forward_evaluations.length === 0 ? <div className="muted">No walk-forward evaluation has run, so there are no evidence figures or intervals to show.</div> : post.walk_forward_evaluations.map((e) => (
            <Table key={e.experiment_id} head={[`${e.experiment_id} · ${e.n_folds ?? DASH} folds`, 'Evidence', 'Delta vs random', 'Interval', 'Stability']}>
              {Object.entries(e.challengers).map(([m, x]) => (
                <tr key={m}><td><b>{m}</b></td><td><Badge kind={x.evidence === 'NO_EVIDENCE' ? 'neutral' : 'info'}>{x.evidence ?? DASH}</Badge></td>
                  <td>{x.mean_delta_vs_random_R === null ? DASH : `${num(x.mean_delta_vs_random_R, 3)} R`}</td><td className="small">{ci(x.ci95_vs_random)}</td><td className="small">{x.stability_vs_random ?? DASH}</td></tr>
              ))}
            </Table>
          ))}
          <h3>Forward validation</h3>
          {post.forward_validations.length === 0 ? <div className="muted">No forward validation yet: it needs a deployed challenger and resolved forward outcomes.</div> : (
            <Table head={['Experiment', 'Verdict', 'Delta vs production', 'Interval', 'Promotable']}>
              {post.forward_validations.map((v) => (
                <tr key={v.experiment_id}><td className="mono small">{v.experiment_id}</td><td><Badge kind={v.verdict === 'FORWARD_PROMISING' ? 'info' : 'neutral'}>{v.verdict ?? DASH}</Badge></td>
                  <td>{v.vs_production?.mean_delta_R == null ? DASH : `${num(v.vs_production.mean_delta_R, 3)} R`}</td><td className="small">{ci(v.vs_production?.ci95)}</td><td><Badge kind="neutral">NO</Badge></td></tr>
              ))}
            </Table>
          )}
        </Panel>
      </section>
    </div>
  );
}

export function Research() {
  const { data, error } = usePoll(api.researchStatus, 10000);
  return <ResearchView data={data} error={error} />;
}
