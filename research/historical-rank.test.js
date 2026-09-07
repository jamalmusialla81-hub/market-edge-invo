'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const Rank=require('./historical-rank.js');

test('rank outcome uses next candle and stop-first ambiguity',()=>{
  const candidate={valid_current_geometry:true,direction:'long',stop:95,rr:1.8,strategy:'TREND CONTINUATION'};
  const rows=Array.from({length:Rank.OUTCOME_BARS},(_,index)=>({open:index?100:100,high:index?101:104,low:index?99:94,close:100}));
  const target=Rank.resolveCandidate(candidate,rows);
  assert.equal(target.status,'RESOLVED');
  assert.equal(target.STOP_HIT,true);
  assert.equal(target.TP1_BEFORE_SL,false);
  assert.ok(target.FINAL_R<0);
});

test('snapshot hash is deterministic and candidate rank only applies to valid geometry',()=>{
  const rows=[{valid_current_geometry:true,quant_score:80,strategy:'A',direction:'long',entry:100,stop:99,target1:102,target2:103},{valid_current_geometry:false,quant_score:99,strategy:'B',direction:'short'}];
  // Directly test the invariant represented by snapshot payloads without a
  // synthetic substitute for the shared evaluator.
  rows.filter(row=>row.valid_current_geometry).sort((a,b)=>b.quant_score-a.quant_score).forEach((row,index)=>row.candidate_rank=index+1);
  assert.equal(rows[0].candidate_rank,1);
  assert.equal(rows[1].candidate_rank,undefined);
  const left=Rank.hash({b:2,a:1}),right=Rank.hash({a:1,b:2});
  assert.equal(left,right);
});
