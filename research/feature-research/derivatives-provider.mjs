// Point-in-time derivatives context provider (feature research only).
//
// Provider order (PREREGISTRATION.md §8):
//   1. Tardis.dev   — only when TARDIS_API_KEY is configured.  No Tardis client
//                     is implemented in v1, so a configured key is reported,
//                     not silently used or faked.
//   2. Binance USD-M official public archives (data.binance.vision):
//      fundingRate (monthly), metrics (daily, 5-minute open interest),
//      premiumIndexKlines (1h, monthly).
// Liquidations: Binance publishes no point-in-time liquidation history for
// this window, so those features are UNAVAILABLE rather than approximated.
// Every missing file is recorded; nothing is filled or substituted.
import {archiveCsv} from '../recover-historical-rank-outcomes.mjs';

const ROOT = 'https://data.binance.vision/data/futures/um';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const msTime = value => { const t = Number(value); return t > 1e14 ? Math.floor(t / 1000) : t; };
const monthsBetween = (from, to) => { const out = []; for (let d = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1)); d.getTime() <= to; d.setUTCMonth(d.getUTCMonth() + 1)) out.push(d.toISOString().slice(0, 7)); return out; };

async function pool(items, limit, worker) { const out = Array(items.length); let next = 0; await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => { while (next < items.length) { const i = next++; out[i] = await worker(items[i]); } })); return out; }
async function fetchZip(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const response = await fetch(url); if (response.status === 404) return null; if (!response.ok) throw new Error(`HTTP ${response.status}`); return archiveCsv(await response.arrayBuffer()); }
    catch (error) { if (attempt === 2) throw new Error(`${url}: ${error.message}`); await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
  }
}

export function tardisStatus() {
  return process.env.TARDIS_API_KEY ? 'CONFIGURED_BUT_NO_CLIENT_IN_V1: Binance official archives used instead (declared, not silent)' : 'SKIPPED_NOT_CONFIGURED';
}

// scanTimes: development scan timestamps that need context for this asset.
export async function loadBinanceDerivatives(asset, scanTimes, {concurrency = 12} = {}) {
  const symbol = `${asset}USDT`, first = Math.min(...scanTimes), last = Math.max(...scanTimes), status = {symbol, venue: 'BINANCE_USDM', instrument_type: 'PERPETUAL', retrievedAt: new Date().toISOString()};
  // Funding: known at each settlement; 35 days of lead-in for the 30d z-score.
  const fundingMonths = monthsBetween(first - 35 * DAY, last), fundingFiles = await pool(fundingMonths, concurrency, month => fetchZip(`${ROOT}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`));
  const funding = fundingFiles.flat().filter(Boolean).map(row => ({time: msTime(row[0]), rate: Number(row[2])})).filter(r => Number.isFinite(r.time) && Number.isFinite(r.rate)).sort((a, b) => a.time - b.time);
  status.funding = {points: funding.length, missingMonths: fundingMonths.filter((m, i) => !fundingFiles[i]), first: funding[0] ? new Date(funding[0].time).toISOString() : null};
  // Premium index 1h: a bar is known once closed (open_time + 1h).
  const premiumMonths = monthsBetween(first - 2 * DAY, last), premiumFiles = await pool(premiumMonths, concurrency, month => fetchZip(`${ROOT}/monthly/premiumIndexKlines/${symbol}/1h/${symbol}-1h-${month}.zip`));
  const premium = premiumFiles.flat().filter(Boolean).map(row => ({closeTime: msTime(row[0]) + HOUR, close: Number(row[4])})).filter(r => Number.isFinite(r.closeTime) && Number.isFinite(r.close)).sort((a, b) => a.closeTime - b.closeTime);
  status.premium = {points: premium.length, missingMonths: premiumMonths.filter((m, i) => !premiumFiles[i]), first: premium[0] ? new Date(premium[0].closeTime).toISOString() : null};
  // Metrics (5m OI): only the UTC days covering [T - 5h, T] for each scan.
  const days = [...new Set(scanTimes.flatMap(t => [t - 5 * HOUR, t].map(x => new Date(x).toISOString().slice(0, 10))))].sort();
  const metricFiles = await pool(days, concurrency, day => fetchZip(`${ROOT}/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`));
  const oi = metricFiles.flat().filter(Boolean).map(row => ({time: Date.parse(`${String(row[0]).replace(' ', 'T')}Z`), oi: Number(row[2])})).filter(r => Number.isFinite(r.time) && r.oi > 0).sort((a, b) => a.time - b.time);
  status.oi = {points: oi.length, daysRequested: days.length, missingDays: days.filter((d, i) => !metricFiles[i]).length, first: oi[0] ? new Date(oi[0].time).toISOString() : null};
  return {series: {funding, premium, oi}, status};
}

// Probe whether any point-in-time liquidation history exists on the archive
// for the development window.  Reported, never used to fabricate features.
export async function probeLiquidations(asset, sampleDay) {
  const symbol = `${asset}USDT`, url = `${ROOT}/daily/liquidationSnapshot/${symbol}/${symbol}-liquidationSnapshot-${sampleDay}.zip`;
  try { const rows = await fetchZip(url); return rows ? {status: 'FOUND_SAMPLE', url, rows: rows.length} : {status: 'UNAVAILABLE_NO_POINT_IN_TIME_SOURCE', url}; }
  catch (error) { return {status: `UNAVAILABLE: ${error.message}`, url}; }
}

// Legacy context used only to reproduce the prior phase's REFERENCE feature
// set exactly (Binance USD-M 1h closes + funding), same parsing as before.
export async function legacyContext(assets, from, to) {
  const context = {crossMarket: {}, funding: {}}, status = {crossMarket: {}, funding: {}};
  for (const asset of assets) {
    const symbol = `${asset}USDT`;
    const klineMonths = monthsBetween(from - 5 * DAY, to), klines = await pool(klineMonths, 12, month => fetchZip(`${ROOT}/monthly/klines/${symbol}/1h/${symbol}-1h-${month}.zip`));
    context.crossMarket[asset] = klines.flat().filter(Boolean).map(row => ({closeTime: msTime(row[0]) + HOUR, close: Number(row[4])})).filter(r => Number.isFinite(r.closeTime) && r.close > 0).sort((a, b) => a.closeTime - b.closeTime);
    status.crossMarket[asset] = {points: context.crossMarket[asset].length, missingMonths: klineMonths.filter((m, i) => !klines[i])};
    const fundingMonths = monthsBetween(from - 35 * DAY, to), files = await pool(fundingMonths, 12, month => fetchZip(`${ROOT}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`));
    context.funding[asset] = files.flat().filter(Boolean).map(row => ({time: msTime(row[0]), rate: Number(row[2])})).filter(r => Number.isFinite(r.time) && Number.isFinite(r.rate)).sort((a, b) => a.time - b.time);
    status.funding[asset] = {points: context.funding[asset].length, missingMonths: fundingMonths.filter((m, i) => !files[i])};
  }
  return {context, status};
}
