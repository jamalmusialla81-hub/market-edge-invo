#!/usr/bin/env node
// Verifies that extending the archive changed only coverage: every asset-month
// present in both the previous and the new manifest must hash identically.
import {readFileSync} from 'node:fs';
const [previousPath, currentPath] = process.argv.slice(2), previous = JSON.parse(readFileSync(previousPath, 'utf8')), current = JSON.parse(readFileSync(currentPath, 'utf8'));
const index = manifest => new Map(manifest.assets.flatMap(asset => asset.months.map(month => [`${asset.asset}|${month.month}`, month])));
const a = index(previous), b = index(current), lastPrevMonth = previous.window.to.slice(0, 7), mismatches = [];
let compared = 0;
for (const [key, month] of a) { if (!b.has(key) || month.month === lastPrevMonth) continue; compared++; const other = b.get(key); if (other.sha256 !== month.sha256 || other.present !== month.present) mismatches.push({key, previous: month.sha256.slice(0, 12), current: other.sha256.slice(0, 12), presentPrev: month.present, presentNow: other.present}); }
console.log(JSON.stringify({status: mismatches.length ? 'OVERLAP_MISMATCH' : 'OVERLAP_IDENTICAL', compared, mismatches}));
if (mismatches.length) process.exit(1);
