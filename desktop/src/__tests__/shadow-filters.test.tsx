import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import type { ShadowRow } from '../api';
import { applyShadowFilter, EMPTY_SHADOW_FILTER, resolutionBucket, Shadow, SHADOW_FETCH_LIMIT, ShadowFilter } from '../screens/Shadow';

afterEach(() => { cleanup(); invoke.mockReset(); });

const day = (d: string, h = 12) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).getTime();

function obs(id: string, over: Partial<ShadowRow>): ShadowRow {
  return {
    observation_id: id, scan_id: `scan-${id}`, kind: 'CANDIDATE', asset: 'ETH', direction: 'long', strategy: 'TREND CONTINUATION',
    decision_ts: day('2026-09-27'), production_rank: 1, scan_candidate_rank: 1, is_production_pick: 1, production_state: 'RANKED_WITH_GEOMETRY',
    execution_status: 'EXECUTED', execution_rejection_reason: null, research_candidate_valid: 1, invalid_reason: null,
    observation_cluster_id: `clu-${id}`, market_episode_id: 'ep-ETH-1', overlap_fraction: 0, resolution_status: 'RESOLVED', classification: null,
    ...over,
  };
}

// Varied fixture: every filter dimension has matching and non-matching rows.
const ROWS: ShadowRow[] = [
  obs('a', {}),
  obs('b', { asset: 'BTC', direction: 'short', strategy: 'BREAKOUT RETEST', production_rank: 3, scan_candidate_rank: 4, execution_status: 'REJECTED',
    execution_rejection_reason: 'ENTRIES_PAUSED', resolution_status: 'PENDING', decision_ts: day('2026-09-26'), market_episode_id: 'ep-BTC-7', observation_cluster_id: 'clu-BTC-short-x' }),
  obs('c', { asset: 'SOL', strategy: 'MEAN REVERSION', production_rank: null, scan_candidate_rank: 6, execution_status: 'NOT_SUBMITTED',
    resolution_status: 'PARTIAL', decision_ts: day('2026-09-28', 1), market_episode_id: 'ep-SOL-2' }),
  obs('d', { kind: 'MARKET_STATE', asset: 'ETH', direction: null, strategy: null, production_rank: null, scan_candidate_rank: null,
    production_state: 'NO_TRADE', execution_status: 'NOT_APPLICABLE', resolution_status: null, decision_ts: day('2026-09-28', 23) }),
  obs('e', { kind: 'MARKET_STATE', asset: 'BTC', direction: null, strategy: null, production_rank: null, scan_candidate_rank: null,
    production_state: 'RANKED_NO_GEOMETRY', execution_status: 'NO_SIGNAL', resolution_status: 'NOT_RESOLVABLE_INVALID_SNAPSHOT', market_episode_id: 'ep-BTC-7' }),
];

const ids = (f: Partial<ShadowFilter>) => applyShadowFilter(ROWS, { ...EMPTY_SHADOW_FILTER, ...f }).map((r) => r.observation_id);

describe('shadow filter logic', () => {
  it('no filter keeps every row', () => expect(ids({})).toEqual(['a', 'b', 'c', 'd', 'e']));
  it('asset', () => expect(ids({ asset: 'BTC' })).toEqual(['b', 'e']));
  it('direction, including rows with no direction', () => {
    expect(ids({ direction: 'long' })).toEqual(['a', 'c']);
    expect(ids({ direction: 'short' })).toEqual(['b']);
    expect(ids({ direction: 'none' })).toEqual(['d', 'e']);
  });
  it('strategy', () => expect(ids({ strategy: 'MEAN REVERSION' })).toEqual(['c']));
  it('rank uses production rank, else scan rank, and drops unranked rows', () => {
    expect(ids({ maxRank: '1' })).toEqual(['a']);
    expect(ids({ maxRank: '3' })).toEqual(['a', 'b']);
    expect(ids({ maxRank: '6' })).toEqual(['a', 'b', 'c']);
  });
  it('accepted / rejected via execution status', () => {
    expect(ids({ execution: 'EXECUTED' })).toEqual(['a']);
    expect(ids({ execution: 'REJECTED' })).toEqual(['b']);
  });
  it('no-trade states only, or excluded', () => {
    expect(ids({ noTrade: 'only' })).toEqual(['d']);
    expect(ids({ noTrade: 'exclude' })).toEqual(['a', 'b', 'c', 'e']);
  });
  it('resolved / partial / unresolved / not resolvable', () => {
    expect(ids({ resolution: 'resolved' })).toEqual(['a']);
    expect(ids({ resolution: 'partial' })).toEqual(['c']);
    expect(ids({ resolution: 'unresolved' })).toEqual(['b', 'd']);
    expect(ids({ resolution: 'not_resolvable' })).toEqual(['e']);
    expect(resolutionBucket('RESOLVED_WITH_GAPS')).toBe('resolved');
  });
  it('date range is inclusive of whole local days', () => {
    expect(ids({ from: '2026-09-28' })).toEqual(['c', 'd']);
    expect(ids({ to: '2026-09-26' })).toEqual(['b']);
    expect(ids({ from: '2026-09-27', to: '2026-09-27' })).toEqual(['a', 'e']);
  });
  it('episode and cluster match by substring, case-insensitive', () => {
    expect(ids({ episode: 'ep-btc-7' })).toEqual(['b', 'e']);
    expect(ids({ cluster: 'BTC-short' })).toEqual(['b']);
  });
  it('filters combine with AND', () => {
    expect(ids({ asset: 'BTC', episode: 'ep-BTC-7', direction: 'none' })).toEqual(['e']);
    expect(ids({ asset: 'ETH', noTrade: 'exclude', resolution: 'resolved' })).toEqual(['a']);
    expect(ids({ asset: 'SOL', execution: 'EXECUTED' })).toEqual([]);
  });
});

describe('shadow screen filter bar', () => {
  function backend(rows: ShadowRow[] = ROWS) {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_shadow_observations') return { observations: rows };
      return null;
    });
  }
  const tableRows = (c: HTMLElement) => c.querySelectorAll('tbody tr');

  it('narrows the table, reports the count, combines filters and clears', async () => {
    backend();
    const { container } = render(<Shadow />);
    expect(await screen.findByText('Showing 5 of 5 observations.')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_shadow_observations', { filter: { limit: SHADOW_FETCH_LIMIT } });
    const bar = screen.getByRole('group', { name: 'Shadow filters' });
    // options come from the fetched rows
    expect(within(bar).getByRole('option', { name: 'SOL' })).toBeInTheDocument();
    fireEvent.change(within(bar).getByLabelText('Asset'), { target: { value: 'BTC' } });
    expect(tableRows(container)).toHaveLength(2);
    fireEvent.change(within(bar).getByLabelText('Execution'), { target: { value: 'REJECTED' } });
    expect(tableRows(container)).toHaveLength(1);
    expect(screen.getByText('Showing 1 of 5 observations.')).toBeInTheDocument();
    expect(screen.getByText(/ENTRIES_PAUSED/)).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear filters' }));
    expect(tableRows(container)).toHaveLength(5);
    expect(within(bar).getByRole('button', { name: 'Clear filters' })).toBeDisabled();
  });

  it('no-trade, date and cluster controls work from the screen', async () => {
    backend();
    const { container } = render(<Shadow />);
    await screen.findByText('Showing 5 of 5 observations.');
    const bar = screen.getByRole('group', { name: 'Shadow filters' });
    fireEvent.change(within(bar).getByLabelText('No-trade'), { target: { value: 'only' } });
    expect(screen.getByText('NO-TRADE STATE')).toBeInTheDocument();
    expect(tableRows(container)).toHaveLength(1);
    fireEvent.change(within(bar).getByLabelText('No-trade'), { target: { value: '' } });
    fireEvent.change(within(bar).getByLabelText('From date'), { target: { value: '2026-09-28' } });
    expect(tableRows(container)).toHaveLength(2);
    fireEvent.change(within(bar).getByLabelText('Cluster'), { target: { value: 'clu-c' } });
    expect(tableRows(container)).toHaveLength(1);
  });

  it('says when the fetched window is full, so older rows are not silently filtered', async () => {
    backend(Array.from({ length: SHADOW_FETCH_LIMIT }, (_, i) => obs(`r${i}`, {})));
    render(<Shadow />);
    expect(await screen.findByText(/latest 1000 fetched; older rows are not filtered/)).toBeInTheDocument();
  });
});
