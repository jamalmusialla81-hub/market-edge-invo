#!/usr/bin/env node
// Builds the clean-rebuild candle archive from the SAME venue and instrument
// family the signals use: Coinbase Exchange spot, USD quote, 5m candles.
// No other venue is consulted here.  Nothing is filled or substituted: every
// missing slot stays missing and is reported.  Read-only against production.
import {mkdirSync, writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {join} from 'node:path';
import Archive from './candle-archive.js';

const OUT = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive', MANIFEST_OUT = process.env.CANDLE_MANIFEST_OUT || join(OUT, 'manifest.json');
const FROM = Date.parse(process.env.CANDLE_FROM || '2023-06-01T00:00:00Z');
const NOW = Date.now(), TO = Math.floor((Number(process.env.CANDLE_TO_MS) || NOW) / 86_400_000) * 86_400_000; // whole UTC days only
const ASSETS = (process.env.CANDLE_ASSETS || 'BTC,ETH,SOL,XRP,DOGE,LTC').split(',');
const PAGE = 300, BASE = Archive.BASE_MS, NATIVE = [['1h', 3600], ['1d', 86400]], RPS = Math.max(1, Number(process.env.COINBASE_RPS) || 4);
let lastRequest = 0, requests = 0, retries = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function throttle() { const wait = lastRequest + 1000 / RPS - Date.now(); lastRequest = Math.max(Date.now(), lastRequest + 1000 / RPS); if (wait > 0) await sleep(wait); }
async function page(product, start, end, granularity = 300) {
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularity}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    await throttle(); requests++;
    let response; try { response = await fetch(url, {headers: {accept: 'application/json', 'user-agent': 'MarketEdgeResearch/2.0 (clean rebuild)'}}); } catch (error) { retries++; await sleep(1000 * (attempt + 1)); continue; }
    if (response.ok) { const body = await response.json(); if (!Array.isArray(body)) throw new Error(`${product} malformed page`); return body; }
    if ([429, 500, 502, 503, 504].includes(response.status)) { retries++; await sleep(1500 * (attempt + 1)); continue; }
    throw new Error(`${product} HTTP ${response.status} ${(await response.text()).slice(0, 120)}`);
  }
  throw new Error(`${product} page ${new Date(start).toISOString()} failed after retries`);
}
async function asset(name) {
  const product = Archive.PRODUCTS[name], raw = [];
  // Coinbase treats start and end as inclusive bucket starts; 300 buckets max.
  for (let start = FROM; start < TO; start += PAGE * BASE) raw.push(...Archive.fromCoinbase(await page(product, start, Math.min(TO - BASE, start + (PAGE - 1) * BASE)), {asset: name, product}));
  const inWindow = raw.filter(row => row.time >= FROM && row.time < TO), validated = Archive.validateSeries(inWindow, {now: NOW});
  const csv = validated.rows.map(row => [row.time, row.open, row.high, row.low, row.close, row.volume].join(',')).join('\n');
  writeFileSync(join(OUT, `${name}.csv.gz`), gzipSync(csv + '\n'));
  const months = Archive.monthlyManifest(validated.rows, {asset: name, product, from: FROM, to: TO}), periods = Archive.missingPeriods(validated.rows, {from: FROM, to: TO});
  // Native Coinbase 1h / 1d candles (built by the venue from trades) are kept
  // separately, labelled by granularity, to measure whether 5m gaps are
  // no-trade intervals or true outages.  They are never mixed into 5m data.
  const native = {};
  for (const [label, seconds] of NATIVE) {
    const ms = seconds * 1000, rows = [];
    for (let start = FROM; start < TO; start += PAGE * ms) rows.push(...Archive.fromCoinbase(await page(product, start, Math.min(TO - ms, start + (PAGE - 1) * ms), seconds), {asset: name, product}));
    const checked = Archive.validateSeries(rows.filter(row => row.time >= FROM && row.time < TO), {now: NOW, interval: ms});
    writeFileSync(join(OUT, `${name}-${label}.csv.gz`), gzipSync(checked.rows.map(row => [row.time, row.open, row.high, row.low, row.close, row.volume].join(',')).join('\n') + '\n'));
    native[label] = {granularity_seconds: seconds, present: checked.rows.length, expected: (TO - FROM) / ms, gaps: checked.gaps.length, issues: checked.issues};
  }
  const expected = (TO - FROM) / BASE;
  return {asset: name, product, venue: 'COINBASE', instrument_type: 'SPOT', quote: 'USD', from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), expected, present: validated.rows.length, missing: expected - validated.rows.length, coverage: validated.rows.length / expected, first: validated.rows[0] ? new Date(validated.rows[0].time).toISOString() : null, last: validated.rows.at(-1) ? new Date(validated.rows.at(-1).time).toISOString() : null, issues: validated.issues, internalGaps: validated.gaps.length, gapLengthHistogram: histogram(validated.gaps.map(gap => gap.missing)), missingPeriodsOver1h: periods, content_sha256: Archive.sha256(csv), native, months};
}
function histogram(values) { const buckets = {'1': 0, '2-3': 0, '4-11': 0, '12-287': 0, '288+': 0}; for (const v of values) buckets[v === 1 ? '1' : v <= 3 ? '2-3' : v <= 11 ? '4-11' : v <= 287 ? '12-287' : '288+']++; return buckets; }

mkdirSync(OUT, {recursive: true});
const results = [];
for (const name of ASSETS) { const started = Date.now(); results.push(await asset(name)); console.log(JSON.stringify({progress: 'asset-complete', asset: name, seconds: (Date.now() - started) / 1000, requests, retries})); }
const manifest = {archive_version: Archive.ARCHIVE_VERSION, generated_at: new Date(NOW).toISOString(), window: {from: new Date(FROM).toISOString(), to: new Date(TO).toISOString()}, policy: 'Coinbase Exchange spot USD 5m only; no fill, no forward-fill, no venue substitution; gaps recorded, consumers fail closed', requests, retries, assets: results};
writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 1) + '\n');
console.log(JSON.stringify({status: 'CANDLE_ARCHIVE_COMPLETE', window: manifest.window, requests, retries, coverage: results.map(r => ({asset: r.asset, present: r.present, expected: r.expected, coverage: Math.round(r.coverage * 1e5) / 1e5, internalGaps: r.internalGaps, gapHistogram: r.gapLengthHistogram, issues: r.issues, first: r.first, last: r.last, periodsOver1h: r.missingPeriodsOver1h.length, longestPeriods: r.missingPeriodsOver1h.slice().sort((x, y) => y.missing_candles - x.missing_candles).slice(0, 8), native: r.native}))}));
