import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import type { ResearchStatus } from '../api';
import { Research, ResearchView } from '../screens/Research';

afterEach(() => { cleanup(); invoke.mockReset(); });

const LABELS = {
  PRODUCTION: 'PRODUCTION · PAPER TRADING · NOT CONTROLLED BY RESEARCH',
  SHADOW: 'SHADOW · DECISION-TIME OBSERVATION · NO CAPITAL · NO ORDERS',
  POST_OUTCOME_RESEARCH: 'POST-OUTCOME RESEARCH · COMPUTED FROM RESOLVED OUTCOMES · NEVER A DECISION-TIME VALUE',
};

function status(over: Partial<ResearchStatus['shadow']> = {}, post: Partial<ResearchStatus['post_outcome_research']> = {}): ResearchStatus {
  return {
    status_version: 'RESEARCH-STATUS-V1', generated_at_ms: 1_800_000_000_000, read_only: true, labels: LABELS,
    production: { label: LABELS.PRODUCTION, risk_sizing_mode: 'SHADOW', live: 'DISABLED', controlled_by_research: false, statement: 'Quant scoring, risk policy and exits are not changed by anything on this screen.' },
    shadow: {
      label: LABELS.SHADOW,
      counts: { scans: 0, observations: 0, candidate_observations: 0, resolved: 0, unresolved: 0, paper_executed: 0, independent_episodes: 0, choice_scans: 0, dataset_versions: [] },
      experiments: { total: 0, by_status: {}, recent: [] }, challengers_deployed: [], placebo_gates: [], lifecycle: [], drift_alerts: [], ...over,
    },
    post_outcome_research: { label: LABELS.POST_OUTCOME_RESEARCH, walk_forward_evaluations: [], forward_validations: [], ...post },
  };
}

const populated = status({
  counts: { scans: 40, observations: 200, candidate_observations: 120, resolved: 90, unresolved: 30, paper_executed: 6, independent_episodes: 33, choice_scans: 21, dataset_versions: ['FORWARD-SHADOW-RESOLVED-V1'] },
  experiments: { total: 3, by_status: { NO_EVIDENCE: 2, PROMISING: 1 }, recent: [{ experiment_id: 'exp-abc-1', model_type: 'WALK_FORWARD_EVALUATION', status: 'PROMISING', dataset_version: 'FORWARD-SHADOW-RESOLVED-V1-SNAPSHOT-20261001', attempt: 1 }] },
  challengers_deployed: [{ model_key: 'shadow-ridge-123', model_name: 'ridge', deployed_at_ms: 1, mode: 'SHADOW_OBSERVATION_ONLY',
    forward_validation: { experiment_id: 'exp-fv-1', status: 'NO_EVIDENCE', verdict: 'INSUFFICIENT_EVIDENCE', evidence: { resolved_scans: 8, independent_episodes: 8, forward_days: 400 },
      evidence_missing: ['resolved forward scans: have 8, need 60'], vs_production: null, promotable: false } }],
  placebo_gates: [{ experiment_id: 'exp-pg-1', model: 'ridge', status: 'PROMISING', passed: true, alpha: 0.05, runs: 40, variants: { shuffled_outcomes: { p_value: 0.024, passed: true } }, reasons: null }],
  lifecycle: [{ policy_id: 'p-research', policy_type: 'RANKING_MODEL', state: 'RESEARCH', subject_ref: null }, { policy_id: 'p-shadow', policy_type: 'RISK_SIZING', state: 'SHADOW', subject_ref: null },
    { policy_id: 'p-paper', policy_type: 'ADAPTIVE_EXIT', state: 'PAPER', subject_ref: null }, { policy_id: 'p-demoted', policy_type: 'STRATEGY_VARIANT', state: 'DEMOTED', subject_ref: null }],
  drift_alerts: [{ alert_id: 1, baseline: 'strategy-health', dimension: 'expectancy_R', level: 'ALERT', statistic: 4.2, at_ms: 1_800_000_000_000 }],
}, {
  walk_forward_evaluations: [{ experiment_id: 'exp-abc-1', status: 'PROMISING', dataset_version: 'd', n_folds: 4,
    challengers: { ridge: { evidence: 'PROMISING_PENDING_PLACEBO_GATE', mean_delta_vs_random_R: 0.21, ci95_vs_random: [0.05, 0.4], stability_vs_random: 'STABLE_POSITIVE' } } }],
});

describe('research dashboard', () => {
  it('shows PRODUCTION, SHADOW and POST-OUTCOME RESEARCH as three separate, distinctly labelled sections', () => {
    render(<ResearchView data={populated} error={null} />);
    const prod = screen.getByRole('region', { name: 'PRODUCTION' });
    const shadow = screen.getByRole('region', { name: 'SHADOW' });
    const post = screen.getByRole('region', { name: 'POST-OUTCOME RESEARCH' });
    expect(within(prod).getByText(LABELS.PRODUCTION)).toBeInTheDocument();
    expect(within(shadow).getByText(LABELS.SHADOW)).toBeInTheDocument();
    expect(within(post).getByText(LABELS.POST_OUTCOME_RESEARCH)).toBeInTheDocument();
    expect(within(prod).getByText(/LIVE DISABLED/)).toBeInTheDocument();
    // research figures never appear in the production section, and evidence intervals only appear under post-outcome research
    expect(within(prod).queryByText(/episodes|R$|interval/)).toBeNull();
    expect(within(shadow).queryByText(/STABLE_POSITIVE/)).toBeNull();
    expect(within(post).getByText('STABLE_POSITIVE')).toBeInTheDocument();
    expect(within(post).getByText('[0.050, 0.400] R')).toBeInTheDocument();
    expect(prod.contains(shadow) || shadow.contains(post) || post.contains(prod)).toBe(false);
  });

  it('shows a plain no-data state, not an empty table or invented rows, before anything has run', () => {
    render(<ResearchView data={status()} error={null} />);
    expect(screen.getByText(/No experiment has been recorded yet/)).toBeInTheDocument();
    expect(screen.getByText('No challenger is deployed. A challenger needs a passed placebo gate first.')).toBeInTheDocument();
    expect(screen.getByText('The placebo gate has not run.')).toBeInTheDocument();
    expect(screen.getByText('No policy has been registered in the lifecycle yet.')).toBeInTheDocument();
    expect(screen.getByText('No drift or health alerts recorded.')).toBeInTheDocument();
    expect(screen.getByText(/No walk-forward evaluation has run/)).toBeInTheDocument();
    expect(screen.getByText(/No forward validation yet/)).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /exp-/ })).toBeNull();
  });

  it('promotion badges reflect each policy\'s lifecycle state', () => {
    render(<ResearchView data={populated} error={null} />);
    const row = (id: string) => screen.getByText(id).closest('tr') as HTMLElement;
    expect(within(row('p-research')).getByText('RESEARCH')).toHaveClass('badge-neutral');
    expect(within(row('p-shadow')).getByText('SHADOW')).toHaveClass('badge-info');
    expect(within(row('p-paper')).getByText('PAPER')).toHaveClass('badge-pos');
    expect(within(row('p-demoted')).getByText('DEMOTED')).toHaveClass('badge-neg');
    expect(screen.getByText(/There is no LIVE state/)).toBeInTheDocument();
  });

  it('cites evidence counts and what is missing for a thin challenger, and never presents it as promotable', () => {
    render(<ResearchView data={populated} error={null} />);
    expect(screen.getByText('8 scans · 8 episodes · 400 days')).toBeInTheDocument();
    expect(screen.getByText('resolved forward scans: have 8, need 60')).toBeInTheDocument();
    expect(screen.getByText('INSUFFICIENT_EVIDENCE')).toBeInTheDocument();
  });

  it('has no control that changes anything: no buttons, inputs or selects', () => {
    const { container } = render(<ResearchView data={populated} error={null} />);
    expect(container.querySelectorAll('button, input, select, textarea, a[href]').length).toBe(0);
  });

  it('polls the read-only command and explains an older backend', async () => {
    invoke.mockRejectedValue('not found');
    render(<Research />);
    expect(await screen.findByText(/No research status: not found/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_research_status');
    expect(invoke.mock.calls.every((c) => c[0] === 'get_research_status')).toBe(true);
  });
});
