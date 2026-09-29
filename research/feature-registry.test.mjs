// DATA 4: the feature registry must match what the code really produces, and must never
// disagree with the hindsight guard (in either direction).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crossMarket, derivatives, frameFeatures, marketFeatures } from '../signal-bridge/shadow_capture.mjs';

const require = createRequire(import.meta.url);
const R = require('./feature-registry.js');
const G = require('./shadow-leakage-guard.js');
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const flatten = (obj, prefix = '') => Object.entries(obj || {}).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

// keys of the object literal that scan-core.mjs features() returns, read from the source itself
function legacyKeys() {
  const src = readFileSync(root('backend/scan-core.mjs'), 'utf8');
  const start = src.indexOf('function features(candidate)');
  assert.ok(start >= 0, 'features() not found in scan-core.mjs');
  const ret = src.indexOf('return{', start);
  let depth = 0, i = ret + 'return'.length, top = '';
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    if (ch === '}' || ch === ')' || ch === ']') { depth -= 1; if (depth === 0) break; }
    if (depth === 1) top += ch;
  }
  return top.replace(/^\{/, '').split(',').map((part) => part.trim().match(/^([A-Za-z0-9_]+):/)?.[1]).filter(Boolean);
}

const candles = (n) => Array.from({ length: n }, (_, i) => ({ time: i * 3.6e6, open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100.5 + i * 0.1, volume: 10 + (i % 5) }));

test('registry names are unique and every entry is complete', () => {
  const paths = R.FEATURES.map((f) => f.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const f of R.FEATURES) {
    for (const k of ['name', 'path', 'version', 'group', 'calc', 'source_fields', 'point_in_time', 'timeframe', 'lookback', 'missing', 'classification', 'range', 'provenance', 'allowed_use', 'calc_note']) {
      assert.ok(f[k] !== undefined && f[k] !== '', `${f.path} is missing ${k}`);
    }
    assert.ok(f.calc.file && f.calc.function, `${f.path} has no calculation reference`);
    assert.ok(Array.isArray(f.range) && f.range.length === 2 && f.range[0] < f.range[1], `${f.path} range`);
    assert.equal(f.classification, 'DECISION_TIME');
    assert.equal(f.point_in_time, true);
    assert.ok(['ZERO_FILLED', 'FRAME_OMITTED', 'NULL', 'OBJECT_NULL'].includes(f.missing), `${f.path} missing behaviour`);
  }
});

test('the registry cannot change without a FEATURE_SET_VERSION bump (pinned content hash)', () => {
  assert.equal(R.FEATURE_SET_VERSION, 'FEATURE-SET-V1');
  assert.equal(R.registryHash(), 'fce956921f87d83b5d671ed71449b1baa5a6828175d341221548d4b99535bb91',
    'registry content changed: bump FEATURE_SET_VERSION in research/feature-registry.js and update this pinned hash');
});

test('every registered decision-time feature is NOT hindsight according to the guard (path and leaf)', () => {
  for (const f of R.FEATURES) {
    assert.equal(G.isHindsightName(f.path), false, `${f.path} is registered as decision-time but the guard flags it`);
    assert.equal(G.isHindsightName(f.name), false, `${f.name}`);
  }
  assert.doesNotThrow(() => G.assertDecisionFeatures(R.FEATURES.map((f) => f.path)));
});

test('every listed hindsight or outcome field is flagged by the guard and is not a registered feature', () => {
  const registered = new Set(R.FEATURES.flatMap((f) => [f.name, f.path, f.path.split('.').pop()]));
  for (const name of [...R.HINDSIGHT_FIELDS, ...R.OUTCOME_EVENT_FIELDS]) {
    assert.equal(G.isHindsightName(name), true, `${name} should be flagged by the guard`);
    assert.equal(registered.has(name), false, `${name} must not be a registered feature`);
  }
  assert.throws(() => G.assertDecisionFeatures(['features.h1.rsi', 'mfe']), /HINDSIGHT_FIELD_AS_FEATURE/);
});

test('the legacy ML vector in the registry is exactly what scan-core features() returns', () => {
  const produced = legacyKeys();
  assert.equal(produced.length, 17, 'features() should return 17 keys');
  const registered = R.FEATURES.filter((f) => f.path.startsWith('legacy.')).map((f) => f.name);
  assert.deepEqual([...registered].sort(), [...produced].sort());
});

test('shadow frame, derivatives and cross-market features are exactly what shadow_capture produces', () => {
  const frame = frameFeatures(candles(60));
  const frameNames = new Set(Object.keys(frame));
  const registeredFrame = R.FEATURES.filter((f) => f.group === 'shadow_frame');
  for (const [key] of [['m5'], ['m15'], ['h1'], ['h4'], ['d1']]) {
    const mine = registeredFrame.filter((f) => f.path.startsWith(`features.${key}.`)).map((f) => f.path.split('.').pop());
    assert.deepEqual(new Set(mine), frameNames, `${key} frame features drifted from frameFeatures()`);
  }
  const all = marketFeatures({ m5: candles(60), m15: candles(60), h1: candles(60), h4: candles(60), d1: candles(60) });
  assert.deepEqual(Object.keys(all).sort(), ['d1', 'h1', 'h4', 'm15', 'm5']);
  assert.equal(frameFeatures(candles(29)), null, 'fewer than 30 candles omits the frame (FRAME_OMITTED)');

  const ctx = { funding: 0.0001, openInterest: 5, premium: 0.001, dayNtlVlm: 9, markPx: 100, oraclePx: 100, prevDayPx: 99 };
  assert.deepEqual(new Set(Object.keys(derivatives(ctx))), new Set(R.FEATURES.filter((f) => f.group === 'shadow_derivatives').map((f) => f.name)));
  assert.equal(derivatives(null), null, 'no venue context is OBJECT_NULL');

  const cm = crossMarket({ BTC: all, ETH: all });
  assert.deepEqual(new Set(flatten(cm)), new Set(R.FEATURES.filter((f) => f.group === 'shadow_cross_market').map((f) => f.path.replace('cross_market.', ''))));
});

test('the registry documents the shadow feature_version it covers', () => {
  const src = readFileSync(root('signal-bridge/shadow_capture.mjs'), 'utf8');
  assert.match(src, new RegExp(`FEATURE_VERSION = '${R.SHADOW_FEATURE_VERSION}'`));
});

test('featureSet() only accepts registered features', () => {
  assert.equal(R.featureSet(['features.h1.rsi', 'legacy.h4Rsi']).features.length, 2);
  assert.throws(() => R.featureSet(['features.h1.magic']), /UNREGISTERED_FEATURES/);
});

test('the JS guard and the Python guard flag the same hindsight vocabulary', () => {
  const py = readFileSync(root('execution-service/market_edge_exec/shadow/contracts.py'), 'utf8');
  const block = py.slice(py.indexOf('HINDSIGHT_PATTERN = re.compile('), py.indexOf('re.IGNORECASE)'));
  const words = (s) => new Set(s.split('|').map((w) => w.trim()).filter(Boolean));
  const pyWords = words([...block.matchAll(/r"([^"]*)"/g)].map((m) => m[1]).join('').replace(/^\(/, '').replace(/\)$/, '').replace(/\)\|\(/g, '|'));
  const jsWords = words(G.HINDSIGHT_PATTERN.source.replace(/^\(/, '').replace(/\)$/, ''));
  const norm = (set) => new Set([...set].map((w) => w.replace(/^\^|\$$/g, '')));
  assert.deepEqual(norm(pyWords), norm(jsWords));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok - ${name}`); } catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
}
if (failed) process.exit(1);
console.log(`feature-registry: ${tests.length - failed}/${tests.length} passed`);
