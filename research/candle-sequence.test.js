'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const Sequence=require('./candle-sequence.js');
const start=1_700_000_000_000,rows=(interval,count=300)=>Array.from({length:count},(_,index)=>{const close=100+index*.1;return{time:start+index*interval,open:close-.03,high:close+.08,low:close-.09,close,volume:100+index%11};});
test('sequence windows are normalized and end on completed candles only',()=>{
  const signal=start+300*300000,sequence=Sequence.build({m5:rows(300000,300),m15:rows(900000,100),h1:rows(3600000,25)},signal);
  assert.equal(sequence.timeframes.m5.rows.length,256);
  assert.equal(sequence.timeframes.m5.window_end,signal);
  assert.ok(Number.isFinite(sequence.timeframes.m5.rows.at(-1).close_to_close));
  assert.equal(Sequence.assertNoFuture(sequence,signal),true);
});
test('sequence construction rejects an incomplete candle',()=>{
  const signal=start+300*300000,source=rows(300000);source.at(-1).time=signal;
  assert.throws(()=>Sequence.build({m5:source,m15:rows(900000),h1:rows(3600000)},signal),/LOOKAHEAD_REJECTED/);
});
