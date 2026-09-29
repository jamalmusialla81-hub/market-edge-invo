import { useEffect, useRef, useState } from 'react';
import { api, AppInfo, errorText, Health, Level, LogEntry, LogFile, SecretsStatus } from '../api';
import { Badge, Dot, Panel, Table } from '../components/ui';
import { DASH, duration, ts } from '../format';
import { ResearchExport } from './ResearchExport';

const LEVELS: Level[] = ['INFO', 'WARN', 'ERROR', 'RISK', 'EXECUTION'];
const SECRET_LABELS: Record<string, string> = {
  'binance-testnet-api-key': 'Binance Futures TESTNET API key',
  'binance-testnet-api-secret': 'Binance Futures TESTNET API secret',
};

const LOG_FILES: LogFile[] = ['desktop', 'execution-service', 'forward-loop', 'reconciliation'];

/** Tails the rotating log files in the app-data logs folder. */
export function LogView() {
  const [file, setFile] = useState<LogFile>('desktop');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [levels, setLevels] = useState<Set<Level>>(new Set(LEVELS));
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setEntries([]);
    const tick = async () => {
      try {
        const r = await api.logs(file, 1500);
        if (!alive) return;
        setPath(r.path);
        setEntries(r.entries);
      } catch { /* controller errors surface in the top banner */ }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [file]);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [entries, follow]);

  const shown = entries.filter((e) => levels.has(e.level));
  const toggle = (l: Level) => { const n = new Set(levels); if (n.has(l)) n.delete(l); else n.add(l); setLevels(n); };
  return (
    <Panel title="Logs" right={
      <div className="seg">
        <select aria-label="Log file" value={file} onChange={(e) => setFile(e.target.value as LogFile)}>
          {LOG_FILES.map((f) => <option key={f} value={f}>{f}.log</option>)}
        </select>
        {LEVELS.map((l) => <button key={l} className={`seg-btn lvl-${l.toLowerCase()} ${levels.has(l) ? 'active' : ''}`} onClick={() => toggle(l)}>{l}</button>)}
        <label className="follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
      </div>}>
      {path && <div className="muted small mono">{path}</div>}
      <div className="logs" ref={box}>
        {shown.length ? shown.map((e, i) => (
          <div key={`${e.at_ms}-${e.seq}-${i}`} className={`log log-${e.level.toLowerCase()}`}>
            <span className="log-ts">{ts(e.at_ms).slice(11)}</span>
            <span className="log-lvl">{e.level}</span>
            <span className="log-src">{e.source}</span>
            <span className="log-msg">{e.message}</span>
          </div>
        )) : <div className="muted">No log lines yet.</div>}
      </div>
    </Panel>
  );
}

function Secrets() {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { api.secretsStatus().then(setStatus).catch((e) => setMsg(errorText(e))); }, []);
  const save = async (name: string) => {
    try { setStatus(await api.setSecret(name, values[name] ?? '')); setValues({ ...values, [name]: '' }); setMsg(`${SECRET_LABELS[name]} stored in ${status?.store}`); } catch (e) { setMsg(errorText(e)); }
  };
  const remove = async (name: string) => {
    try { setStatus(await api.deleteSecret(name)); setMsg(`${SECRET_LABELS[name]} removed`); } catch (e) { setMsg(errorText(e)); }
  };
  return (
    <Panel title="Secrets" right={<span className="muted small">Stored in {status?.store ?? '…'}; values are never shown or sent to this window again</span>}>
      <dl className="kv">
        <dt>Service API key</dt>
        <dd>{status?.service_api_key ? (status.service_api_key.persisted ? <Badge kind="pos">in {status.service_api_key.store}</Badge> : <Badge kind="warn">memory only: {status.service_api_key.warning}</Badge>) : DASH}</dd>
      </dl>
      {status?.secrets.map((s) => (
        <form key={s.name} className="secret-row" onSubmit={(e) => { e.preventDefault(); void save(s.name); }}>
          <span className="setting-label">{SECRET_LABELS[s.name] ?? s.name}</span>
          {s.configured ? <Badge kind="pos">configured</Badge> : <Badge>not set</Badge>}
          <input type="password" autoComplete="off" placeholder={s.configured ? 'replace…' : 'paste testnet value'} value={values[s.name] ?? ''}
            onChange={(e) => setValues({ ...values, [s.name]: e.target.value })} />
          <button className="btn" type="submit" disabled={!(values[s.name] ?? '').trim()}>Store</button>
          <button className="btn" type="button" disabled={!s.configured} onClick={() => void remove(s.name)}>Remove</button>
        </form>
      ))}
      <div className="muted small">Testnet only. There is no slot for mainnet credentials. TESTNET mode stays disabled until a testnet backend is wired into the execution-service.</div>
      {msg && <div className="control-msg">{msg}</div>}
    </Panel>
  );
}

export function SystemScreen({ health, info }: { health: Health | null; info: AppInfo | null }) {
  const [msg, setMsg] = useState<string | null>(null);
  const restart = async () => { setMsg('Starting execution-service…'); try { await api.restartServices(); setMsg('execution-service healthy'); } catch (e) { setMsg(errorText(e)); } };
  return (
    <div className="screen">
      <div className="grid-2">
        <Panel title="Components" right={health?.execution_service?.state === 'FAILED' || health?.startup_error || health?.supervisor?.exec_gave_up ? <button className="btn" onClick={restart}>RESTART SERVICES</button> : undefined}>
          <Table head={['', 'Component', 'Status', 'Detail']}>
            {(health?.components ?? []).map((c) => (
              <tr key={c.name}><td><Dot status={c.status} /></td><td><b>{c.name}</b></td><td>{c.status}</td><td className="small">{c.detail}</td></tr>
            ))}
          </Table>
          {msg && <div className="control-msg">{msg}</div>}
        </Panel>
        <Panel title="Processes & configuration">
          <dl className="kv">
            <dt>execution-service</dt><dd>{health?.execution_service ? `${health.execution_service.state}${health.execution_service.pid ? ` · pid ${health.execution_service.pid}` : ''}` : DASH} {health?.status && <span className="muted">· up {duration(health.status.uptime_s)}</span>}</dd>
            <dt>forward loop</dt><dd>{health?.forward_loop ? `${health.forward_loop.state}${health.forward_loop.pid ? ` · pid ${health.forward_loop.pid}` : ''}` : DASH} {health?.forward_loop?.last_exit && <span className="muted">· {health.forward_loop.last_exit}</span>}</dd>
            <dt>cycles this session</dt><dd>{health?.loop?.cycles_seen ?? DASH}</dd>
            <dt>Supervisor</dt><dd className="small">{health?.supervisor ? `${health.supervisor.exec_restarts_in_window} service / ${health.supervisor.loop_restarts_in_window} loop restarts in window` : DASH}{health?.supervisor?.last_action && <div className="muted">{health.supervisor.last_action}</div>}</dd>
            <dt>Layout</dt><dd>{info?.config?.layout === 'BUNDLED' ? 'installed app (bundled services)' : info?.config ? 'developer checkout' : DASH}</dd>
            <dt>Database</dt><dd className="mono small">{info?.config?.db_path ?? DASH}</dd>
            <dt>Service</dt><dd className="mono small">127.0.0.1:{info?.config?.port ?? DASH} · {info?.config?.execution_service}</dd>
            <dt>Scanner runtime</dt><dd className="mono small">{info?.config?.node} {info?.node_version}</dd>
            <dt>Cycle interval</dt><dd>{info?.config ? duration(info.config.cycle_interval_ms / 1000) : DASH}</dd>
            <dt>LIVE trading</dt><dd><Badge kind="neg">DISABLED IN THIS BUILD</Badge></dd>
          </dl>
        </Panel>
      </div>
      <LogView />
      <ResearchExport />
      <Secrets />
    </div>
  );
}
