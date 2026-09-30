const assert = require('assert');
const E = require('./evidence-sufficiency.js');
const DAY = 86400000, T0 = 1_800_000_000_000;

function rows(n, { episodes, clusters, assets, strategies, days, directions = ['long'], regimes = ['trend'] }) {
  return Array.from({ length: n }, (_, i) => ({
    scanId: `s${i}`, episodeId: `e${i % episodes}`, clusterId: `c${i % clusters}`, asset: `A${i % assets}`, strategy: `S${i % strategies}`,
    direction: directions[i % directions.length], regime: regimes[i % regimes.length], resolved: true, decisionTs: T0 + Math.floor(i * days * DAY / Math.max(1, n - 1))
  }));
}

// a large raw count from one correlated episode is not decision-useful
const burst = E.evidenceSufficiency(rows(500, { episodes: 1, clusters: 1, assets: 1, strategies: 1, days: 1 }));
assert.strictEqual(burst.counts.resolved, 500);
assert.strictEqual(burst.counts.episodes, 1);
assert.notStrictEqual(burst.status, 'DECISION_USEFUL');
assert.strictEqual(burst.status, 'INSUFFICIENT');
assert.ok(burst.warnings.some(w => /only 1 independent episodes/.test(w)));
assert.ok(burst.shortfalls.length > 0);

// a smaller but diverse sample can be
const diverse = E.evidenceSufficiency(rows(100, { episodes: 40, clusters: 35, assets: 6, strategies: 3, days: 20, directions: ['long', 'short'], regimes: ['trend', 'range'] }));
assert.strictEqual(diverse.status, 'DECISION_USEFUL');
assert.ok(diverse.counts.resolved < burst.counts.resolved);
assert.strictEqual(diverse.counts.directions, 2);
assert.strictEqual(diverse.nextTier, null);

// elapsed time alone never lifts a tier
const slow = E.evidenceSufficiency(rows(4, { episodes: 1, clusters: 1, assets: 1, strategies: 1, days: 365 }));
assert.ok(slow.counts.days >= 364);
assert.strictEqual(slow.status, 'INSUFFICIENT');

// each dimension is a hard floor: one missing asset/strategy/day keeps the tier below
const base = { episodes: 40, clusters: 35, assets: 6, strategies: 3, days: 20 };
for (const [k, override] of [['assets', { assets: 1 }], ['strategies', { strategies: 1 }], ['days', { days: 3 }], ['clusters', { clusters: 5 }], ['episodes', { episodes: 5 }]]) {
  const s = E.evidenceSufficiency(rows(100, Object.assign({}, base, override)));
  assert.notStrictEqual(s.status, 'DECISION_USEFUL', k);
  assert.ok(s.shortfalls.some(x => x.dimension === k || s.status !== 'DECISION_USEFUL'), k);
}
assert.strictEqual(E.evidenceSufficiency(rows(100, Object.assign({}, base, { assets: 1 }))).shortfalls[0].dimension, 'assets');

// tier ladder
assert.strictEqual(E.evidenceSufficiency(rows(12, { episodes: 4, clusters: 4, assets: 2, strategies: 1, days: 3 })).status, 'EARLY');
assert.strictEqual(E.evidenceSufficiency(rows(35, { episodes: 10, clusters: 10, assets: 2, strategies: 1, days: 6 })).status, 'DIRECTIONAL');
assert.deepStrictEqual(E.tierFloors(1), E.FLOORS);

// missing linkage is never invented: rows without ids add no episodes or clusters
const unlinked = rows(200, { episodes: 1, clusters: 1, assets: 6, strategies: 3, days: 30 }).map(r => ({ asset: r.asset, strategy: r.strategy, resolved: true, decisionTs: r.decisionTs }));
const u = E.evidenceSufficiency(unlinked);
assert.strictEqual(u.counts.episodes, 0);
assert.strictEqual(u.unlinked.episode, 200);
assert.strictEqual(u.status, 'INSUFFICIENT');

// unresolved observations do not count as outcomes; snake_case rows and empty input are handled
const mixed = rows(30, { episodes: 10, clusters: 10, assets: 2, strategies: 1, days: 6 });
mixed.forEach((r, i) => { if (i % 2) r.resolved = false; });
assert.strictEqual(E.evidenceSufficiency(mixed).counts.resolved, 15);
assert.strictEqual(E.evidenceSufficiency(mixed).counts.observations, 30);
const snake = E.evidenceSufficiency([{ scan_id: 's', episode_id: 'e', cluster_id: 'c', asset: 'BTC', strategy: 'X', decision_ts: T0, resolution_status: 'x', resolved: true }]);
assert.strictEqual(snake.counts.episodes, 1);
assert.strictEqual(E.evidenceSufficiency(undefined).status, 'INSUFFICIENT');
assert.strictEqual(E.evidenceSufficiency([]).legacyTier, 'tiny');

// the legacy raw-count tier is untouched and still available beside the new engine
const Quant = require('./quant-engine.js');
assert.strictEqual(Quant.performanceStats(Array.from({ length: 120 }, () => ({ r: 1 }))).sampleTier, 'decision-useful');
console.log('evidence-sufficiency tests passed');
