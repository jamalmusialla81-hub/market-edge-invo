'use strict';
const assert = require('node:assert/strict');
const F = require('./features.js');

function rng(seed) { let state = seed >>> 0; return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function walk(seed, start, count, price = 100) {
  const random = rng(seed), rows = [];
  for (let i = 0; i < count; i++) { const open = price, close = open * (1 + (random() - .5) * .006), high = Math.max(open, close) * (1 + random() * .002), low = Math.min(open, close) * (1 - random() * .002); rows.push({time: start + i * F.B, open, high, low, close, volume: 10 + random() * 20}); price = close; }
  return rows;
}
const T = Date.UTC(2024, 5, 20), START = T - 70 * F.DAY;
const pastCount = (T - START) / F.B;

// ---- future invariance: appending random future bars must change nothing --
function universeOf(extraSeed) {
  const u = {};
  F.ASSETS.forEach((asset, k) => {
    const past = walk(100 + k, START, pastCount, 50 + k * 10), future = extraSeed === null ? [] : walk(extraSeed + k, T, 2000, past.at(-1).close * (1 + (k % 2 ? .2 : -.2)));
    u[asset] = F.buildSeries([...past, ...future]);
  });
  return u;
}
function derivOf(extra) {
  const funding = [], oi = [], premium = [];
  for (let t = START; t < T + (extra ? 5 * F.DAY : 1); t += 8 * F.H1) funding.push({time: t, rate: (t > T ? .01 : 1e-4) * Math.sin(t / 1e8)});
  for (let t = START; t < T + (extra ? 5 * F.DAY : 1); t += F.B) oi.push({time: t, oi: 1e6 * (1 + (t > T ? .5 : .01) * Math.sin(t / 1e7))});
  for (let t = START; t < T + (extra ? 5 * F.DAY : 1); t += F.H1) premium.push({closeTime: t + F.H1, close: (t >= T ? .01 : 1e-4) * Math.cos(t / 1e7)});
  return {funding, oi, premium};
}
const deriv = extra => Object.fromEntries(F.ASSETS.map(a => [a, derivOf(extra)]));
for (const asset of F.ASSETS) for (const direction of ['long', 'short']) {
  const row = {asset, direction, timestamp: T};
  const clean = F.computeFamilies(row, universeOf(null), deriv(false)), noisy = F.computeFamilies(row, universeOf(7777), deriv(true));
  assert.deepEqual(noisy.families, clean.families, `future bars changed ${asset} ${direction} features`);
  for (const family of F.FR_FAMILIES) {
    const values = Object.values(clean.families[family]);
    assert.ok(values.length > 5, `${family} produced too few features`);
    assert.ok(values.filter(Number.isFinite).length >= values.length * .5, `${family} mostly null on complete synthetic data`);
    assert.ok(clean.provenance[family].normalization_version === F.VERSIONS[family]);
    assert.ok(clean.provenance[family].freshness_ms === null || clean.provenance[family].freshness_ms >= 0, `${family} source after scan`);
  }
}

// ---- a missing bar in the window fails closed (null), never filled --------
{
  const u = universeOf(null), m5 = u.BTC.m5.filter(r => r.time !== T - 7 * F.B);
  u.BTC = F.buildSeries(m5);
  const out = F.computeFamilies({asset: 'BTC', direction: 'long', timestamp: T}, u, null);
  assert.equal(out.families.FR_CANDLE.m15_body_atr, null, 'gapped 15m window must be null');
  assert.equal(out.families.FR_CROSS_MARKET.btc_volatility_1h, null, 'gapped 5m window must be null');
  assert.equal(out.provenance.FR_DERIVATIVES.status, 'DERIVATIVES_NOT_LOADED');
}
// ---- stale latest bar fails closed -------------------------------------------
{
  const u = universeOf(null);
  assert.equal(F.closedWindow(u.BTC.h1, F.H1, T + 30 * 60_000, 10), null, 'window not closing exactly at T is rejected');
  assert.ok(F.closedWindow(u.BTC.h1, F.H1, T, 10));
}
// ---- swing is known only k bars later; BOS only on a close ------------------
{
  const mk = (highs, closes) => highs.map((h, i) => ({time: i, open: closes[i], high: h, low: closes[i] - 1, close: closes[i], volume: 1}));
  // Peak at index 3; with k=2 it becomes known at index 5.
  const highs = [10, 11, 12, 20, 12, 11, 12, 19, 21, 22], closes = [9, 10, 11, 15, 11, 10, 11, 18, 19.5, 21];
  const early = F.structureEvents(mk(highs.slice(0, 5), closes.slice(0, 5)), 2);
  assert.equal(early.swings.filter(s => s.type === 'high').length, 0, 'swing must not be known before i+k closes');
  const later = F.structureEvents(mk(highs, closes), 2);
  assert.equal(later.swings.find(s => s.type === 'high').knownAt, 5);
  // Bar 8 wicks to 21 (> 20) but closes 19.5: no BOS.  Bar 9 closes 21: BOS.
  assert.deepEqual(later.events.map(e => [e.dir, e.index]), [[1, 9]]);
}
// ---- direction symmetry: long/short signed features flip ---------------------
{
  const u = universeOf(null), L = F.computeFamilies({asset: 'SOL', direction: 'long', timestamp: T}, u, null).families, S = F.computeFamilies({asset: 'SOL', direction: 'short', timestamp: T}, u, null).families;
  assert.equal(L.FR_CROSS_MARKET.btc_return_24h, -S.FR_CROSS_MARKET.btc_return_24h);
  assert.equal(L.FR_STRUCTURE.h1_trend_state, -S.FR_STRUCTURE.h1_trend_state);
  assert.equal(L.FR_CROSS_MARKET.rolling_corr_btc, S.FR_CROSS_MARKET.rolling_corr_btc);
}
console.log('feature-research features: all tests passed');
