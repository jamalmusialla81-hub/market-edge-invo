import { useState } from 'react';
import { api, errorText, ResearchExportManifest } from '../api';
import { Badge, Panel, usePoll } from '../components/ui';

// Read-only export of research data for offline analysis. The service opens
// both databases read-only; decision-time, outcome and hindsight data are
// written to separate files. This is not a backup and cannot be restored.

const SECTION_KIND = { DECISION: 'info', LEDGER: 'neutral', OUTCOME: 'neutral', HINDSIGHT: 'warn' } as const;

export function ResearchExport() {
  const info = usePoll(api.researchExportInfo, 60000);
  const [format, setFormat] = useState<'csv' | 'parquet'>('csv');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResearchExportManifest | null>(null);
  const formats = info.data?.formats ?? ['csv'];

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.exportResearch(format);
      if (!r.cancelled) setResult(r);
    } catch (e) { setError(`Export failed: ${errorText(e)}`); } finally { setBusy(false); }
  };

  return (
    <Panel title="Research export" right={
      <span className="seg">
        <select aria-label="Export format" value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'parquet')}>
          {formats.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
        </select>
        <button className="btn btn-small" disabled={busy} onClick={() => void run()}>EXPORT RESEARCH DATA</button>
      </span>}>
      <p className="muted small">
        Writes shadow observations, outcome labels, post-outcome research and paper trades to a new folder you choose, for analysis in a
        spreadsheet or pandas. Read-only: nothing in the app changes. Files starting DECISION__ hold only what was known at decision
        time; LEDGER__ holds paper trades with their realized exits; OUTCOME__ holds labels and events written after the fact; HINDSIGHT__ is post-outcome research only. No secrets or settings
        are exported. This is not a backup.
      </p>
      {(info.data?.not_yet_available ?? []).length > 0 && (
        <p className="muted small">Not exportable yet: {info.data!.not_yet_available.map((c) => c.category.replace(/_/g, ' ')).join(', ')} (no data is recorded for them yet).</p>
      )}
      {error && <div className="control-msg err" role="status">{error}</div>}
      {result && (
        <div className="control-msg ok" role="status">
          <div>Exported to <span className="mono small">{result.folder}</span></div>
          <ul className="small">
            {result.files.map((f) => (
              <li key={f.file}><Badge kind={SECTION_KIND[f.section]}>{f.section}</Badge> <span className="mono">{f.file}</span> · {f.rows} rows</li>
            ))}
          </ul>
          {result.skipped.length > 0 && <div className="muted small">Skipped: {result.skipped.map((s) => `${s.file} (${s.reason})`).join('; ')}</div>}
        </div>
      )}
    </Panel>
  );
}
