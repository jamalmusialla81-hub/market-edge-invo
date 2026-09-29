import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { ResearchExport } from '../screens/ResearchExport';

afterEach(() => { cleanup(); invoke.mockReset(); });

const manifest = {
  schema: 'research-export/v1', created_at: '2026-09-28T10:00:00+00:00', format: 'csv', folder: '/Users/x/Desktop/market-edge-research-20260928T100000Z', read_only: true,
  files: [
    { file: 'DECISION__shadow_observations.csv', rows: 120, columns: ['observation_id'], section: 'DECISION', source: 'shadow:shadow_observations' },
    { file: 'OUTCOME__shadow_labels.csv', rows: 300, columns: ['observation_id'], section: 'OUTCOME', source: 'shadow:shadow_labels' },
    { file: 'HINDSIGHT__shadow_post_outcome_research_only.csv', rows: 40, columns: ['observation_id'], section: 'HINDSIGHT', source: 'shadow:shadow_hindsight' },
  ],
  skipped: [], not_yet_available: [{ category: 'risk_sizing', reason: 'MAJOR 2' }, { category: 'adaptive_exit_counterfactuals', reason: 'MAJOR 3G' }],
};

function backend(exportResult: () => unknown, formats = ['csv', 'parquet']) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_research_export_info') return { formats, not_yet_available: manifest.not_yet_available };
    if (cmd === 'export_research') return exportResult();
    return null;
  });
}

describe('research export', () => {
  it('exports in the chosen format and lists files by decision / outcome / hindsight section', async () => {
    backend(() => manifest);
    render(<ResearchExport />);
    expect(await screen.findByText(/Not exportable yet: risk sizing, adaptive exit counterfactuals/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'parquet' } });
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT RESEARCH DATA' }));
    expect(await screen.findByText(/market-edge-research-20260928T100000Z/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('export_research', { format: 'parquet' });
    for (const s of ['DECISION', 'OUTCOME', 'HINDSIGHT']) expect(screen.getByText(s)).toBeInTheDocument();
    expect(screen.getByText('HINDSIGHT__shadow_post_outcome_research_only.csv')).toBeInTheDocument();
    expect(screen.getByText(/120 rows/)).toBeInTheDocument();
  });

  it('a cancelled folder picker changes nothing; errors are shown', async () => {
    backend(() => ({ cancelled: true }), ['csv']);
    render(<ResearchExport />);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('get_research_export_info'));
    expect(screen.queryByRole('option', { name: 'PARQUET' })).toBeNull();   // only formats the backend supports
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT RESEARCH DATA' }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('export_research', { format: 'csv' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'EXPORT RESEARCH DATA' })).toBeEnabled());
    expect(screen.queryByText(/Exported to/)).toBeNull();
    invoke.mockImplementation(async (cmd: string) => { if (cmd === 'export_research') throw 'HTTP 422: OUT_DIR_INVALID'; return { formats: ['csv'], not_yet_available: [] }; });
    fireEvent.click(screen.getByRole('button', { name: 'EXPORT RESEARCH DATA' }));
    expect(await screen.findByText('Export failed: HTTP 422: OUT_DIR_INVALID')).toBeInTheDocument();
  });
});
