import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const R = require('./dataset-registry.js');
const manifest = {
  manifest_schema: 'forward-snapshot/v1', version: 'FORWARD-SHADOW-RESOLVED-V1-SNAPSHOT-20261001', content_hash: 'a'.repeat(64), counts: {rows: 10},
  registry_entry: {status: 'SNAPSHOT_PUBLISHED', trainable: true, developmentOnly: false, derivedFrom: 'FORWARD-SHADOW-RESOLVED-V1', reason: 'frozen', evidence: 'manifest.json'},
};
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
t('a snapshot manifest adds a NEW registry entry and leaves every existing one untouched', () => {
  const before = JSON.stringify(R.DATASETS);
  const next = R.withSnapshot(R.DATASETS, manifest);
  assert.equal(JSON.stringify(R.DATASETS), before);
  assert.equal(next[manifest.version].contentHash, 'a'.repeat(64));
  assert.equal(next['FORWARD-SHADOW-RESOLVED-V1'].trainable, false, 'the live collection stays untrainable');
  assert.doesNotThrow(() => R.assertTrainable.call(null, 'HISTORICAL-RANK-V2-CLEAN'));
});
t('a version name is never reused', () => {
  const next = R.withSnapshot(R.DATASETS, manifest);
  assert.throws(() => R.withSnapshot(next, manifest), /DATASET_VERSION_EXISTS/);
});
t('malformed manifests are refused', () => {
  assert.throws(() => R.withSnapshot(R.DATASETS, {...manifest, version: 'HISTORICAL-RANK-V1'}), /SNAPSHOT_MANIFEST_INVALID/);
  assert.throws(() => R.withSnapshot(R.DATASETS, {...manifest, content_hash: 'x'}), /MISSING_CONTENT_HASH/);
  assert.throws(() => R.withSnapshot(R.DATASETS, {...manifest, registry_entry: undefined}), /SNAPSHOT_MANIFEST_INVALID/);
});
console.log(`${n} snapshot registry tests passed`);
