import assert from 'node:assert/strict';
import {plan} from './phase5-rank-plan.mjs';

assert.deepEqual(plan({scans:0,resolved:0}).include[0],{start_index:0,scan_count:4});
assert.equal(plan({scans:16,resolved:120}).start,12);
assert.equal(plan({scans:16,resolved:120}).include.length,5);
assert.equal(plan({scans:300,resolved:501}).target,'CONTINUE_TO_1000');
assert.deepEqual(plan({scans:600,resolved:1000}).include,[]);
console.log('Phase 5 rank plan tests passed');
