#!/usr/bin/env node
// Fails closed unless every archived asset-month hashes exactly to the
// manifest committed in git.  This ties generation to audited provenance.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import Archive from './candle-archive.js';

const DIR = process.env.CANDLE_ARCHIVE_DIR || 'candle-archive', MANIFEST = process.env.CANDLE_MANIFEST || 'research/data/v2-clean/candle-manifest.json';
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')), from = Date.parse(manifest.window.from), to = Date.parse(manifest.window.to), mismatches = [];
for (const entry of manifest.assets) {
  const rows = gunzipSync(readFileSync(join(DIR, `${entry.asset}.csv.gz`))).toString().trim().split('\n').filter(Boolean).map(line => { const [time, open, high, low, close, volume] = line.split(',').map(Number); return {time, open, high, low, close, volume}; });
  const months = Archive.monthlyManifest(rows, {asset: entry.asset, product: entry.product, from, to});
  for (const month of entry.months) { const got = months.find(item => item.month === month.month); if (!got || got.sha256 !== month.sha256 || got.present !== month.present) mismatches.push({asset: entry.asset, month: month.month, expected: month.sha256.slice(0, 12), got: got?.sha256?.slice(0, 12) || null}); }
}
if (mismatches.length) { console.error(JSON.stringify({status: 'ARCHIVE_MANIFEST_MISMATCH', mismatches: mismatches.slice(0, 20)})); process.exit(1); }
console.log(JSON.stringify({status: 'ARCHIVE_MATCHES_COMMITTED_MANIFEST', assets: manifest.assets.length, months: manifest.assets.reduce((n, a) => n + a.months.length, 0), window: manifest.window}));
