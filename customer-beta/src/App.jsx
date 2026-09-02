import { useEffect, useMemo, useRef, useState } from 'react';
import { API_URL, MarketEdgeApiError, closeCloudTrade, getAccount, getCloudTrades, scanMarkets, takeCloudTrade } from './lib/marketEdgeApi.js';
import { authConfigured, resetPassword, restoreSession, signIn, signOut, signUp, subscribeAuth } from './lib/auth.js';
import { hasJournalAcceptance, loadJournal, removeLocalTrade, saveAcceptedTrade } from './lib/journal.js';
import { getTradePresentation, isScanFresh, STATUS_LABELS } from './lib/presentation.js';
import { createScanCoordinator } from './lib/scanCoordinator.js';
import MarketChart from './components/MarketChart.jsx';

const NAV = [
  ['trade', 'Trade'], ['trades', 'My Trades'], ['performance', 'Performance'], ['settings', 'Settings']
];
const DEFAULT_SETTINGS = { balance: '7', riskPct: '1', maxLeverage: '10', maxExposurePct: '100' };

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('market-edge-customer-beta-settings-v1') || '{}') }; }
  catch { return DEFAULT_SETTINGS; }
}
function saveSettings(settings) { localStorage.setItem('market-edge-customer-beta-settings-v1', JSON.stringify(settings)); }
function tradeNumber(value, options = {}) {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: value >= 1000 ? 2 : value >= 1 ? 4 : 6, ...options }).format(value) : '—';
}
function money(value) { return typeof value === 'number' && Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${tradeNumber(Math.abs(value))}` : '—'; }
function percent(value) { return typeof value === 'number' && Number.isFinite(value) ? `${tradeNumber(value * 100, { maximumFractionDigits: 1 })}%` : '—'; }
function time(value) { return typeof value === 'number' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }

function Brand() {
  return <div className="brand"><div className="brand-mark" aria-hidden="true"><i/><i/><i/></div><span>Market Edge<small>Customer beta</small></span></div>;
}
function Badge({ status }) { return <span className={`status-badge ${status?.toLowerCase() || 'neutral'}`}>{STATUS_LABELS[status] || 'AWAITING SCAN'}</span>; }
function Field({ label, value, className = '' }) { return <div className={`trade-field ${className}`}><span>{label}</span><strong>{value}</strong></div>; }

function ScanButton({ scanning, onClick }) {
  return <button className="scan-button" type="button" disabled={scanning} onClick={onClick}>
    {scanning ? <><span className="scan-spinner"/>Analysing live markets</> : <>Scan markets <span>→</span></>}
  </button>;
}

function LevelMap({ trade }) {
  const levels = [
    ['TP2', trade?.tp2, 'tp2'], ['TP1', trade?.tp1, 'tp1'], ['Entry', trade?.entry, 'entry'], ['Stop', trade?.stop, 'stop']
  ].filter(([, value]) => typeof value === 'number');
  if (!levels.length) return <div className="level-map empty-map"><span>Trade levels appear only after a legitimate Worker result.</span></div>;
  const values = levels.map(([, value]) => value);
  if (typeof trade.currentPrice === 'number') values.push(trade.currentPrice);
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, Math.abs(max) * .002, .000001);
  return <div className="level-map" aria-label="Server-returned price levels, not a price chart">
    <div className="level-map-note">Live level map <span>·</span> Server-returned levels</div>
    {levels.map(([label, value, tone]) => <div key={label} className={`map-line ${tone}`} style={{ bottom: `${8 + ((value - min) / span) * 74}%` }}><b>{label}</b><span>{money(value)}</span><i/></div>)}
    {typeof trade.currentPrice === 'number' && <div className="map-price" style={{ bottom: `${8 + ((trade.currentPrice - min) / span) * 74}%` }}><span>Current</span><b>{money(trade.currentPrice)}</b></div>}
  </div>;
}

function TradeCard({ scan, onTake, taken, onSettings }) {
  const presentation = getTradePresentation(scan, { alreadyAccepted: taken });
  const { trade, opportunity, focus, showTakeTrade, takeTradeEnabled, showSeparateOpportunity } = presentation;
  if (!scan) return <section className="trade-card neutral-card"><div className="card-kicker">Best trade now</div><h1>Run a real market scan</h1><p>Market Edge will only show levels, scores and sizing returned by the Worker. It never creates browser-side trading data.</p><div className="empty-pills"><span>Live Worker data</span><span>Manual execution</span><span>No exchange connection</span></div></section>;
  if (scan.status === 'DATA_UNAVAILABLE') return <section className="trade-card neutral-card"><div className="card-row"><div><div className="card-kicker">Market Edge result</div><h1>Data unavailable</h1></div><Badge status={scan.status}/></div><p>Live data did not pass the Worker checks, so no recommendation was generated. Try another scan later.</p><Diagnostic scan={scan}/></section>;
  if (!focus) return <section className="trade-card neutral-card"><div className="card-row"><div><div className="card-kicker">Market Edge result</div><h1>No valid setup</h1></div><Badge status={scan.status}/></div><p>The Worker completed the scan but no trade met the current quality and risk requirements.</p><ScanFootnote scan={scan}/></section>;
  const hasPlan = [focus.entry, focus.stop, focus.tp1, focus.tp2, focus.rr1].every(value => typeof value === 'number');
  const noSetup = focus.entryStatus === 'NO_VALID_SETUP';
  const rankedCandidate = hasPlan && Boolean(focus.direction && focus.strategy);
  return <section className={`trade-card ${trade ? `direction-${trade.direction}` : 'opportunity-card'}`}>
    <div className="card-row">
      <div><div className="card-kicker">{trade || rankedCandidate ? 'Best trade now' : noSetup ? 'Best available market' : 'Best opportunity'}</div><h1>{focus.asset || 'Market'} {focus.direction && <span>{focus.direction.toUpperCase()}</span>}</h1><p className="strategy">{focus.strategy || 'No qualifying strategy setup'} {focus.instrument ? `· ${focus.instrument} on Invo` : ''}</p></div>
      <Badge status={scan.status}/>
    </div>
    {trade && scan.status === 'TRADE_READY' ? <p className="card-intro">This is the highest-ranked trade-ready setup from the current Worker response. Market Edge does not place the order.</p> : rankedCandidate ? <p className="card-intro">This is the strongest legitimate current setup found across the Worker scan. Entry quality and the strict legacy verdict are shown separately; this is not automatically a TRADE READY recommendation.</p> : noSetup ? <p className="card-intro">This market was the highest-ranked evaluated result, but no qualifying entry setup exists right now. No trade plan was generated.</p> : <p className="card-intro">This is the best available setup, but it is not currently enterable. Do not chase it.</p>}
    {typeof focus.currentPrice === 'number' && <div className="scan-price">Scan price <b>{money(focus.currentPrice)}</b> · frozen at scan time</div>}
    {hasPlan && <><div className="price-grid">
      <Field label="Entry" value={money(focus.entry)} />
      <Field label="Stop" value={money(focus.stop)} className="stop" />
      <Field label="TP1" value={money(focus.tp1)} className="tp1" />
      <Field label="TP2" value={money(focus.tp2)} className="tp2" />
      <Field label="R : R" value={focus.rr1 ? `${tradeNumber(focus.rr1)}R` : '—'} />
    </div>{focus.entryZone && <div className="entry-zone"><span>Worker entry zone</span><b>{money(focus.entryZone.low)} — {money(focus.entryZone.high)}</b></div>}{focus.entryQuality && <div className="entry-zone"><span>Entry quality</span><b>{focus.entryQuality}</b></div>}</>}
    <div className="trade-actions">
      {showTakeTrade && <button className="take-button" type="button" onClick={onTake} disabled={!takeTradeEnabled}>{taken ? 'Trade taken ✓' : takeTradeEnabled ? 'Take trade' : 'Scan expired — rescan'}</button>}
      <button className="secondary-button" type="button" onClick={onSettings}>Risk settings</button>
      <small>{trade ? 'Records your manual confirmation only. No Invo order is sent.' : 'Await a TRADE READY result before accepting a trade.'}</small>
    </div>
    <ScanFootnote scan={scan}/>
    {showSeparateOpportunity && <div className="opportunity-note"><span>Highest-quality opportunity</span><b>{opportunity.asset} {opportunity.direction?.toUpperCase()} · {STATUS_LABELS[opportunity.entryStatus] || 'WAIT'}</b><small>Best Trade Now remains the actionable Worker result above.</small></div>}
  </section>;
}

function ScanFootnote({ scan }) {
  const coverage = scan.dataQuality?.coverage;
  const evaluated = coverage?.evaluated ?? scan.universe.evaluated ?? scan.universe.scanned;
  const requested = coverage?.requested ?? scan.universe.scanned;
  return <div className="scan-footnote"><span>Scan {scan.scanId}</span><span>{time(scan.scannedAt)}</span><span>{evaluated} / {requested} markets evaluated</span>{scan.dataQuality.status === 'PARTIAL' && <span>Partial feed coverage</span>}</div>;
}
function Diagnostic({ scan }) {
  const first = scan?.dataQuality?.failures?.[0];
  return first ? <div className="diagnostic"><b>Worker note</b><span>{first}</span></div> : null;
}

function SupportingDetails({ scan, selected }) {
  const trade = selected || scan?.bestTradeNow || scan?.bestOpportunity;
  if (!scan || !trade) return <section className="details-card"><div className="section-heading"><span>Setup intelligence</span><small>Results appear after a Worker scan</small></div><div className="details-empty">The browser does not calculate a score, entry, or target.</div></section>;
  return <section className="details-card">
    <div className="section-heading"><span>Setup intelligence{trade.asset ? ` · ${trade.asset}` : ''}</span><small>{trade.dataQuality || 'Worker data'}</small></div>
    <div className="detail-columns">
      <div className="score-grid"><Field label="Setup quality" value={trade.setupQuality == null ? 'Not applicable' : `${tradeNumber(trade.setupQuality)} / 100`} /><Field label="Entry quality" value={trade.entryQuality || trade.entryStatus || 'Not applicable'} /><Field label="Quant" value={trade.quantScore == null ? 'Not applicable' : tradeNumber(trade.quantScore)} /><Field label="ML" value={trade.mlScore == null ? trade.ml?.status === 'NOT_APPLICABLE' ? 'Not applicable' : 'Not available' : tradeNumber(trade.mlScore)} /><Field label="Combined" value={trade.combinedScore == null ? 'Not applicable' : tradeNumber(trade.combinedScore)} /></div>
      <div className="reasoning"><span>Why #1</span><p>{trade.reasoning || 'No additional reasoning was supplied by the Worker.'}</p>{trade.weakerEvidence?.length > 0 && <div className="caution"><b>Weaker evidence</b>{trade.weakerEvidence.join(' · ')}</div>}{trade.structuralInvalidation && <div className="caution"><b>Invalidation</b>{trade.structuralInvalidation}</div>}{trade.caution && <div className="caution"><b>Caution</b>{trade.caution}</div>}{trade.ml?.reason && <small>{trade.ml.reason}</small>}{trade.ml?.modelId && <small>Model {trade.ml.modelId} · {trade.ml.status || 'status unavailable'} · {percent(trade.ml.weight)} influence</small>}</div>
    </div>
  </section>;
}

function RiskCard({ scan, selected }) {
  const trade = selected || scan?.bestTradeNow || scan?.bestOpportunity;
  const position = trade?.position;
  return <section className="risk-card"><div className="section-heading"><span>Server-calculated execution{trade?.asset ? ` · ${trade.asset}` : ''}</span><small>Manual execution only</small></div>{position ? <div className="risk-grid"><Field label="Position size" value={money(position.notional)} /><Field label="Margin" value={money(position.margin)} /><Field label="Leverage" value={position.leverage == null ? '—' : `${tradeNumber(position.leverage)}×`} /><Field label="Risk" value={money(position.riskAmount)} /><Field label="Allocation" value={position.allocation == null ? '—' : percent(position.allocation)} /><Field label="Est. costs" value={money(position.estimatedCosts)} /></div> : <div className="details-empty">Position sizing will appear only when the Worker returns complete trade geometry.</div>}</section>;
}

function ScanCoverage({ scan }) {
  const coverage = scan?.dataQuality?.coverage;
  if (!scan || !coverage) return null;
  return <section className="coverage-card"><div className="section-heading"><span>Scan coverage</span><small>{scan.dataQuality.status === 'PARTIAL' ? 'Partial feed coverage' : 'Complete feed coverage'}</small></div><div className="coverage-stats"><span><b>{coverage.evaluated ?? '—'} / {coverage.requested ?? scan.universe.scanned ?? '—'}</b> markets evaluated</span><span><b>{coverage.multiSourceEvaluated ?? '—'}</b> multi-source</span><span><b>{coverage.skipped ?? '—'}</b> skipped</span><span><b>{scan.scanSummary?.rankedOpportunities ?? '—'}</b> ranked results</span></div>{coverage.skipped > 0 && <details><summary>Why coverage was partial</summary><p>Some markets were skipped because their live data could not pass the existing feed-completeness checks in this scan. No data-quality standards were lowered.</p>{scan.dataQuality.failures.length > 0 && <ul>{scan.dataQuality.failures.map((failure, index) => <li key={`${index}-${failure}`}>{failure}</li>)}</ul>}</details>}</section>;
}

function OpportunityList({ scan, selected, onSelect }) {
  const items = scan?.rankedOpportunities || [];
  if (!scan) return null;
  return <section className="opportunity-list"><div className="section-heading"><div><span>Market opportunities</span><small>Exact Worker order · inspection only</small></div><small>{items.length} evaluated result{items.length === 1 ? '' : 's'}</small></div>{items.length ? <div className="opportunity-grid">{items.map(item => <button type="button" key={item.scanSnapshotId || `${item.asset}-${item.rank}`} className={`opportunity-item ${selected?.scanSnapshotId === item.scanSnapshotId ? 'selected' : ''}`} onClick={() => onSelect(item)} aria-pressed={selected?.scanSnapshotId === item.scanSnapshotId}><span className="opportunity-rank">#{item.rank ?? '—'}</span><span className="opportunity-main"><b>{item.asset}</b><small>{item.direction ? item.direction.toUpperCase() : 'NO DIRECTION'} · {item.strategy || 'No qualifying strategy'}</small></span><span className={`opportunity-status ${item.entryStatus?.toLowerCase()}`}>{STATUS_LABELS[item.entryStatus] || item.entryStatus || 'UNAVAILABLE'}</span><span className="opportunity-metrics"><small>Price</small><b>{money(item.currentPrice)}</b></span><span className="opportunity-metrics"><small>Quality</small><b>{item.setupQuality == null ? '—' : tradeNumber(item.setupQuality)}</b></span><span className="opportunity-metrics"><small>Combined</small><b>{item.combinedScore == null ? '—' : tradeNumber(item.combinedScore)}</b></span></button>)}</div> : <div className="details-empty">No market completed the existing data-quality checks in this scan.</div>}</section>;
}

function Allowance({ account }) {
  if (!account) return <span className="allowance">Securing guest session…</span>;
  if (account.unlimited) return <span className="allowance">Admin · Unlimited scans</span>;
  return <span className="allowance">{account.principalType === 'GUEST' ? 'Guest' : 'Free'} · {account.remainingToday} of {account.dailyLimit} scans remaining today</span>;
}
function TradeView({ scan, scanning, error, onScan, onTake, taken, onSettings, selected, onSelect, account }) {
  const focus = scan?.bestTradeNow || scan?.bestOpportunity;
  return <main className="trade-view"><section className="scanner-toolbar"><div><span className="eyebrow">Market Edge / Scanner</span><h2>Live market scanner</h2><p>Server-ranked opportunities across the verified Invo universe.</p></div><div className="hero-actions"><ScanButton scanning={scanning} onClick={onScan}/><Allowance account={account}/></div></section>
    {error && <div className="error-state" role="alert"><b>Data unavailable</b><span>{error.message}</span>{error.httpStatus && <small>HTTP {error.httpStatus} · {error.code}</small>}</div>}
    {scanning && <section className="scan-progress" role="status" aria-live="polite"><div className="scan-progress-top"><span><i className="scan-spinner"/> Validating current market data</span><small>This can take up to 60 seconds.</small></div><div className="progress-bar"><i/></div><p>Market Edge is requesting a single live server-side scan. Assets are not named until the Worker supplies a result.</p></section>}
    <div className="trade-layout"><div className="primary-column"><TradeCard scan={scan} onTake={onTake} taken={taken} onSettings={onSettings}/><SupportingDetails scan={scan} selected={selected}/></div><aside className="side-column"><MarketChart trade={selected || focus}/><RiskCard scan={scan} selected={selected}/></aside></div>
    <OpportunityList scan={scan} selected={selected} onSelect={onSelect}/><ScanCoverage scan={scan}/>
  </main>;
}

function MyTrades({ records, onDelete, onClose, cloud }) {
  const [filter, setFilter] = useState('OPEN');
  const shown = records.filter(record => filter === 'ALL' || record.status === filter);
  return <main className="content-page"><section className="page-head"><div><span className="eyebrow">{cloud ? 'Private cloud journal' : 'Stored on this device'}</span><h2>My trades</h2><p>{cloud ? 'Your Market Edge trade snapshots are private and sync when you sign in on another device.' : 'Guest trades stay on this device. Create an account to start a private cloud journal.'}</p></div><span className="record-count">{records.length} recorded</span></section><div className="journal-tabs">{['OPEN', 'CLOSED', 'ALL'].map(item => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'ALL' ? 'All' : item[0] + item.slice(1).toLowerCase()}</button>)}</div>{shown.length ? <div className="journal-list">{shown.map(record => <article className="journal-row" key={record.id}><div className="journal-title"><span className={`direction-dot ${record.snapshot.direction}`}/><div><strong>{record.snapshot.asset} {record.snapshot.direction?.toUpperCase()}</strong><small>{record.snapshot.strategy || 'Market Edge recommendation'} · {time(record.acceptedAt)}</small></div></div><div><span>Entry</span><b>{money(record.snapshot.entry)}</b></div><div><span>Stop / TP1</span><b>{money(record.snapshot.stop)} / {money(record.snapshot.tp1)}</b></div><div><span>R : R</span><b>{record.snapshot.rr1 ? `${tradeNumber(record.snapshot.rr1)}R` : '—'}</b></div><div className="journal-actions"><span className={record.status === 'CLOSED' ? 'closed-status' : 'open-status'}>{record.status}</span>{cloud && record.status === 'OPEN' && <button type="button" onClick={() => onClose(record)}>Close manually</button>}{!cloud && <button type="button" onClick={() => onDelete(record.id)}>Remove local copy</button>}</div></article>)}</div> : <section className="empty-page"><h3>{filter === 'CLOSED' ? 'No closed observations yet' : 'No accepted trades yet'}</h3><p>When a TRADE READY result appears, Take Trade freezes its exact Worker response. No live P/L is invented.</p></section>}</main>;
}

function Performance({ records }) {
  return <main className="content-page"><section className="page-head"><div><span className="eyebrow">Forward observations</span><h2>Performance</h2><p>Verified results only. Market Edge does not invent P/L or trade outcomes from open recommendations.</p></div></section><section className="performance-empty"><div className="performance-ring"><span>{records.length}</span><small>open</small></div><div><h3>Verified performance will appear as forward observations resolve.</h3><p>Your accepted recommendations are currently stored locally as open observations. Authentication and server-side outcome resolution are the next data phase.</p><div className="performance-notes"><span>No fabricated win rate</span><span>No inferred P/L</span><span>No historical claims</span></div></div></section></main>;
}

function AccountPanel({ account, user, onAuth, onLogout }) {
  return <section className="account-panel"><div><span className="eyebrow">Account</span><h3>{user ? user.email : 'Guest session'}</h3><p>{user ? 'Your Free account has a private cloud journal.' : 'Guest scans are protected by a server-issued identity. Clearing browser data can reset this beta guest identity.'}</p></div><div className="account-actions">{account && <Allowance account={account}/>} {user ? <button className="secondary-button" type="button" onClick={onLogout}>Log out</button> : <button className="take-button" type="button" onClick={onAuth}>Log in or create account</button>}</div></section>;
}
function Settings({ settings, setSettings, account, user, onAuth, onLogout }) {
  const change = event => { const next = { ...settings, [event.target.name]: event.target.value }; setSettings(next); saveSettings(next); };
  return <main className="content-page"><section className="page-head"><div><span className="eyebrow">Account & risk inputs</span><h2>Settings</h2><p>These values are sent to the Worker for its existing server-side risk calculation. They do not alter Market Edge’s strategy or ranking.</p></div></section><AccountPanel account={account} user={user} onAuth={onAuth} onLogout={onLogout}/><section className="settings-card"><label>Account balance <div><span>USDC</span><input name="balance" inputMode="decimal" value={settings.balance} onChange={change}/></div></label><label>Risk per trade <div><span>%</span><input name="riskPct" inputMode="decimal" value={settings.riskPct} onChange={change}/></div></label><label>Maximum leverage <div><span>×</span><input name="maxLeverage" inputMode="decimal" value={settings.maxLeverage} onChange={change}/></div></label><label>Maximum exposure <div><span>%</span><input name="maxExposurePct" inputMode="decimal" value={settings.maxExposurePct} onChange={change}/></div></label></section><section className="source-card"><b>Data source</b><span>Market Edge Worker</span><code>{API_URL}</code><small>Server-issued entitlement · no exchange credentials</small></section></main>;
}

function AuthDialog({ mode, onClose, onComplete }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const submit = async event => { event.preventDefault(); setBusy(true); setMessage(''); try { const result = mode === 'signup' ? await signUp(email, password) : await signIn(email, password); setMessage(mode === 'signup' && !result.session ? 'Check your email to confirm your account, then log in.' : 'Signed in.'); onComplete?.(result.session?.user || null); } catch (error) { setMessage(error.message || 'Unable to continue.'); } finally { setBusy(false); } };
  const reset = async () => { try { await resetPassword(email); setMessage('Password-reset email sent if that account exists.'); } catch (error) { setMessage(error.message || 'Unable to send reset email.'); } };
  return <div className="auth-backdrop" role="presentation"><section className="auth-dialog" role="dialog" aria-modal="true" aria-label="Account access"><button className="auth-close" type="button" onClick={onClose}>×</button><span className="eyebrow">Market Edge account</span><h2>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2><p>{mode === 'signup' ? 'Five scans per Sydney day and a private cloud-synced journal.' : 'Log in to access your private trades.'}</p><form onSubmit={submit}><label>Email<input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required/></label><label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength="8" value={password} onChange={event => setPassword(event.target.value)} required/></label><button className="take-button" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}</button></form>{message && <p className="auth-message">{message}</p>}<div className="auth-switch">{mode === 'signup' ? <button type="button" onClick={() => onComplete?.('login')}>Already have an account? Log in</button> : <><button type="button" onClick={() => onComplete?.('signup')}>New here? Create an account</button><button type="button" onClick={reset}>Forgot password?</button></>}</div></section></div>;
}

export default function App() {
  const [page, setPage] = useState('trade');
  const [settings, setSettings] = useState(loadSettings);
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [records, setRecords] = useState(loadJournal);
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [account, setAccount] = useState(null);
  const [authMode, setAuthMode] = useState(null);
  const coordinatorRef = useRef(null);
  if (!coordinatorRef.current) coordinatorRef.current = createScanCoordinator();
  const workerSettings = useMemo(() => ({ balance: Number(settings.balance), riskPct: Number(settings.riskPct) / 100, maxLeverage: Number(settings.maxLeverage), maxExposurePct: Number(settings.maxExposurePct) / 100 }), [settings]);
  useEffect(() => () => coordinatorRef.current?.abort(), []);
  useEffect(() => {
    let active = true;
    const hydrate = async () => { try { const session = await restoreSession(); if (!active) return; setUser(session.user); setAccessToken(session.session?.access_token || null); const current = await getAccount({ accessToken: session.session?.access_token || null }); if (active) setAccount(current); } catch { if (active) setAccount(null); } };
    hydrate();
    return subscribeAuth(async (nextUser, token) => { if (!active) return; setUser(nextUser); setAccessToken(token || null); try { setAccount(await getAccount({ accessToken: token || null })); } catch { setAccount(null); } });
  }, []);
  useEffect(() => { if (!user || !accessToken) { setRecords(loadJournal()); return; } getCloudTrades({ accessToken }).then(result => setRecords((result.trades || []).map(row => ({ id: row.id, recommendationId: row.recommendation_id, status: row.status, source: row.source, storage: 'CLOUD', acceptedAt: Date.parse(row.created_at), snapshot: row.snapshot?.trade || {}, raw: row })))).catch(() => {}); }, [user, accessToken]);
  const startScan = async () => {
    const request = coordinatorRef.current.begin();
    // A new scan invalidates the old snapshot immediately. The UI must never
    // imply that yesterday's trade remains current while new data is loading.
    setScanning(true); setScan(null); setSelected(null); setError(null);
    try {
      const next = await scanMarkets({ settings: workerSettings, accessToken, signal: request.signal });
      if (coordinatorRef.current.isCurrent(request)) { setScan(next); setSelected(next.bestTradeNow || next.bestOpportunity || next.rankedOpportunities[0] || null); if (next.account?.entitlement) setAccount({ ...next.account.entitlement, principalType: next.account.principalType }); }
    } catch (cause) {
      if (coordinatorRef.current.isCurrent(request)) {
        setScan(null); setSelected(null);
        setError(cause instanceof MarketEdgeApiError ? cause : new MarketEdgeApiError('Data unavailable'));
      }
    } finally {
      if (coordinatorRef.current.isCurrent(request)) {
        coordinatorRef.current.complete(request);
        setScanning(false);
      }
    }
  };
  const takeTrade = async () => {
    if (!scan || !isScanFresh(scan) || hasJournalAcceptance(records, scan)) return;
    if (user && accessToken && scan.account?.recommendationId) {
      try { const result = await takeCloudTrade(scan.account.recommendationId, { accessToken }); const row = result.trade; setRecords(current => [{ id: row.id, recommendationId: row.recommendation_id, status: row.status, source: row.source, storage: 'CLOUD', acceptedAt: Date.parse(row.created_at), snapshot: row.snapshot?.trade || {}, raw: row }, ...current.filter(item => item.id !== row.id)]); return; } catch (cause) { setError(cause); return; }
    }
    const saved = saveAcceptedTrade(records, scan);
    setRecords(saved.records);
  };
  const isCurrentTradeTaken = Boolean(scan && records.some(record => record.raw?.scan_id === scan.scanId || record.snapshot?.scanId === scan.scanId || hasJournalAcceptance([record], scan)));
  const manuallyCloseTrade = async record => {
    const value = window.prompt('Enter the actual exit price for this manually closed trade.');
    if (value == null) return;
    const exitPrice = Number(value);
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) { setError(new MarketEdgeApiError('Enter a valid positive exit price.', { code: 'EXIT_PRICE_INVALID' })); return; }
    try { const result = await closeCloudTrade(record.id, exitPrice, { accessToken }); const row = result.trade; setRecords(current => current.map(item => item.id === row.id ? { ...item, status: row.status, raw: row, snapshot: row.snapshot?.trade || item.snapshot } : item)); }
    catch (cause) { setError(cause); }
  };
  const goSettings = () => setPage('settings');
  const finishAuth = value => { if (value === 'login' || value === 'signup') setAuthMode(value); else if (value) setAuthMode(null); };
  const logout = async () => { await signOut(); setUser(null); setAccessToken(null); setAccount(null); setRecords(loadJournal()); };
  return <div className="app-shell"><header className="topbar"><Brand/><nav aria-label="Customer beta navigation">{NAV.map(([key, label]) => <button type="button" key={key} className={page === key ? 'active' : ''} aria-current={page === key ? 'page' : undefined} onClick={() => setPage(key)}>{label}</button>)}</nav><div className="live-indicator"><i/>{user ? 'Account secure' : 'Guest secure'}</div></header>{page === 'trade' && <TradeView scan={scan} scanning={scanning} error={error} onScan={startScan} onTake={takeTrade} taken={isCurrentTradeTaken} onSettings={goSettings} selected={selected} onSelect={setSelected} account={account}/>} {page === 'trades' && <MyTrades records={records} cloud={Boolean(user)} onDelete={id => setRecords(removeLocalTrade(records, id))} onClose={manuallyCloseTrade}/>} {page === 'performance' && <Performance records={records}/>} {page === 'settings' && <Settings settings={settings} setSettings={setSettings} account={account} user={user} onAuth={() => setAuthMode('login')} onLogout={logout}/>} {authMode && <AuthDialog mode={authMode} onClose={() => setAuthMode(null)} onComplete={finishAuth}/>}<footer><span>Market Edge does not place orders.</span><span>Customer beta · Manual execution only</span></footer></div>;
}
