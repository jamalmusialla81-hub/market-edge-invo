'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Control=require('./outcome-recovery-control.js');

test('a resolved recovery outcome lets the batch continue and is training eligible',()=>{
  assert.deepEqual(Control.summarise([{status:'RESOLVED'}]),{batch_continue:true,resolved:1,terminal_unresolved:0,training_eligible:1});
});
test('a legitimate data gap stays terminal, preserved, and does not stop the batch',()=>{
  const result=Control.summarise([{status:'UNRESOLVED_DATA_GAP',reason:'BINANCE_PROXY_INCOMPLETE_WINDOW'}]);
  assert.equal(result.batch_continue,true);assert.equal(result.resolved,0);assert.equal(result.terminal_unresolved,1);assert.equal(result.training_eligible,0);
});
test('insufficient future history is terminal and does not become training data',()=>{
  const result=Control.summarise([{status:'UNRESOLVED_INSUFFICIENT_FUTURE_DATA',reason:'BINANCE_PROXY_INCOMPLETE_WINDOW'}]);
  assert.equal(result.batch_continue,true);assert.equal(result.terminal_unresolved,1);assert.equal(result.training_eligible,0);
});
test('lookahead, frozen-input mutation, and malformed proxy OHLC fail closed',()=>{
  assert.throws(()=>Control.summarise([{status:'RESOLVED'}],{noLookahead:false}),/LOOKAHEAD_REJECTED/);
  assert.throws(()=>Control.summarise([{status:'RESOLVED'}],{frozenInputsImmutable:false}),/FROZEN_INPUT_MUTATION/);
  assert.throws(()=>Control.assertOutcomeIntegrity({status:'UNRESOLVED_DATA_GAP',reason:'BINANCE_PROXY_INVALID_OHLC'}),/MALFORMED_OUTCOME_OHLC/);
});
test('rerunning terminal scans deduplicates IDs without changing frozen records',()=>{
  const frozen={scan_id:'scan-a',pending_rankable:0,candidate_hash:'frozen-hash'};
  const ids=Control.completedScanIds([frozen,{...frozen},{scan_id:'scan-b',pending_rankable:1}]);
  assert.deepEqual([...ids],['scan-a']);assert.equal(frozen.candidate_hash,'frozen-hash');
});
