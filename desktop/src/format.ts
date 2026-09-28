// Display formatting only. No trading math lives in the UI: every PnL, R,
// exposure and drawdown figure arrives computed by the execution-service.
export const DASH = '—';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function usd(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (!isNum(v)) return DASH;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? '-' : opts.sign && v > 0 ? '+' : '';
  return `${sign}$${s}`;
}

export function pct(v: number | null | undefined, digits = 2, opts: { sign?: boolean } = {}): string {
  if (!isNum(v)) return DASH;
  const sign = opts.sign && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

/** Prices: enough significant digits for both BTC and sub-cent assets. */
export function price(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits });
}

export function num(v: number | null | undefined, digits = 2): string {
  return isNum(v) ? v.toFixed(digits) : DASH;
}

export function qty(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 6 });
}

export function lev(v: number | null | undefined): string {
  return isNum(v) ? `${Number.isInteger(v) ? v : v.toFixed(2)}x` : DASH;
}

export function ts(ms: number | null | undefined): string {
  if (!isNum(ms)) return DASH;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!isNum(ms)) return DASH;
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `in ${duration(-s)}`;
  return `${duration(s)} ago`;
}

export function duration(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return h < 48 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 'pos' | 'neg' | '' -- drives green/red PnL coloring. */
export function tone(v: number | null | undefined): 'pos' | 'neg' | '' {
  if (!isNum(v) || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}

/** How close a usage figure is to its limit: 'ok' < 70% <= 'warn' < 100% <= 'breach'.
 *  `floor` limits (e.g. a minimum liquidation buffer) are breached from below. */
export function usageLevel(current: number | null, limit: number, floor = false): 'ok' | 'warn' | 'breach' | 'na' {
  if (!isNum(current) || !isNum(limit) || limit === 0) return 'na';
  if (floor) {
    if (current < limit) return 'breach';
    return current < limit * 1.5 ? 'warn' : 'ok';
  }
  const ratio = current / limit;
  if (ratio >= 1) return 'breach';
  return ratio >= 0.7 ? 'warn' : 'ok';
}
