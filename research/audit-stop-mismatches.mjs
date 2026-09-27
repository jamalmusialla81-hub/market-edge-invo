#!/usr/bin/env node
// Step-1 label audit: explain the entry-price outlier and every sampled stop
// disagreement between the stored Coinbase label and the independent Binance
// spot path.  For every sampled development row it measures, in bps of entry:
//   - the stop distance
//   - how far each venue's adverse extreme went beyond (+) or stayed short of
//     (-) the stored stop over the exact labelled holding window
//   - Coinbase 5m vs Binance 1m (and Binance aggregated to 5m) extremes
// It then tests whether disagreements are near-misses from ordinary venue
// divergence or a systematic labelling problem.  Development rows only.
import {readFileSync, writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import Clean from './historical-rank-v2-clean.js';
import V2 from './rank-research-v2.js';
import {archiveCsv} from './recover-historical-rank-outcomes.mjs';

const CF = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8ea7796a8fb13ffb612245e8a08a55d6', DB = process.env.MARKET_EDGE_D1_DATABASE_ID || '39a4082e-41a4-45e9-9b76-99cf10eaca01';
const DIR = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive', ENGINE = process.env.V2_CLEAN_AUDIT_ENGINE || Clean.NATIVE_HTF_VERSION;
const AUDIT = process.env.V2_CLEAN_AUDIT_INPUT || 'research/data/v2-clean/audit-report-native-htf.json', REPORT = process.env.STOP_AUDIT_REPORT || 'research/data/v2-clean/stop-mismatch-audit.json';
const NEAR_MISS_BPS = Number(process.env.NEAR_MISS_BPS) || 15;    // fixed before looking at the result
const B = 300_000;
async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('READ_ONLY_VIOLATION');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
  return body.result?.[0]?.results || [];
}
const ms = v => { const t = Number(v); return t > 1e14 ? Math.floor(t / 1000) : t; };
const cache = new Map();
async function binanceDay(asset, day) { const key = `${asset}${day}`; if (cache.has(key)) return cache.get(key); const date = new Date(day).toISOString().slice(0, 10), symbol = `${asset}USDT`, response = await fetch(`https://data.binance.vision/data/spot/daily/klines/${symbol}/1m/${symbol}-1m-${date}.zip`); const rows = response.ok ? archiveCsv(await response.arrayBuffer()).map(r => ({time: ms(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4]})).filter(r => Number.isFinite(r.time) && r.open > 0) : null; cache.set(key, rows); return rows; }
async function binancePath(asset, from, to) { const out = []; for (let day = Math.floor(from / 864e5) * 864e5; day < to; day += 864e5) { const rows = await binanceDay(asset, day); if (!rows) return null; out.push(...rows); } return out.filter(r => r.time >= from && r.time < to).sort((a, b) => a.time - b.time); }
const readCsv = path => gunzipSync(readFileSync(path)).toString().trim().split('\n').filter(Boolean).map(line => { const [time, open, high, low, close, volume] = line.split(',').map(Number); return {time, open, high, low, close, volume}; });
const quant = (v, q) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
const mean = v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;

const audit = JSON.parse(readFileSync(AUDIT, 'utf8')), ids = audit.inspected.map(item => item.candidate_id);
const rows = [];
for (let i = 0; i < ids.length; i += 50) rows.push(...await d1(`SELECT c.candidate_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.targets_json,s.scan_timestamp FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id WHERE s.engine_version=? AND s.scan_timestamp<? AND c.candidate_id IN (${ids.slice(i, i + 50).map(() => '?').join(',')})`, [ENGINE, V2.HOLDOUT.devCutoffMs, ...ids.slice(i, i + 50)]));
const archives = new Map(), results = [];
for (const raw of rows) {
  const t = JSON.parse(raw.targets_json), ts = Number(raw.scan_timestamp); if (t.status !== 'RESOLVED') continue;
  if (!archives.has(raw.asset)) archives.set(raw.asset, new Map(readCsv(join(DIR, `${raw.asset}.csv.gz`)).map(r => [r.time, r])));
  const cb = archives.get(raw.asset), s = raw.direction === 'long' ? 1 : -1, entry = t.fill_price, distance = Math.abs(t.entry_price - Number(raw.stop)), stop = entry - s * distance, end = ts + t.duration_bars * B;
  const cbBars = []; for (let k = 0; k < t.duration_bars; k++) cbBars.push(cb.get(ts + k * B));
  const bn = await binancePath(raw.asset, ts, end); if (!bn?.length) continue;
  // adverse extreme beyond the stop, in bps of entry (+ = breached)
  const beyond = price => s * (stop - price) / entry * 1e4, cbExtreme = Math.max(...cbBars.map(bar => beyond(s > 0 ? bar.low : bar.high))), bnExtreme = Math.max(...bn.map(bar => beyond(s > 0 ? bar.low : bar.high)));
  // venue basis over the window: median Coinbase 5m close / Binance close at the same instant
  const basis = cbBars.map(bar => { const b = bn.find(x => x.time === bar.time + B - 60_000); return b ? (bar.close / b.close - 1) * 1e4 : null; }).filter(Number.isFinite);
  results.push({candidate_id: raw.candidate_id, asset: raw.asset, direction: raw.direction, strategy: raw.strategy, date: new Date(ts).toISOString().slice(0, 16), stop_distance_bps: distance / entry * 1e4, stored_stop: t.STOP_HIT, stored_exit: t.exit_reason, coinbase_beyond_stop_bps: cbExtreme, binance_beyond_stop_bps: bnExtreme, venue_extreme_gap_bps: cbExtreme - bnExtreme, window_median_basis_bps: quant(basis, .5), independent_stop: bnExtreme >= 0});
}
const mismatches = results.filter(r => r.stored_stop !== r.independent_stop), cbOnly = mismatches.filter(r => r.stored_stop), bnOnly = mismatches.filter(r => !r.stored_stop);
const nearMiss = r => Math.abs(r.binance_beyond_stop_bps) <= NEAR_MISS_BPS && Math.abs(r.coinbase_beyond_stop_bps) <= Math.max(NEAR_MISS_BPS, Math.abs(r.venue_extreme_gap_bps) + 1);
// Symmetry test over ALL sampled rows: is Coinbase's adverse extreme deeper than Binance's in general?
const gaps = results.map(r => r.venue_extreme_gap_bps);
let signTests = {deeperOnCoinbase: gaps.filter(g => g > 0).length, deeperOnBinance: gaps.filter(g => g < 0).length};
const n = signTests.deeperOnCoinbase + signTests.deeperOnBinance, z = n ? (signTests.deeperOnCoinbase - n / 2) / Math.sqrt(n / 4) : null;
const outlier = audit.inspected.slice().sort((a, b) => Math.abs(b.entry_error_bps ?? 0) - Math.abs(a.entry_error_bps ?? 0))[0];
let outlierContext = null;
if (outlier) {
  const ts = Date.parse(outlier.date + ':00Z'), bn = await binancePath(outlier.asset, ts - 30 * 60_000, ts + 30 * 60_000), cb = archives.get(outlier.asset) || new Map(readCsv(join(DIR, `${outlier.asset}.csv.gz`)).map(r => [r.time, r]));
  const around = [-3, -2, -1, 0, 1, 2].map(k => { const bar = cb.get(ts + k * B), b = bn?.find(x => x.time === ts + (k + 1) * B - 60_000); return bar && b ? {bar_open_utc: new Date(ts + k * B).toISOString().slice(11, 16), coinbase_close: bar.close, binance_close_same_minute: b.close, diff_bps: (bar.close / b.close - 1) * 1e4, coinbase_range_bps: (bar.high / bar.low - 1) * 1e4} : null; }).filter(Boolean);
  outlierContext = {...outlier, neighbouring_5m: around, binance_30min_range_bps: bn?.length ? (Math.max(...bn.map(x => x.high)) / Math.min(...bn.map(x => x.low)) - 1) * 1e4 : null};
}
const report = {dataset_version: ENGINE, scope: 'sampled development rows from the committed audit; holdout excluded', near_miss_threshold_bps: NEAR_MISS_BPS, checked: results.length,
  mismatches: mismatches.length, coinbase_stop_only: cbOnly.length, binance_stop_only: bnOnly.length, near_miss_mismatches: mismatches.filter(nearMiss).length,
  mismatch_detail: mismatches.map(r => ({...r, near_miss: nearMiss(r)})),
  venue_symmetry_all_rows: {...signTests, sign_test_z: z, median_gap_bps: quant(gaps, .5), mean_gap_bps: mean(gaps), p90_gap_bps: quant(gaps, .9), median_window_basis_bps: quant(results.map(r => r.window_median_basis_bps), .5)},
  entry_outlier: outlierContext};
writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report));
