#!/usr/bin/env node
// Independent audit of HISTORICAL-RANK-V2-CLEAN (development rows only; the
// sealed holdout is never read).  The audit venue — Binance SPOT 1m public
// archives — is never used to construct any entry or label.
//   1. entry-price error: stored Coinbase decision price / entry open vs the
//      independent Binance spot price at the same instant
//   2. label reproducibility: recompute every sampled label from the verified
//      Coinbase archive and require an identical result
//   3. independent label agreement: replay the same geometry on the Binance
//      spot 1m path and compare stop / TP1 events
//   4. provenance completeness of every stored development row
import {readFileSync, writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import Clean from './historical-rank-v2-clean.js';
import Rank from './historical-rank.js';
import V2 from './rank-research-v2.js';
import {archiveCsv} from './recover-historical-rank-outcomes.mjs';

const CF = process.env.CLOUDFLARE_API_TOKEN || '', ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '8ea7796a8fb13ffb612245e8a08a55d6', DB = process.env.MARKET_EDGE_D1_DATABASE_ID || '39a4082e-41a4-45e9-9b76-99cf10eaca01';
const ENGINE = process.env.V2_CLEAN_AUDIT_ENGINE || Clean.VERSION, HTF_NATIVE = ENGINE === Clean.NATIVE_HTF_VERSION;
const DIR = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive', REPORT = process.env.V2_CLEAN_AUDIT_REPORT || 'v2-clean-audit-report.json', SAMPLE = Math.max(50, Number(process.env.V2_CLEAN_AUDIT_SAMPLE) || 80);
const REQUIRED = ['dataset_version', 'label_version', 'scan_id', 'scan_timestamp', 'asset', 'entry_source', 'entry_venue', 'entry_instrument_type', 'latest_feature_candle_timestamp', 'freshness_status'];
const REQUIRED_TARGET = ['entry_timestamp', 'entry_price', 'entry_source', 'entry_venue', 'entry_instrument_type', 'outcome_source', 'outcome_venue', 'outcome_instrument_type', 'label_version', 'dataset_version'];
async function d1(sql, params = []) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('READ_ONLY_VIOLATION');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {method: 'POST', headers: {authorization: `Bearer ${CF}`, 'content-type': 'application/json'}, body: JSON.stringify({sql, params})}), body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`D1 query failed: ${body?.errors?.[0]?.message || response.status}`);
  return body.result?.[0]?.results || [];
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const quant = (values, q) => { const s = values.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
const ms = value => { const t = Number(value); return t > 1e14 ? Math.floor(t / 1000) : t; };
const binanceCache = new Map();
async function binanceDay(asset, day) {
  const key = `${asset}-${day}`; if (binanceCache.has(key)) return binanceCache.get(key);
  const date = new Date(day).toISOString().slice(0, 10), symbol = `${asset}USDT`, response = await fetch(`https://data.binance.vision/data/spot/daily/klines/${symbol}/1m/${symbol}-1m-${date}.zip`);
  const rows = response.ok ? archiveCsv(await response.arrayBuffer()).map(r => ({time: ms(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4]})).filter(r => Number.isFinite(r.time) && r.open > 0) : null;
  binanceCache.set(key, rows); return rows;
}
async function binancePath(asset, from, to) { const out = []; for (let day = Math.floor(from / 86_400_000) * 86_400_000; day < to; day += 86_400_000) { const rows = await binanceDay(asset, day); if (!rows) return null; out.push(...rows); } return out.filter(r => r.time >= from && r.time < to).sort((a, b) => a.time - b.time); }
// Same geometry and stop-first rules, replayed on the independent 1m path.
function independentEvents(row, target, path) {
  const s = row.direction === 'long' ? 1 : -1, entry = target.fill_price, distance = Math.abs(target.entry_price - row.stop), stop = entry - s * distance, tp1 = entry + s * distance * row.rr; let tp1Hit = false;
  for (const c of path) { const lowT = s > 0 ? c.low <= (tp1Hit ? entry : stop) : c.high >= (tp1Hit ? entry : stop), hit1 = s > 0 ? c.high >= tp1 : c.low <= tp1; if (lowT) return {stopHit: true, tp1Hit}; if (!tp1Hit && hit1) tp1Hit = true; }
  return {stopHit: false, tp1Hit};
}
function readCsv(path) { return gunzipSync(readFileSync(path)).toString().trim().split('\n').filter(Boolean).map(line => { const [time, open, high, low, close, volume] = line.split(',').map(Number); return {time, open, high, low, close, volume}; }); }
function loadAsset(asset) { const native = HTF_NATIVE ? {h1: readCsv(join(DIR, `${asset}-1h.csv.gz`)), d1: readCsv(join(DIR, `${asset}-1d.csv.gz`))} : null; return Clean.prepareAsset(asset, readCsv(join(DIR, `${asset}.csv.gz`)), {native}); }

const rows = (await d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.valid_current_geometry,c.feature_json,c.targets_json,s.scan_timestamp FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id WHERE s.engine_version=? AND s.scan_timestamp<? AND c.valid_current_geometry=1 ORDER BY s.scan_timestamp,c.candidate_id`, [ENGINE, V2.HOLDOUT.devCutoffMs])).map(row => { const features = JSON.parse(row.feature_json || '{}'); return {...row, timestamp: Number(row.scan_timestamp), entry: Number(row.entry), stop: Number(row.stop), rr: Number(row.rr), provenance: features.provenance || {}, targets: JSON.parse(row.targets_json || '{}')}; });
if (rows.some(row => row.timestamp >= V2.HOLDOUT.devCutoffMs)) throw new Error('HOLDOUT_BREACH');
const provenanceMissing = rows.filter(row => REQUIRED.some(key => row.provenance[key] === undefined || row.provenance[key] === null) || (row.targets.status === 'RESOLVED' && REQUIRED_TARGET.some(key => row.targets[key] === undefined)));
const staleRows = rows.filter(row => row.provenance.freshness_status !== 'FRESH_EXACT' || row.provenance.latest_feature_candle_timestamp !== row.timestamp - 300_000);
// Cross-venue constructed: any entry, outcome, or fed timeframe not from Coinbase spot.
const foreignVenue = rows.filter(row => row.provenance.entry_venue !== 'COINBASE' || row.provenance.entry_instrument_type !== 'SPOT' || (row.targets.status === 'RESOLVED' && (row.targets.outcome_venue !== 'COINBASE' || row.targets.outcome_instrument_type !== 'SPOT')) || Object.values(row.provenance.history_window?.frame_sources || {}).some(source => !/^(COINBASE_SPOT|AGGREGATED_FROM_COINBASE_SPOT)/.test(source)) || (HTF_NATIVE && !row.provenance.history_window?.frame_sources));
const versionMismatch = rows.filter(row => row.provenance.dataset_version !== ENGINE || (row.targets.status === 'RESOLVED' && row.targets.dataset_version !== ENGINE));
const random = rng(20260927), sample = rows.slice().sort((a, b) => random() - .5).slice(0, SAMPLE), assets = new Map();
const inspected = [], decisionErr = [], entryErr = [], agreement = {checked: 0, stopAgree: 0, tp1Agree: 0, noBinanceData: 0}, reproduce = {checked: 0, identical: 0, mismatches: []};
for (const row of sample) {
  if (!assets.has(row.asset)) assets.set(row.asset, loadAsset(row.asset));
  const prepared = assets.get(row.asset), recomputed = Clean.resolveStrict({...row, valid_current_geometry: true}, prepared);
  reproduce.checked++; if (Rank.hash(recomputed) === Rank.hash(row.targets)) reproduce.identical++; else reproduce.mismatches.push(row.candidate_id);
  const path = await binancePath(row.asset, row.timestamp - 60_000, row.timestamp + 86_400_000 + 60_000);
  const item = {candidate_id: row.candidate_id, asset: row.asset, date: new Date(row.timestamp).toISOString().slice(0, 16), direction: row.direction, strategy: row.strategy, decision_price: row.entry, entry_price: row.targets.entry_price ?? null, status: row.targets.status};
  if (!path?.length) { agreement.noBinanceData++; item.independent = 'NO_BINANCE_SPOT_DATA'; inspected.push(item); continue; }
  const atDecision = path.find(c => c.time === row.timestamp - 60_000), atEntry = path.find(c => c.time === row.timestamp);
  if (atDecision) { item.binance_decision_close = atDecision.close; item.decision_error_bps = (row.entry / atDecision.close - 1) * 1e4; decisionErr.push(Math.abs(item.decision_error_bps)); }
  if (atEntry && row.targets.entry_price) { item.binance_entry_open = atEntry.open; item.entry_error_bps = (row.targets.entry_price / atEntry.open - 1) * 1e4; entryErr.push(Math.abs(item.entry_error_bps)); }
  if (row.targets.status === 'RESOLVED') { const ev = independentEvents(row, row.targets, path.filter(c => c.time >= row.timestamp && c.time < row.timestamp + row.targets.duration_bars * 300_000)); agreement.checked++; if (ev.stopHit === row.targets.STOP_HIT) agreement.stopAgree++; if (ev.tp1Hit === row.targets.TP1_BEFORE_SL) agreement.tp1Agree++; item.stored = {stop: row.targets.STOP_HIT, tp1: row.targets.TP1_BEFORE_SL, exit: row.targets.exit_reason}; item.independent = {stop: ev.stopHit, tp1: ev.tp1Hit}; }
  inspected.push(item);
}
const dist = values => ({n: values.length, p50_bps: quant(values, .5), p95_bps: quant(values, .95), max_bps: values.length ? Math.max(...values) : null});
const stopRate = agreement.checked ? agreement.stopAgree / agreement.checked : null, tp1Rate = agreement.checked ? agreement.tp1Agree / agreement.checked : null;
const labelPass = reproduce.checked > 0 && reproduce.identical === reproduce.checked && !provenanceMissing.length && !foreignVenue.length && !versionMismatch.length && !staleRows.length && (stopRate ?? 0) >= .9 && (tp1Rate ?? 0) >= .9;
const report = {dataset_version: ENGINE, audited_at: new Date().toISOString(), scope: 'development rows only (scan_timestamp < holdout dev cutoff)', audit_source: 'Binance SPOT 1m public archive (USDT quote); never used to construct entries or labels', rows: rows.length, sampled: sample.length,
  decision_price_error_abs: dist(decisionErr), entry_price_error_abs: dist(entryErr), provenance_missing: provenanceMissing.length, stale_rows: staleRows.length, cross_venue_constructed_rows: foreignVenue.length, dataset_version_mismatch: versionMismatch.length,
  label_reproducibility: reproduce, independent_label_agreement: {...agreement, stopAgreement: stopRate, tp1Agreement: tp1Rate}, label_audit: labelPass ? 'PASS' : 'FAIL', inspected};
writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({...report, inspected: inspected.slice(0, 60)}));
