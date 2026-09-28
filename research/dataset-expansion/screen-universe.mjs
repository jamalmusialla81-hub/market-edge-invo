#!/usr/bin/env node
// Dataset expansion v1, Phase 2: candidate-universe screen (PREREGISTRATION.md §2).
// Coinbase Exchange public API only: /products and NATIVE DAILY candles.
// Outcome-free.  Writes the screen report and the fetch shortlist (matrix).
import {writeFileSync, appendFileSync} from 'node:fs';
import Archive from '../candle-archive.js';
import X from './expansion.js';

const REPORT = process.env.EXPANSION_SCREEN_REPORT || 'screen-report.json', MATRIX = process.env.EXPANSION_MATRIX || 'matrix.json';
const RPS = Math.max(1, Number(process.env.COINBASE_RPS) || 4), DAY = 86_400_000, PAGE = 300;
let last = 0, requests = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function get(url) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = last + 1000 / RPS - Date.now(); last = Math.max(Date.now(), last + 1000 / RPS); if (wait > 0) await sleep(wait); requests++;
    let response; try { response = await fetch(url, {headers: {accept: 'application/json', 'user-agent': 'MarketEdgeResearch/2.0 (dataset expansion)'}}); } catch { await sleep(1000 * (attempt + 1)); continue; }
    if (response.ok) return response.json();
    if ([429, 500, 502, 503, 504].includes(response.status)) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  throw new Error(`failed after retries: ${url}`);
}
async function daily(product) {
  const rows = [];
  for (let start = X.WINDOW.fromMs; start < X.WINDOW.toMs; start += PAGE * DAY) {
    const end = Math.min(X.WINDOW.toMs - DAY, start + (PAGE - 1) * DAY);
    rows.push(...Archive.fromCoinbase(await get(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`), {asset: product, product}));
  }
  return Archive.validateSeries(rows.filter(row => row.time >= X.WINDOW.fromMs && row.time < X.WINDOW.toMs), {interval: DAY}).rows;
}

const products = await get('https://api.exchange.coinbase.com/products');
const usd = products.filter(p => p.quote_currency === 'USD').sort((a, b) => a.id.localeCompare(b.id));
const screened = [], skipped = [];
for (const product of usd) {
  const base = String(product.base_currency).toUpperCase();
  if (X.OLD_ASSETS.includes(base)) { skipped.push({product: product.id, reason: 'ALREADY_IN_UNIVERSE'}); continue; }
  // S1/S2 metadata failures need no candles.
  const s1 = product.status === 'online' && !product.trading_disabled && !product.cancel_only && !product.limit_only && !product.post_only && !product.auction_mode;
  const pegged = X.SCREEN.excludedBases.includes(base) || base.includes('USD') || product.fx_stablecoin;
  if (!s1 || pegged) { screened.push({symbol: base, product: product.id, pass: false, failed: [!s1 && 'S1_activeSpot', pegged && 'S2_notPeggedOrWrapped'].filter(Boolean), status: product.status}); continue; }
  try { screened.push({...X.screenProduct(product, await daily(product.id)), status: product.status}); }
  catch (error) { screened.push({symbol: base, product: product.id, pass: false, failed: ['FETCH_ERROR'], error: error.message}); }
  if (screened.length % 25 === 0) console.error(`screened ${screened.length}/${usd.length} (${requests} requests)`);
}
const list = X.shortlist(screened);
const report = {status: 'EXPANSION_SCREEN_COMPLETE', generatedAt: new Date().toISOString(), window: X.WINDOW, rules: X.SCREEN, usdProducts: usd.length, alreadyInUniverse: skipped, screened: screened.length, passed: screened.filter(s => s.pass).length, shortlist: list.map(s => ({symbol: s.symbol, product: s.product, medianDailyNotionalUsd: s.medianDailyNotionalUsd, firstValidDate: s.firstValidDate})), failureCounts: X.countBy(screened.flatMap(s => s.failed), f => f), requests, products: screened};
writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
writeFileSync(MATRIX, JSON.stringify(list.map(s => ({asset: s.symbol, product: s.product}))));
console.log(JSON.stringify({status: report.status, usdProducts: usd.length, screened: screened.length, passed: report.passed, shortlist: report.shortlist.map(s => s.symbol), failureCounts: report.failureCounts, requests}));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Universe screen\n\n${usd.length} USD products, ${report.passed} pass, shortlist: ${report.shortlist.map(s => s.symbol).join(', ')}\n`);
