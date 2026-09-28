import { useState } from 'react';
import { api, AppInfo, BackupManifest, errorText } from '../api';
import { Badge, ConfirmDialog, Panel } from '../components/ui';
import { DASH } from '../format';

const str = (v: unknown) => (v === null || v === undefined || v === '' ? DASH : String(v));

function shadowText(m: BackupManifest): string {
  return m.shadow_included ? `${m.shadow_counts?.shadow_observations ?? 0} shadow observations` : 'no shadow research database';
}

function Backups() {
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ path: string; manifest: BackupManifest } | null>(null);

  const exportBackup = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.exportBackup();
      if (!r.cancelled && r.manifest) setMsg({ kind: 'ok', text: `Backup written to ${r.path} (schema v${r.manifest.schema_version}, ${r.manifest.counts.paper_trades ?? 0} trades, ${r.manifest.counts.paper_signals ?? 0} signals; ${shadowText(r.manifest)}; no secrets; local file only)` });
    } catch (e) { setMsg({ kind: 'err', text: `Export failed: ${errorText(e)}` }); } finally { setBusy(false); }
  };
  const importBackup = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.inspectBackup();
      if (!r.cancelled && r.manifest && r.path) setPending({ path: r.path, manifest: r.manifest });
    } catch (e) { setMsg({ kind: 'err', text: `Backup rejected: ${errorText(e)}` }); } finally { setBusy(false); }
  };
  const restore = async () => {
    setPending(null); setBusy(true);
    try {
      const r = await api.restoreBackup('RESTORE');
      setMsg({ kind: 'ok', text: `Restored. Reconciliation ${r.reconciled ? 'clean' : 'FAILED'}. New entries are paused until you press RESUME; the previous database was kept at ${r.previous_database_kept_at ?? DASH}.` });
    } catch (e) { setMsg({ kind: 'err', text: `Restore failed: ${errorText(e)}` }); } finally { setBusy(false); }
  };

  return (
    <Panel title="Backup & restore">
      <p className="muted small">A backup holds the paper database (paper account, trades, signals, positions, equity history, risk settings, reconciliation log), the shadow-learning research database (every observation, label and post-outcome record) and non-secret settings. API keys stay in the OS keychain and are never exported.</p>
      <p className="muted small"><b>No cloud backup.</b> Nothing leaves this computer automatically: a backup is a local file you export. Copy it somewhere safe yourself.</p>
      <div className="controls-inline">
        <button className="btn" disabled={busy} onClick={exportBackup}>EXPORT BACKUP</button>
        <button className="btn btn-warn" disabled={busy} onClick={importBackup}>IMPORT BACKUP</button>
      </div>
      {msg && <div className={`control-msg ${msg.kind}`} role="status">{msg.text}</div>}
      {pending && (
        <ConfirmDialog title="Restore this backup?" word="RESTORE" confirmLabel="Restore backup"
          body={<>
            <p><b>{pending.path}</b></p>
            <p>Created {pending.manifest.created_at} by Market Edge {pending.manifest.app_version}; schema v{pending.manifest.schema_version}; {pending.manifest.counts.paper_trades ?? 0} trades, {pending.manifest.counts.paper_signals ?? 0} signals; {shadowText(pending.manifest)}. Checksums and database integrity verified.</p>
            {!pending.manifest.shadow_included && <p>This backup has no shadow research database; the current one is kept as it is.</p>}
            <p>The paper loop stops, the current database is kept in the backups folder, the backup replaces it, and a reconciliation runs. New entries stay paused until you resume.</p>
          </>}
          onCancel={() => setPending(null)} onConfirm={() => void restore()} />
      )}
    </Panel>
  );
}

export function About({ info }: { info: AppInfo | null }) {
  const b = info?.build_info ?? {};
  const packaging = (b.packaging ?? {}) as Record<string, unknown>;
  const backendBuild = info?.backend.build ?? {};
  return (
    <div className="screen">
      <div className="grid-2">
        <Panel title="About Market Edge">
          <dl className="kv">
            <dt>Version</dt><dd><b>{info?.version ?? DASH}</b> <Badge kind="neg">LIVE DISABLED</Badge> <Badge kind="pos">PAPER</Badge></dd>
            <dt>Git commit</dt><dd className="mono small">{info?.git_sha ?? DASH}</dd>
            <dt>Built</dt><dd>{info?.build_timestamp ?? DASH}</dd>
            <dt>Platform</dt><dd>{str(b.target)}</dd>
            <dt>Backend version</dt><dd>{str(info?.backend.version)} <span className="muted small">{backendBuild.frozen ? `(frozen, Python ${str(backendBuild.python)})` : ''}</span></dd>
            <dt>Database schema</dt><dd>v{str(info?.backend.schema_version)}</dd>
            <dt>Node runtime</dt><dd>{str(info?.node_version)}</dd>
            <dt>Layout</dt><dd>{info?.config?.layout === 'BUNDLED' ? 'Installed app (bundled services)' : info?.config ? 'Developer checkout' : DASH}</dd>
          </dl>
        </Panel>
        <Panel title="Where things are">
          <dl className="kv">
            <dt>Your data</dt><dd className="mono small">{str(info?.data_dir)}</dd>
            <dt>Database</dt><dd className="mono small">{str(info?.config?.db_path)}</dd>
            <dt>Logs</dt><dd className="mono small">{str(info?.config?.logs_dir)}</dd>
            <dt>Backups</dt><dd className="mono small">{str(info?.config?.backups_dir)}</dd>
            <dt>App resources</dt><dd className="mono small">{str(info?.config?.resource_dir ?? info?.config?.repo_root)}</dd>
            <dt>execution-service</dt><dd className="small">{str(packaging['execution-service'])}</dd>
            <dt>forward loop</dt><dd className="small">{str(packaging['forward-loop'])}</dd>
            <dt>First run</dt><dd>{str(info?.user_config.first_run_at)}</dd>
          </dl>
        </Panel>
      </div>
      <Backups />
    </div>
  );
}
