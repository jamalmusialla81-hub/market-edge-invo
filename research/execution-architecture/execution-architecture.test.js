'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {AlphaSignal, RiskDecision, ExecutionIntent} = require('./domain-objects.js');
const {ExecutionRouter, BACKENDS} = require('./execution-router.js');
const {PaperBackend} = require('./paper-backend.js');
const {reconcile} = require('./reconciliation.js');

function intent(overrides = {}) {
  return ExecutionIntent({
    signal_id: 's1', instrument: 'BTC-PERP', side: 'buy', quantity: 1, order_type: 'MARKET',
    limit_price: 60000, leverage: 2, strategy_id: 'market-edge-alpha', ...overrides
  });
}
function approve(overrides = {}) {
  return RiskDecision({signal_id: 's1', approved: true, approved_leverage: 5, ...overrides});
}

test('AlphaSignal rejects a signal missing required fields', () => {
  assert.throws(() => AlphaSignal({asset: 'BTC'}), /ALPHA_SIGNAL_INVALID/);
});

test('one signal produces exactly one order: a second route call for the same signal_id is rejected', async () => {
  const nautilus = PaperBackend('NAUTILUS_NATIVE');
  const router = ExecutionRouter({riskGate: async () => approve(), backends: {[BACKENDS.NAUTILUS_NATIVE]: nautilus}});
  const first = await router.route(intent());
  assert.equal(first.fill.status, 'FILLED');
  await assert.rejects(() => router.route(intent()), /EXECUTION_ROUTER_DUPLICATE_SIGNAL/);
  assert.equal(router.submittedCount(), 1);
});

test('risk limits cannot be bypassed: an unapproved intent is never submitted to a backend', async () => {
  const nautilus = PaperBackend('NAUTILUS_NATIVE');
  const router = ExecutionRouter({riskGate: async () => approve({approved: false, reason: 'MAX_PORTFOLIO_EXPOSURE'}), backends: {[BACKENDS.NAUTILUS_NATIVE]: nautilus}});
  await assert.rejects(() => router.route(intent()), /EXECUTION_ROUTER_RISK_REJECTED/);
  assert.equal(nautilus.fills().length, 0);
});

test('risk limits cannot be bypassed: requested leverage above the approved ceiling is rejected before routing', async () => {
  const nautilus = PaperBackend('NAUTILUS_NATIVE');
  const router = ExecutionRouter({riskGate: async () => approve({approved_leverage: 1}), backends: {[BACKENDS.NAUTILUS_NATIVE]: nautilus}});
  await assert.rejects(() => router.route(intent({leverage: 5})), /EXECUTION_ROUTER_LEVERAGE_EXCEEDS_APPROVAL/);
  assert.equal(nautilus.fills().length, 0);
});

test('venue_preference routes an intent to the Hummingbot backend instead of the Nautilus-native default', async () => {
  const nautilus = PaperBackend('NAUTILUS_NATIVE'), hummingbot = PaperBackend('HUMMINGBOT');
  const router = ExecutionRouter({riskGate: async () => approve(), backends: {[BACKENDS.NAUTILUS_NATIVE]: nautilus, [BACKENDS.HUMMINGBOT]: hummingbot}});
  const result = await router.route(intent({venue_preference: BACKENDS.HUMMINGBOT}));
  assert.equal(result.backend, BACKENDS.HUMMINGBOT);
  assert.equal(hummingbot.fills().length, 1);
  assert.equal(nautilus.fills().length, 0);
});

test('reconciliation detects an orphan order (backend has a position canonical state does not)', () => {
  const result = reconcile([], [{instrument: 'ETH-PERP', quantity: 2}]);
  assert.equal(result.reconciled, false);
  assert.deepEqual(result.orphanOrders, ['ETH-PERP']);
});

test('reconciliation detects an unknown/missing position and a quantity mismatch', () => {
  const canonical = [{instrument: 'BTC-PERP', quantity: 1}, {instrument: 'ETH-PERP', quantity: 3}];
  const backend = [{instrument: 'BTC-PERP', quantity: 0.5}];
  const result = reconcile(canonical, backend);
  assert.equal(result.reconciled, false);
  assert.deepEqual(result.unknownPositions, ['ETH-PERP']);
  assert.deepEqual(result.mismatched, [{instrument: 'BTC-PERP', canonicalQuantity: 1, backendQuantity: 0.5}]);
});

test('reconciliation passes when canonical and backend positions agree exactly', () => {
  const positions = [{instrument: 'BTC-PERP', quantity: 1}];
  assert.equal(reconcile(positions, positions).reconciled, true);
});

test('a partial fill still reconciles once the backend position reflects it', async () => {
  const nautilus = PaperBackend('NAUTILUS_NATIVE');
  const router = ExecutionRouter({riskGate: async () => approve(), backends: {[BACKENDS.NAUTILUS_NATIVE]: nautilus}});
  await router.route(intent({quantity: 0.5}));
  const result = reconcile([{instrument: 'BTC-PERP', quantity: 0.5}], nautilus.openPositions());
  assert.equal(result.reconciled, true);
});
