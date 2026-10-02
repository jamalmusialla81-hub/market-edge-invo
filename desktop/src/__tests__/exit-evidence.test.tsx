import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import type { ExitEvidence as ExitEvidenceData } from '../api';
import { ExitEvidence, ExitEvidenceView } from '../screens/ExitEvidence';

afterEach(() => { cleanup(); invoke.mockReset(); });

const LABEL = 'POST-OUTCOME RESEARCH ONLY · NOT AN ACTION THE BOT TOOK';

function data(over: Partial<ExitEvidenceData> = {}): ExitEvidenceData {
  return {
    label: LABEL, read_only: true, generated_at_ms: 1_800_000_000_000,
    shadow: { raw_observations: 0, candidate_observations: 0, candidates_not_executed_for_a_selection_reason: 0, candidates_research_only: 0, unique_market_episodes: 0, unique_observation_clusters: 0 },
    paper: { complete_path_finalized_trades: 0, legacy_unlinked: 0, open: 0, path_incomplete: 0, replays_missing: 0 },
    executable_shadow: {}, entry_failure_episodes: 0, giveback_failure_episodes: 0,
    gate: { bar: 'EXIT-EVIDENCE-BAR-V1', paper_finalized: 0, paper_finalized_needed: 30, independent_episodes: 0, independent_episodes_needed: 30, verdicts: {}, passing_policies: [], passing_summary: 'NONE' },
    current_vs_adaptive: {}, pipeline: { status: 'OK', degraded_trades: [] }, cohort_B_C_note: 'Supporting evidence. They never count toward the paper bar.',
    next_evaluation_condition: 'The paper bar needs 30 finalized complete-path trades in 30 independent 24h episodes (now 0 / 0).',
    adaptive_exits_enabled: { PAPER: false, PAPER_CANARY: false }, daily: [], ...over,
  };
}

describe('exit evidence dashboard', () => {
  it('renders with empty data, says no policy passes and keeps the research-only label', () => {
    render(<ExitEvidenceView data={data()} error={null} />);
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.getAllByText('0 / 30')).toHaveLength(2);
    expect(screen.getByText('NONE')).toBeInTheDocument();
    expect(screen.getByText('Nothing replayed yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();     // no control of any kind
  });

  it('renders partial data: cohorts, per-day evidence and the paper-versus-shadow split', () => {
    render(<ExitEvidenceView data={data({
      shadow: { raw_observations: 900, candidate_observations: 400, candidates_not_executed_for_a_selection_reason: 120, candidates_research_only: 250, unique_market_episodes: 31, unique_observation_clusters: 88 },
      paper: { complete_path_finalized_trades: 1, legacy_unlinked: 3, open: 4, path_incomplete: 0, replays_missing: 0 },
      executable_shadow: { B_EXECUTABLE_SHADOW: { replayed_observations: 12, observation_clusters: 12, market_episodes: 9, independence_units_3h: 5 } },
      entry_failure_episodes: 4, giveback_failure_episodes: 2,
      current_vs_adaptive: { MFE_TRAIL_33: { trades: 1, mean_R: 0.4, baseline_mean_R: 0.2, delta_mean_R: 0.2, verdict: 'INSUFFICIENT_EVIDENCE' } },
      daily: [{ day_utc_ms: 1_790_000_000_000, shadow_replays: 12, paper_complete_trades: 1 }],
    })} error={null} />);
    const row = document.querySelector('[data-cohort="B_EXECUTABLE_SHADOW"]') as HTMLElement;
    expect(within(row).getByText('Executable Shadow (Cohort B)')).toBeInTheDocument();
    expect(screen.getByText('MFE_TRAIL_33')).toBeInTheDocument();
    expect(screen.getByText('INSUFFICIENT_EVIDENCE')).toBeInTheDocument();
    expect(screen.getByText(/never count toward the paper bar/)).toBeInTheDocument();
  });

  it('shows the degraded banner with the exact trade ids and missing policies', () => {
    render(<ExitEvidenceView data={data({ pipeline: { status: 'RESEARCH_PIPELINE_DEGRADED', degraded_trades: [{ trade_id: 'sig-9', label: 'PATH_INCOMPLETE', reasons: ['GAP_OF_90MIN'], missing_policies: ['MFE_TRAIL_33'] }] } })} error={null} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('RESEARCH_PIPELINE_DEGRADED');
    expect(alert).toHaveTextContent('sig-9');
    expect(alert).toHaveTextContent('MFE_TRAIL_33');
  });

  it('explains an older backend and only ever calls the read-only command', async () => {
    invoke.mockRejectedValue('not found');
    render(<ExitEvidence />);
    expect(await screen.findByText(/No exit evidence: not found/)).toBeInTheDocument();
    expect(invoke.mock.calls.every((c) => c[0] === 'get_exit_evidence')).toBe(true);
  });
});
