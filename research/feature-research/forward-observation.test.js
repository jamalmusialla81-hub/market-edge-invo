'use strict';
const assert = require('node:assert/strict');
const O = require('./forward-observation.js');

const decision = O.recordDecision({observation_id: 'x1', model_version: 'quant-engine-shared', feature_version: 'objective-feature-v1+structure-v1', feature_values: {a: 1}, decision_timestamp: 1000, decision_price: 50, asset: 'BTC', direction: 'long'});
assert.equal(O.validate(decision).valid, true);
assert.throws(() => O.attachOutcome(decision, {path: [{time: 900}], outcome: 1, resolvedAt: 2000}), /PATH_STARTS_BEFORE_DECISION/);
assert.throws(() => O.attachOutcome(decision, {path: [{time: 1000}, {time: 3000}], outcome: 1, resolvedAt: 2000}), /OUTCOME_BEFORE_PATH_COMPLETE/);
const resolved = O.attachOutcome(decision, {path: [{time: 1000}, {time: 1300}], outcome: -1, resolvedAt: 1300});
assert.equal(resolved.actual_execution_cost, null);
assert.equal(O.validate(resolved).valid, true);
assert.throws(() => O.attachOutcome(resolved, {path: [{time: 1000}], outcome: 1, resolvedAt: 1000}), /OUTCOME_ALREADY_ATTACHED/);
assert.deepEqual(O.validate({...resolved, feature_values: {a: 2}}).errors, ['DECISION_MUTATED_AFTER_RECORDING']);
console.log('forward observation: all tests passed');
