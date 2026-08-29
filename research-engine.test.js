const assert=require('assert');
const Research=require('./research-engine.js');

const M5=Research.INTERVAL_MS['5m'];
function candles(count,start=0){return Array.from({length:count},(_,index)=>{const open=100+index*.1,close=open+.05;return {time:start+index*M5,open,high:close+.1,low:open-.1,close,volume:100+index};});}

const healthy=Research.inspectDataset(candles(12),{interval:'5m',asOf:12*M5,exchange:'BINANCE',symbol:'BTCUSDT'});
assert.equal(healthy.meta.dataQualityStatus,'HIGH');
assert.equal(healthy.meta.candleCount,12);
assert.equal(healthy.meta.missingCandleCount,0);
assert.match(healthy.meta.datasetVersion,/BINANCE:BTCUSDT:5m/);

const duplicate=candles(12);duplicate.splice(6,0,{...duplicate[5]});
assert.equal(Research.inspectDataset(duplicate,{interval:'5m',asOf:20*M5}).meta.dataQualityStatus,'REJECTED');
const reversed=candles(12);[reversed[5],reversed[6]]=[reversed[6],reversed[5]];
assert.match(Research.inspectDataset(reversed,{interval:'5m',asOf:20*M5}).errors.join(' '),/Non-monotonic/);
const bad=candles(12);bad[5]={...bad[5],high:90};
assert.match(Research.inspectDataset(bad,{interval:'5m',asOf:20*M5}).errors.join(' '),/Invalid OHLC/);
const negative=candles(12);negative[5]={...negative[5],close:-1,low:-2};
assert.equal(Research.inspectDataset(negative,{interval:'5m',asOf:20*M5}).meta.dataQualityStatus,'REJECTED');
const gap=candles(12);gap.splice(5,1);
assert.equal(Research.inspectDataset(gap,{interval:'5m',asOf:20*M5}).meta.missingCandleCount,1);
const withPartial=candles(13);
assert.equal(Research.inspectDataset(withPartial,{interval:'5m',asOf:12*M5+1}).meta.partialCandleCount,1);
const withFuture=candles(12);withFuture.push({...candles(1)[0],time:100*M5});
assert.match(Research.inspectDataset(withFuture,{interval:'5m',asOf:20*M5}).errors.join(' '),/future timestamp/);

const base=candles(12);
const aggregate=Research.aggregateCandles(base,'5m','15m',{asOf:12*M5});
assert.equal(aggregate.candles.length,4);
assert.equal(aggregate.candles[0].open,base[0].open);
assert.equal(aggregate.candles[0].close,base[2].close);
const gapped=candles(12);gapped.splice(4,1);
assert(Research.aggregateCandles(gapped,'5m','15m',{asOf:12*M5}).skippedBuckets.length>=1);

const ten=10*60*60*1000,baseDay=candles(20,9*60*60*1000);
const at1007=Research.alignTimeframes(baseDay,'5m',ten+7*60*1000,['5m','15m']);
assert(at1007.lastCompleted['15m'].time+Research.INTERVAL_MS['15m']<=ten+7*60*1000);
assert.equal(at1007.lastCompleted['15m'].time,ten-15*60*1000);
const injected={'15m':[...at1007.timeframes['15m'],{...at1007.lastCompleted['15m'],time:ten}]};
assert.throws(()=>Research.assertNoLookahead(injected,ten+7*60*1000),/LOOKAHEAD_REJECTED/);

const partition=Research.chronologicalPartition(candles(100),{datasetHash:'fixture'});
assert.equal(partition.train.length,60);assert.equal(partition.validation.length,20);assert.equal(partition.untouched.rows.length,20);
const consumed=Research.consumeUntouched(partition,'2026-08-29T00:00:00Z');
assert.equal(consumed.untouched.consumed,true);
assert.throws(()=>Research.consumeUntouched(consumed),/already been consumed/);

(async()=>{
  const all=candles(7),calls=[];
  const paged=await Research.paginateHistorical(async({start,limit})=>{calls.push(start);return all.filter(candle=>candle.time>=start).slice(0,limit);},{start:0,end:8*M5,interval:'5m',limit:3});
  assert.equal(paged.candles.length,7);assert.equal(paged.pages,3);assert.deepEqual(calls,[0,3*M5,6*M5]);
  console.log('Research data and no-lookahead tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
