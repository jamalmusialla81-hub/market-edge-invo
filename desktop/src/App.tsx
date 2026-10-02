import { useEffect, useState } from 'react';
import { api, AppInfo, errorText, Health, Mode } from './api';
import { ConfirmDialog, Dot, usePoll } from './components/ui';
import { Dashboard } from './screens/Dashboard';
import { Signals } from './screens/Signals';
import { Positions } from './screens/Positions';
import { Trades } from './screens/Trades';
import { TradeDetailView } from './screens/TradeDetail';
import { PerformanceScreen } from './screens/Performance';
import { Risk } from './screens/Risk';
import { SystemScreen } from './screens/System';
import { About } from './screens/About';
import { Shadow } from './screens/Shadow';
import { Research } from './screens/Research';
import { ExitEvidence } from './screens/ExitEvidence';

// Shadow is last so the existing Ctrl+1..8 shortcuts keep their screens.
const SCREENS = ['Dashboard', 'Signals', 'Positions', 'Trades', 'Performance', 'Risk', 'System', 'About', 'Shadow', 'Research'] as const;
type Screen = (typeof SCREENS)[number];

export function ModeBar({ info, mode, onSelect }: { info: AppInfo | null; mode: Mode; onSelect: (m: Mode) => void }) {
  return (
    <div className="modes" role="radiogroup" aria-label="Execution mode">
      {(info?.modes ?? []).map((m) => (
        <button key={m.mode} role="radio" aria-checked={m.mode === mode} disabled={!m.enabled}
          className={`mode ${m.mode === mode ? 'active' : ''} mode-${m.mode.toLowerCase()}`}
          title={m.reason ?? `Switch to ${m.mode}`} onClick={() => onSelect(m.mode)}>
          {m.mode}{m.mode === 'LIVE' && <span className="mode-off">DISABLED</span>}
        </button>
      ))}
    </div>
  );
}

type Pending = null | 'kill' | 'clear';

export function Controls({ health, onDone }: { health: Health | null; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const loopState = health?.forward_loop?.state ?? 'STOPPED';
  const offline = health?.market?.online === false;
  const serviceUp = !!health?.status;
  const halted = health?.status?.halted ?? null;
  const paused = health?.status?.entries_paused ?? false;
  const loopActive = loopState === 'RUNNING' || loopState === 'STOPPING';

  async function run(name: string, fn: () => Promise<unknown>, ok: (r: unknown) => string) {
    setBusy(name);
    setMessage(null);
    try {
      const r = await fn();
      setMessage({ kind: 'ok', text: ok(r) });
    } catch (e) {
      setMessage({ kind: 'err', text: `${name}: ${errorText(e)}` });
    } finally {
      setBusy(null);
      onDone();
    }
  }

  return (
    <div className="controls">
      <button className="btn btn-primary" disabled={!serviceUp || loopActive || !!busy} onClick={() => run('START PAPER', api.startPaper, () => 'Forward paper loop started')}>START PAPER</button>
      <button className="btn" disabled={loopState !== 'RUNNING' || !!busy} onClick={() => run('STOP PAPER', api.stopPaper, () => 'Stopping after the current cycle; open positions stay open and tracked')}>
        {loopState === 'STOPPING' ? 'STOPPING…' : 'STOP PAPER'}
      </button>
      <button className="btn" disabled={!serviceUp || !!busy} onClick={() => run('RECONCILE NOW', api.reconcile, (r) => ((r as { reconciled?: boolean }).reconciled ? 'Reconciled: ledger and canonical portfolio agree' : 'RECONCILIATION FAILED: trading halted'))}>RECONCILE NOW</button>
      <button className="btn btn-warn" disabled={!serviceUp || paused || !!busy} onClick={() => run('PAUSE NEW ENTRIES', api.pause, () => 'New entries paused; exits continue')}>PAUSE NEW ENTRIES</button>
      <button className="btn" disabled={!serviceUp || (!paused && !halted) || offline || !!busy}
        title={offline ? 'Fresh market data is required before entries can resume' : undefined}
        onClick={() => (halted ? setPending('clear') : run('RESUME', api.resume, () => 'New entries resumed'))}>RESUME</button>
      <span className="controls-spacer" />
      {message && <span className={`control-msg ${message.kind}`} role="status">{message.text}</span>}
      <button className="btn btn-kill" disabled={!serviceUp || !!halted || !!busy} onClick={() => setPending('kill')}>
        {halted ? 'KILL SWITCH ENGAGED' : 'KILL SWITCH'}
      </button>
      {pending === 'kill' && (
        <ConfirmDialog title="Engage kill switch?" word="KILL" confirmLabel="ENGAGE KILL SWITCH"
          body={<><p>Every new intent is blocked immediately and the halt survives restarts.</p><p>Reduce-only exits (stops, targets) keep processing so open positions are not trapped. Clearing it later requires a clean reconciliation.</p></>}
          onCancel={() => setPending(null)}
          onConfirm={() => { setPending(null); void run('KILL SWITCH', () => api.killSwitch('KILL'), () => 'Kill switch engaged'); }} />
      )}
      {pending === 'clear' && (
        <ConfirmDialog title="Clear the halt and resume?" word="CLEAR_HALT" confirmLabel="Reconcile and clear"
          body={<><p>Trading is halted: <b>{halted}</b>.</p><p>A fresh reconciliation runs first; the halt is cleared only if the paper ledger and the canonical portfolio agree. New entries are also un-paused.</p></>}
          onCancel={() => setPending(null)}
          onConfirm={() => { setPending(null); void run('RESUME', async () => { await api.clearHalt('CLEAR_HALT'); return api.resume(); }, () => 'Halt cleared after clean reconciliation; entries resumed'); }} />
      )}
    </div>
  );
}

const PAUSE_REASONS: Record<string, string> = {
  MARKET_DATA_OFFLINE: 'market data is offline',
  SUPERVISOR_RECOVERY: 'the execution-service is recovering from a crash',
  FORWARD_LOOP_CRASHED: 'the forward loop crashed',
  RESTORED_FROM_BACKUP: 'a backup was just restored; review, then RESUME',
  DESKTOP_PAUSE: 'paused from the desktop',
};

export function Warnings({ health, healthError }: { health: Health | null; healthError: string | null }) {
  const items: { kind: 'error' | 'warn'; text: string }[] = [];
  if (healthError) items.push({ kind: 'error', text: `Controller unreachable: ${healthError}` });
  if (health?.fatal) items.push({ kind: 'error', text: `Market Edge cannot start its services: ${health.fatal}` });
  else if (health?.startup_error) items.push({ kind: 'error', text: `execution-service failed to start: ${health.startup_error}` });
  else if (health?.supervisor?.exec_gave_up) items.push({ kind: 'error', text: `execution-service is DOWN: ${health.supervisor.exec_gave_up}` });
  else if (health?.supervisor?.recovering) items.push({ kind: 'error', text: 'execution-service crashed: restarting it, then reconciling before new entries are allowed.' });
  else if (health && !health.status) items.push({ kind: health.execution_service?.state === 'STARTING' ? 'warn' : 'error', text: health.execution_service?.state === 'STARTING' ? 'Starting execution-service…' : 'execution-service is not reachable. Positions and PnL cannot be shown.' });
  if (health?.market?.online === false) items.push({ kind: 'error', text: `MARKET DATA OFFLINE: no new trades. Existing positions stay visible; entries resume only after fresh prices arrive. (${health.market.detail})` });
  if (health?.supervisor?.loop_gave_up) items.push({ kind: 'error', text: health.supervisor.loop_gave_up });
  if (health?.status?.halted) items.push({ kind: 'error', text: `KILL SWITCH / HALT ACTIVE: ${health.status.halted}. No new trades; exits still process.` });
  if (health?.status?.entries_paused && health.status.entries_paused_reason !== 'MARKET_DATA_OFFLINE') {
    const why = PAUSE_REASONS[health.status.entries_paused_reason ?? ''] ?? health.status.entries_paused_reason;
    items.push({ kind: 'warn', text: `New entries are PAUSED${why ? ` (${why})` : ''}. Open positions are still managed.` });
  }
  const pm = health?.status?.position_monitor;
  if (pm && pm.stale_positions > 0) {
    items.push({ kind: 'error', text: `OPEN-POSITION MONITOR: ${pm.stale_positions} of ${pm.open_positions} open position(s) have no fresh market price (STALE / OFFLINE${pm.error ? `: ${pm.error}` : ''}). Stops and targets are not evaluated on old prices; positions are preserved.` });
  }
  const down = health?.components.filter((c) => c.status === 'DOWN' && c.name !== 'execution-service' && c.name !== 'Reconciliation') ?? [];
  for (const c of down) items.push({ kind: 'warn', text: `${c.name}: ${c.detail}` });
  if (!items.length) return null;
  return <div className="warnings">{items.map((w, i) => <div key={i} className={`banner banner-${w.kind}`} role="alert">{w.text}</div>)}</div>;
}

const PHASES: Record<string, string> = {
  INITIALIZING: 'Preparing your data folder…',
  STARTING_SERVICE: 'Starting the execution-service (Nautilus, SQLite)…',
  STARTING_LOOP: 'Starting the forward paper loop…',
};

/** Shown until the controller reports the local services are up (or failed). */
export function StartupScreen({ health, info, error }: { health: Health | null; info: AppInfo | null; error: string | null }) {
  const phase = health?.startup.phase ?? 'INITIALIZING';
  const failed = phase === 'ERROR' || !!health?.fatal;
  return (
    <div className="startup" role="status" aria-live="polite">
      <div className="startup-card">
        <div className="brand startup-brand">MARKET EDGE</div>
        <div className="muted small">Paper trading · LIVE disabled · v{info?.version ?? '…'}</div>
        {failed ? (
          <div className="banner banner-error">{health?.fatal ?? health?.startup.message}</div>
        ) : (
          <div className="startup-step"><span className="spinner" aria-hidden /> {PHASES[phase] ?? health?.startup.message ?? 'Starting…'}</div>
        )}
        {health?.startup.first_run?.first_run && !failed && <div className="muted small">First launch: creating your local database and settings.</div>}
        {error && <div className="banner banner-error">Controller unreachable: {error}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreenRaw] = useState<Screen>('Dashboard');
  const [detail, setDetail] = useState<string | null>(null);
  const setScreen = (s: Screen) => { setDetail(null); setScreenRaw(s); };
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [mode, setMode] = useState<Mode>('PAPER');
  const [modeError, setModeError] = useState<string | null>(null);
  const health = usePoll(api.health, 3000);

  const phase = health.data?.startup.phase;
  // re-read once services are up so About shows the backend/schema versions
  useEffect(() => { api.appInfo().then((i) => { setInfo(i); setMode(i.mode); }).catch(() => undefined); }, [phase]);
  // Ctrl/Cmd + 1..8 jumps between screens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if ((e.ctrlKey || e.metaKey) && n >= 1 && n <= SCREENS.length) { e.preventDefault(); setScreen(SCREENS[n - 1]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectMode = async (m: Mode) => {
    try { setMode(await api.setMode(m)); setModeError(null); } catch (e) { setModeError(errorText(e)); }
  };
  const h = health.data;
  const starting = !h || (!h.fatal && (h.startup.phase === 'INITIALIZING' || h.startup.phase === 'STARTING_SERVICE'));
  if (starting || h?.fatal) return <StartupScreen health={h} info={info} error={health.error} />;
  const worst = h?.components.some((c) => c.status === 'DOWN') ? 'DOWN' : h?.components.some((c) => c.status === 'WARN' || c.status === 'STARTING') ? 'WARN' : h ? 'OK' : 'STARTING';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">MARKET EDGE</div>
        <div className={`mode-badge mode-badge-${mode.toLowerCase()}`} aria-label={`Current mode ${mode}`}>{mode}</div>
        <ModeBar info={info} mode={mode} onSelect={selectMode} />
        {modeError && <span className="control-msg err">{modeError}</span>}
        <span className="topbar-spacer" />
        <span className="pill"><Dot status={worst} /> System {worst}</span>
        {h?.market?.online === false && <span className="pill pill-danger"><Dot status="DOWN" /> MARKET DATA OFFLINE</span>}
        <span className="pill"><Dot status={h?.forward_loop?.state === 'RUNNING' ? 'OK' : h?.forward_loop?.state === 'STOPPING' ? 'WARN' : h?.forward_loop?.state === 'FAILED' ? 'DOWN' : 'DISABLED'} /> Loop {h?.forward_loop?.state ?? '…'}</span>
        <span className={`pill ${h?.status?.halted ? 'pill-danger' : ''}`}><Dot status={h?.status?.halted ? 'DOWN' : 'OK'} /> {h?.status?.halted ? 'HALTED' : 'Kill switch off'}</span>
      </header>
      <Controls health={h} onDone={health.refresh} />
      <Warnings health={h} healthError={health.error} />
      <div className="body">
        <nav className="nav">
          {SCREENS.map((s, i) => <button key={s} className={`nav-item ${s === screen ? 'active' : ''}`} title={`Ctrl+${i + 1}`} onClick={() => setScreen(s)}>{s}</button>)}
          <div className="nav-foot">Paper only · LIVE disabled<br />v{info?.version ?? '…'}</div>
        </nav>
        <main className="main">
          {detail && <TradeDetailView tradeId={detail} onBack={() => setDetail(null)} />}
          {!detail && screen === 'Dashboard' && <Dashboard health={h} onOpen={setDetail} />}
          {!detail && screen === 'Signals' && <Signals />}
          {!detail && screen === 'Positions' && <Positions onOpen={setDetail} />}
          {!detail && screen === 'Trades' && <Trades onOpen={setDetail} />}
          {!detail && screen === 'Performance' && <PerformanceScreen />}
          {!detail && screen === 'Risk' && <Risk />}
          {!detail && screen === 'Shadow' && <Shadow />}
          {!detail && screen === 'Research' && <><Research /><ExitEvidence /></>}
          {!detail && screen === 'System' && <SystemScreen health={h} info={info} />}
          {!detail && screen === 'About' && <About info={info} />}
        </main>
      </div>
    </div>
  );
}
