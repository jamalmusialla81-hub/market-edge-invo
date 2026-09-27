import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../api';

/** Poll a backend read. Keeps the last good value and surfaces the latest error. */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const refresh = useCallback(async () => {
    try {
      const value = await fnRef.current();
      setData(value);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) void refresh(); };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refresh, ...deps]);
  return { data, error, updatedAt, refresh };
}

export function Stat({ label, value, tone = '', sub, big = false }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode; big?: boolean }) {
  return (
    <div className={`stat ${big ? 'big' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone}`}>{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Dot({ status }: { status: string }) {
  return <span className={`dot dot-${status.toLowerCase()}`} aria-hidden />;
}

export function Badge({ children, kind = 'neutral' }: { children: ReactNode; kind?: 'pos' | 'neg' | 'warn' | 'neutral' | 'info' }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function Panel({ title, children, right, className = '' }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head"><h2>{title}</h2>{right}</header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="banner banner-error" role="alert">{error}</div>;
}

/** Confirmation that makes the operator type a word, for irreversible or risk-bearing actions. */
export function ConfirmDialog({ title, body, word, confirmLabel, danger = true, onConfirm, onCancel }: {
  title: string; body: ReactNode; word: string; confirmLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`modal ${danger ? 'modal-danger' : ''}`}>
        <h3>{title}</h3>
        <div className="modal-body">{body}</div>
        <label className="modal-confirm">
          <span>Type <code>{word}</code> to confirm</span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Type ${word} to confirm`}
            onKeyDown={(e) => { if (e.key === 'Enter' && typed === word) onConfirm(); if (e.key === 'Escape') onCancel(); }} />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'btn-kill' : 'btn-primary'}`} disabled={typed !== word} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function Table({ head, children, empty, colSpan }: { head: ReactNode[]; children: ReactNode; empty?: string | false; colSpan?: number }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {children}
          {empty && <tr><td className="empty" colSpan={colSpan ?? head.length}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
