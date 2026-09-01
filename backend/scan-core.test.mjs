import assert from 'node:assert/strict';
import {fetchLiveMarketChart,runLiveScan} from './scan-core.mjs';

const NOW=1_800_000_000_000;
const MS={'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000};
function rows(interval,count=500){
  const span=MS[interval],end=Math.floor(NOW/span)*span-span;
  return Array.from({length:count},(_,index)=>{const time=end-(count-1-index)*span,base=100+index*.025,open=base-.01,close=base,high=base+.04,low=base-.04,volume=100+(index%9);return {t:time,o:String(open),h:String(high),l:String(low),c:String(close),v:String(volume),T:time+span-1};});
}
function binanceRows(){return rows('4h').map(c=>[c.t,c.o,c.h,c.l,c.c,c.v,c.T]);}
function coinbaseRows(){return rows('1h').map(c=>[Math.floor(c.t/1000),c.l,c.h,c.o,c.c,c.v]);}
async function fixtureFetch(url,options={}){
  const target=String(url);
  if(target==='https://api.hyperliquid.xyz/info'){
    const body=JSON.parse(options.body);
    if(body.type==='metaAndAssetCtxs')return new Response(JSON.stringify([{universe:[{name:'BTC',maxLeverage:10}]},[{dayNtlVlm:'1000000',openInterest:'1000',markPx:'100'}]]),{status:200});
    return new Response(JSON.stringify(rows(body.req.interval)),{status:200});
  }
  if(target.includes('api.binance.com'))return new Response(JSON.stringify(binanceRows()),{status:200});
  if(target.includes('api.exchange.coinbase.com'))return new Response(JSON.stringify(coinbaseRows()),{status:200});
  throw new Error(`Unexpected URL: ${target}`);
}

const result=await runLiveScan({fetchImpl:fixtureFetch,now:NOW,settings:{balance:1000,riskPct:.01,maxLeverage:5,maxExposurePct:.2}});
assert.equal(result.universe.found,1);
assert.equal(result.universe.scanned,1);
assert.equal(result.universe.evaluated,1);
assert.equal(result.dataQuality.status,'MULTI_SOURCE');
assert.deepEqual(result.dataQuality.coverage,{requested:1,evaluated:1,skipped:0,multiSourceEvaluated:1,singleSourceEvaluated:0});
assert.equal(result.rankedOpportunities.length,1);
assert.equal(result.rankedOpportunities[0].rank,1);
assert.ok(['TRADE_READY','WAIT_FOR_ENTRY','NO_VALID_SETUP'].includes(result.status));
assert.equal(result.bestOpportunity.asset,'BTC');
assert.equal(result.bestOpportunity.instrument,'BTC');
assert.ok(['TRADE_READY','WAIT_FOR_ENTRY','NO_VALID_SETUP','DATA_UNAVAILABLE'].includes(result.bestOpportunity.entry_status));
assert.equal(result.bestOpportunity.ml.weight,0);
assert.equal(result.bestOpportunity.ml.status,'NOT_APPLICABLE');
assert.equal(result.bestOpportunity.position,null);
const chart=await fetchLiveMarketChart({asset:'BTC',timeframe:'15m',fetchImpl:fixtureFetch,now:NOW});
assert.equal(chart.asset,'BTC');
assert.equal(chart.timeframe,'15m');
assert.equal(chart.source,'HYPERLIQUID');
assert.ok(chart.candles.length>=60);
await assert.rejects(()=>fetchLiveMarketChart({asset:'BTC',timeframe:'2m',fetchImpl:fixtureFetch,now:NOW}),/Unsupported chart timeframe/);
console.log('Customer scan adapter tests passed');
