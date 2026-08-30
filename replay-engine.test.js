const assert=require('assert');
const Replay=require('./replay-engine.js'),Research=require('./research-engine.js');
const M5=Research.INTERVAL_MS['5m'],start=0;
const base=Array.from({length:18_000},(_,index)=>{const time=start+index*M5,price=100+index*.01;return{time,open:price,high:price+.2,low:price-.2,close:price+.05,volume:100};});
const asOf=base.at(-1).time+M5,snap=Replay.snapshot(base,asOf);
assert.equal(snap.counts.m5,18_000);assert.equal(snap.counts.m15,6000);assert.equal(snap.counts.h1,1500);assert.equal(snap.counts.h4,375);assert.equal(snap.counts.d1,62);assert.equal(Replay.readiness(snap).ready,true);
assert.throws(()=>Replay.assertNoLookahead({...snap.timeframes,h1:[...snap.timeframes.h1,{time:asOf}]},asOf),/LOOKAHEAD_REJECTED/);
assert.throws(()=>Replay.assertNoLookahead({...snap.timeframes,d1:[...snap.timeframes.d1,{time:asOf}]},asOf),/LOOKAHEAD_REJECTED/);
const cache=Replay.derived(base);for(const [key,interval] of Object.entries({m15:'15m',h1:'1h',h4:'4h',d1:'1d'}))assert.deepEqual(cache[key],Research.aggregateCandles(base,'5m',interval,{asOf:Infinity}).candles);for(const at of [base[17_280].time+M5,base[17_610].time+M5,asOf]){const old=Replay.snapshot(base,at),fast=Replay.cachedSnapshot(cache,at);assert.deepEqual(fast.timeframes,old.timeframes);}
const partial=Replay.snapshot(base,asOf-2*M5);assert.equal(partial.counts.m5,17_998);assert.equal(Replay.readiness({counts:{m5:59,m15:60,h1:60,h4:60,d1:60}}).ready,false);
console.log('Multi-timeframe replay and no-lookahead tests passed');
