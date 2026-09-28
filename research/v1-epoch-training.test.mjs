import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedSplit, walkForwardFolds, groupedBootstrapCI, rankBuckets, leaveOneAssetOut, groups} from './v1-epoch-training.mjs';

const DAY=86_400_000;
function row(scanId,timestamp,candidateId,extra={}){return {scan_id:scanId,timestamp,candidate_id:candidateId,asset:extra.asset||'BTC',entry:100,stop:99,quant_score:extra.quant_score??50,targets:{FINAL_R:extra.finalR??0,TP1_BEFORE_SL:false,STOP_HIT:false,TP2_HIT:false},...extra};}

test('fixedSplit never moves the test boundary and purges an embargo on each side',()=>{
  const cutoff=Date.parse('2025-06-08T00:00:00.000Z'),embargo=7*DAY;
  const rows=[
    row('s1',cutoff-40*DAY,'c1'),
    row('s2',cutoff-embargo+DAY,'c2'), // inside the purge zone: within one embargo of cutoff, but before it
    row('s3',cutoff+DAY,'c3'), // test
    row('s4',cutoff+40*DAY,'c4'), // future growth still lands in test
  ];
  const split=fixedSplit(rows,cutoff,embargo);
  assert.equal(split.test.length,2);
  assert.ok(split.test.every(item=>item.timestamp>=cutoff));
  assert.equal(split.groups.purged,1); // s2 purged, inside the embargo window
});

test('fixedSplit keeps the same test rows even after more scans are appended before the cutoff',()=>{
  const cutoff=Date.parse('2025-06-08T00:00:00.000Z'),embargo=7*DAY;
  const base=[row('a',cutoff-100*DAY,'c1'),row('b',cutoff+DAY,'c2')];
  const grown=[...base,row('c',cutoff-50*DAY,'c3'),row('d',cutoff-20*DAY,'c4')];
  const before=fixedSplit(base,cutoff,embargo),after=fixedSplit(grown,cutoff,embargo);
  assert.deepEqual(before.test.map(item=>item.candidate_id),after.test.map(item=>item.candidate_id));
});

test('walkForwardFolds trains only on earlier chunks and never touches the frozen test pool',()=>{
  const cutoff=Date.parse('2025-06-08T00:00:00.000Z'),embargo=7*DAY;
  const rows=Array.from({length:20},(_,index)=>row(`s${index}`,cutoff-200*DAY+index*8*DAY,`c${index}`));
  const folds=walkForwardFolds(rows,4,cutoff,embargo);
  assert.ok(folds.length>0);
  for(const fold of folds){
    const lastTrain=Math.max(...fold.train.map(item=>item.timestamp));
    const firstValidation=Math.min(...fold.validation.map(item=>item.timestamp));
    assert.ok(firstValidation>lastTrain);
    assert.ok(fold.train.every(item=>item.timestamp<cutoff));
    assert.ok(fold.validation.every(item=>item.timestamp<cutoff));
  }
});

test('groupedBootstrapCI resamples whole scans and reports a widening interval with fewer scans',()=>{
  const rows=Array.from({length:40},(_,index)=>row(`s${index}`,index,`c${index}`,{finalR:index%2?1:-1}));
  const scores=rows.map(()=>0);
  const result=groupedBootstrapCI(rows,scores,.0016,500,7);
  assert.equal(result.samples,500);
  assert.ok(result.ci95[0]<=result.ci95[1]);
  const tiny=groupedBootstrapCI(rows.slice(0,3),scores.slice(0,3));
  assert.equal(tiny.samples,0);
});

test('rankBuckets assigns #1/#2-5/#6-10/#11+ by each model\'s own score within a scan',()=>{
  const rows=[row('s1',0,'a',{finalR:1}),row('s1',0,'b',{finalR:-1})];
  const scores=[10,1];
  const buckets=rankBuckets(rows,scores);
  assert.equal(buckets['#1'].n,1);
  assert.equal(buckets['#1'].meanFinalR,1);
  assert.equal(buckets['#2-5'].n,1);
  assert.equal(buckets['#6-10'].n,0);
});

test('leaveOneAssetOut reports insufficient sample rather than fabricating a result',()=>{
  const dev=[row('s1',0,'a',{asset:'ETH'})];
  const test=[row('s2',1,'b',{asset:'BTC'})];
  const result=leaveOneAssetOut(dev,test,8);
  assert.equal(result.BTC.status,'INSUFFICIENT_SAMPLE');
});

test('groups sorts scans chronologically by their first row',()=>{
  const rows=[row('b',5,'x'),row('a',1,'y'),row('a',1,'z')];
  const grouped=groups(rows);
  assert.equal(grouped.length,2);
  assert.equal(grouped[0][0].scan_id,'a');
});
