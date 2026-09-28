'use strict';

// Research-only candle archive for the clean Phase 5 rebuild.
//
// Every candle carries venue, instrument type, product and source.  The
// archive never fills, forward-fills, or substitutes a missing candle: gaps are
// recorded explicitly and downstream code must fail closed on them.  Monthly
// manifests hash the exact candle content so a later refetch can be verified.
const crypto = require('node:crypto');

const BASE_MS = 300_000;
const ARCHIVE_VERSION = 'candle-archive-v1';
const SOURCES = Object.freeze({
  COINBASE_SPOT: {venue: 'COINBASE', instrumentType: 'SPOT', quote: 'USD', source: 'api.exchange.coinbase.com/products/{product}/candles?granularity=300'}
});
const PRODUCTS = Object.freeze({BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', LTC: 'LTC-USD'});

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// Coinbase Exchange rows are [time_seconds, low, high, open, close, volume].
function fromCoinbase(rows, {asset, product}) {
  return (Array.isArray(rows) ? rows : []).map(row => ({time: finite(row?.[0]) === null ? null : finite(row[0]) * 1000, open: finite(row?.[3]), high: finite(row?.[2]), low: finite(row?.[1]), close: finite(row?.[4]), volume: finite(row?.[5]), asset, product}));
}

// Validates a series without repairing it.  Returns the clean ordered rows
// plus every defect found; callers decide whether a defect is fatal.
function validateSeries(rows, {now = Date.now(), interval = BASE_MS} = {}) {
  const issues = {invalidOhlc: 0, offGrid: 0, future: 0, duplicates: 0, conflictingDuplicates: 0, nonMonotonicInput: 0};
  for (let i = 1; i < rows.length; i++) if (!(rows[i].time > rows[i - 1].time)) issues.nonMonotonicInput++;
  const byTime = new Map();
  for (const row of rows) {
    const values = [row.time, row.open, row.high, row.low, row.close, row.volume];
    if (!values.every(Number.isFinite) || row.open <= 0 || row.low <= 0 || row.volume < 0 || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) { issues.invalidOhlc++; continue; }
    if (row.time % interval !== 0) { issues.offGrid++; continue; }
    if (row.time + interval > now) { issues.future++; continue; }
    const existing = byTime.get(row.time);
    if (existing) { issues.duplicates++; if (['open', 'high', 'low', 'close', 'volume'].some(key => existing[key] !== row[key])) issues.conflictingDuplicates++; continue; }
    byTime.set(row.time, row);
  }
  const clean = [...byTime.values()].sort((a, b) => a.time - b.time);
  return {rows: clean, issues, gaps: gapsOf(clean, interval)};
}
function gapsOf(rows, interval = BASE_MS) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) { const step = rows[i].time - rows[i - 1].time; if (step > interval) gaps.push({from: rows[i - 1].time + interval, to: rows[i].time, missing: step / interval - 1}); }
  return gaps;
}
// Constant-time "how many 5m slots are missing in [start, end)" queries.
function presenceIndex(rows, interval = BASE_MS) {
  if (!rows.length) return {start: 0, end: 0, missing: () => Infinity, has: () => false, rows, byTime: new Map()};
  const start = rows[0].time, end = rows.at(-1).time + interval, slots = (end - start) / interval, prefix = new Int32Array(slots + 1), byTime = new Map(rows.map(row => [row.time, row]));
  for (let i = 0; i < slots; i++) prefix[i + 1] = prefix[i] + (byTime.has(start + i * interval) ? 1 : 0);
  const clampSlot = time => Math.max(0, Math.min(slots, Math.floor((time - start) / interval)));
  return {start, end, rows, byTime, has: time => byTime.has(time),
    // Slots before the archive start or after its end count as missing.
    missing: (from, to) => { const expected = Math.max(0, Math.round((to - from) / interval)); const a = clampSlot(Math.max(from, start)), b = clampSlot(Math.min(to, end)); const present = b > a ? prefix[b] - prefix[a] : 0; return expected - present; }};
}
function monthKey(time) { return new Date(time).toISOString().slice(0, 7); }
// One manifest entry per asset-month: expected vs present slots, gaps, and a
// sha256 of the canonical candle text, so any refetch can be verified exactly.
function monthlyManifest(rows, {asset, product, sourceKey = 'COINBASE_SPOT', from, to, interval = BASE_MS}) {
  const source = SOURCES[sourceKey], months = new Map();
  for (let cursor = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1); cursor < to; ) { const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 1); months.set(monthKey(cursor), {start: Math.max(cursor, from), end: Math.min(next.getTime(), to), rows: []}); cursor = next.getTime(); }
  for (const row of rows) { if (!Number.isFinite(row.time)) continue; const month = months.get(monthKey(row.time)); if (month && row.time >= month.start && row.time < month.end) month.rows.push(row); }
  return [...months.entries()].map(([month, value]) => {
    const expected = Math.round((value.end - value.start) / interval), text = value.rows.map(row => [row.time, row.open, row.high, row.low, row.close, row.volume].join(',')).join('\n'), gaps = gapsOf(value.rows, interval);
    const leading = value.rows.length ? (value.rows[0].time - value.start) / interval : expected, trailing = value.rows.length ? (value.end - value.rows.at(-1).time - interval) / interval : 0;
    return {archive_version: ARCHIVE_VERSION, asset, product, venue: source.venue, instrument_type: source.instrumentType, quote: source.quote, source: source.source, month, start: value.start, end: value.end, expected, present: value.rows.length, missing: expected - value.rows.length, coverage: expected ? value.rows.length / expected : 0, internal_gaps: gaps.length, longest_gap_minutes: Math.max(0, leading, trailing, ...gaps.map(gap => gap.missing)) * interval / 60000, sha256: sha256(text)};
  });
}
// Missing periods merged into human-readable ranges (>= minMissing slots).
function missingPeriods(rows, {from, to, interval = BASE_MS, minMissing = 12} = {}) {
  const periods = [], add = (start, end) => { const missing = (end - start) / interval; if (missing >= minMissing) periods.push({from: new Date(start).toISOString(), to: new Date(end).toISOString(), missing_candles: missing, hours: missing * interval / HOUR}); };
  const HOUR = 3_600_000; if (!rows.length) { add(from, to); return periods; }
  if (rows[0].time > from) add(from, rows[0].time);
  for (const gap of gapsOf(rows, interval)) add(gap.from, gap.to);
  const last = rows.at(-1).time + interval; if (last < to) add(last, to);
  return periods;
}

module.exports = {BASE_MS, ARCHIVE_VERSION, SOURCES, PRODUCTS, fromCoinbase, validateSeries, gapsOf, presenceIndex, monthlyManifest, missingPeriods, sha256};
