import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanCoordinator } from './scanCoordinator.js';

test('aborts a prior scan and allows only the latest response to become authoritative', () => {
  const coordinator = createScanCoordinator();
  const first = coordinator.begin();
  const second = coordinator.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);
  coordinator.complete(first);
  assert.equal(coordinator.isCurrent(second), true);
  coordinator.complete(second);
  assert.equal(coordinator.isCurrent(second), false);
});
