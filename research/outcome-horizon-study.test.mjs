import test from 'node:test';
import assert from 'node:assert/strict';
import {horizonSummary,lowerBound,monthsBetween} from './outcome-horizon-study.mjs';

test('horizon study counts only complete windows and separates natural exits from timeouts',()=>{
  const results=[{byHorizon:{24:{status:'RESOLVED',STOP_HIT:true,TP2_HIT:false,TP1_BEFORE_SL:false,FINAL_R:-1}}},{byHorizon:{24:{status:'RESOLVED',STOP_HIT:false,TP2_HIT:false,TP1_BEFORE_SL:false,FINAL_R:.1}}},{byHorizon:{24:{status:'UNRESOLVED_DATA_GAP'}}}];
  const summary=horizonSummary(results,24);
  assert.equal(summary.evaluable,2);
  assert.equal(summary.insufficient_future_data,1);
  assert.equal(summary.natural_exit_rate,.5);
  assert.equal(summary.timeout_rate,.5);
});
test('horizon study helpers find the first candle at or after the signal and span months',()=>{
  assert.equal(lowerBound([{time:1},{time:5},{time:9}],5),1);
  assert.equal(lowerBound([{time:1},{time:5}],6),2);
  assert.deepEqual(monthsBetween(Date.UTC(2026,0,31),Date.UTC(2026,2,2)),['2026-01','2026-02','2026-03']);
});
