import { useEffect, useState } from 'react';
import { api, errorText, RiskUsage } from '../api';
import { ErrorBanner, Panel, usePoll } from '../components/ui';
import { DASH, num, usageLevel, usd } from '../format';

const FIELDS: { key: string; label: string; unit: string; step: number; help: string }[] = [
  { key: 'max_risk_per_trade_pct', label: 'Max risk / trade', unit: '% equity', step: 0.05, help: 'Loss at the stop. Size = risk budget / stop distance; leverage never raises it.' },
  { key: 'max_portfolio_exposure_pct', label: 'Max total exposure', unit: '% equity', step: 1, help: 'Open + new notional. A trade that would exceed it is shrunk or rejected.' },
  { key: 'max_concurrent_positions', label: 'Max concurrent positions', unit: '', step: 1, help: '' },
  { key: 'leverage_ceiling', label: 'Max leverage', unit: 'x', step: 1, help: 'Upper bound; risk walks leverage down to clear the liquidation floors.' },
  { key: 'daily_loss_limit_pct', label: 'Daily loss limit', unit: '% equity', step: 0.5, help: 'New entries rejected once hit (UTC day).' },
  { key: 'drawdown_limit_pct', label: 'Max drawdown limit', unit: '% from peak', step: 1, help: '' },
  { key: 'min_liquidation_buffer_pct', label: 'Liquidation buffer', unit: '% of entry', step: 0.5, help: 'Stop must trigger at least this far before the liquidation estimate.' },
  { key: 'stale_data_timeout_s', label: 'Stale-data timeout', unit: 's', step: 10, help: 'Max age of the live mid used for an entry.' },
];

export function UsageRow({ u }: { u: RiskUsage }) {
  const level = usageLevel(u.current, u.limit, u.floor);
  const digits = u.unit === '' || u.unit === 's' ? 0 : 2;
  const fill = u.current === null ? 0 : u.floor ? Math.min(100, (u.limit / Math.max(u.current, 1e-9)) * 100) : Math.min(100, (u.current / u.limit) * 100);
  return (
    <div className={`usage usage-${level}`}>
      <div className="usage-head">
        <span>{u.label}</span>
        <span className="num">{u.current === null ? DASH : num(u.current, digits)}{u.unit} {u.floor ? '≥' : '/'} {num(u.limit, digits)}{u.unit}</span>
      </div>
      <div className="usage-track"><div className="usage-fill" style={{ width: `${fill}%` }} /></div>
    </div>
  );
}

export function Risk() {
  const config = usePoll(api.riskConfig, 15000);
  const usage = usePoll(api.riskUsage, 3000);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config.data && !Object.keys(draft).length) {
      setDraft({ ...Object.fromEntries(Object.entries(config.data.settings).map(([k, v]) => [k, String(v)])), starting_equity: String(config.data.starting_equity) });
    }
  }, [config.data, draft]);

  const c = config.data;
  const changed = c ? Object.entries(draft).filter(([k, v]) => (k === 'starting_equity' ? Number(v) !== c.starting_equity : Number(v) !== c.settings[k])) : [];

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const update = Object.fromEntries(changed.map(([k, v]) => [k, Number(v)]));
      await api.updateRiskConfig(update);
      setResult({ kind: 'ok', text: `Saved and validated by the backend: ${changed.map(([k]) => k).join(', ')}` });
      await config.refresh();
      await usage.refresh();
      setDraft({}); // repopulated from the refreshed backend values
    } catch (e) {
      setResult({ kind: 'err', text: `Rejected by the backend: ${errorText(e)}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="screen">
      <ErrorBanner error={config.error ?? usage.error} />
      <div className="grid-2">
        <Panel title="Current usage vs limits">
          {(usage.data?.usage ?? []).map((u) => <UsageRow key={u.key} u={u} />)}
          {!usage.data && <div className="muted">{DASH}</div>}
        </Panel>
        <Panel title="Risk settings" right={<span className="muted small">Persisted in the execution-service database; validated server-side</span>}>
          <form className="settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label className="setting">
              <span className="setting-label">Account equity (starting)</span>
              <input type="number" step={100} value={draft.starting_equity ?? ''} disabled={!c?.starting_equity_editable}
                onChange={(e) => setDraft({ ...draft, starting_equity: e.target.value })} />
              <span className="setting-unit">USD</span>
              <span className="setting-help">{c?.starting_equity_editable ? 'Editable until the first paper trade.' : `Locked at ${usd(c?.starting_equity)}: the session already has trades.`}</span>
            </label>
            {FIELDS.map((f) => {
              const bounds = c?.bounds[f.key];
              return (
                <label className="setting" key={f.key}>
                  <span className="setting-label">{f.label}</span>
                  <input type="number" step={f.step} value={draft[f.key] ?? ''} min={bounds?.[0]} max={bounds?.[1]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                  <span className="setting-unit">{f.unit}</span>
                  <span className="setting-help">{bounds ? `Allowed ${bounds[0]}–${bounds[1]}. ` : ''}{f.help}</span>
                </label>
              );
            })}
            <div className="settings-actions">
              <button type="submit" className="btn btn-primary" disabled={!changed.length || saving}>{saving ? 'Saving…' : `Save ${changed.length || ''} change${changed.length === 1 ? '' : 's'}`}</button>
              <button type="button" className="btn" disabled={!changed.length || saving} onClick={() => setDraft({})}>Discard</button>
              {result && <span className={`control-msg ${result.kind}`}>{result.text}</span>}
            </div>
          </form>
        </Panel>
      </div>
    </div>
  );
}
