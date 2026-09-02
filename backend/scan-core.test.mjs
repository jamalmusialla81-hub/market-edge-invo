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
assert.equal(result.status,'BEST_TRADE_NOW');
assert.equal(result.bestOpportunity.asset,'BTC');
assert.equal(result.bestOpportunity.instrument,'BTC');
assert.ok(['IDEAL','ACCEPTABLE','EXTENDED'].includes(result.bestOpportunity.entry_status));
assert.ok(['IDEAL','ACCEPTABLE','EXTENDED'].includes(result.bestOpportunity.entry_quality));
assert.ok(result.bestTradeNow);
assert.equal(result.bestOpportunity.ml.weight,0);
assert.equal(result.bestOpportunity.ml.status,'NOT_APPLICABLE');
assert.ok(result.bestOpportunity.position);
assert.equal(result.bestOpportunity.position.risk_amount,10);

// Service-binding fan-out results are already Worker-normalized. A higher
// scored row with invalid geometry must be skipped in favour of the strongest
// later row with a complete structural plan.
const ranked=await runLiveScan({fetchImpl:fixtureFetch,now:NOW,markets:[{invoInstrument:'AAA',dataSymbol:'AAA'},{invoInstrument:'BBB',dataSymbol:'BBB'}],marketRunner:async market=>market.invoInstrument==='AAA'?{asset:'AAA',instrument:'AAA',direction:'long',strategy:'TREND CONTINUATION',entry:null,stop:null,tp1:null,tp2:null,rr1:null,setup_quality:99,combined_score:99,entry_status:'INVALID',strict_verdict:'NO TRADE',source_count:2}:{asset:'BBB',instrument:'BBB',direction:'short',strategy:'MEAN REVERSION',entry:100,stop:102,tp1:96,tp2:93,rr1:2,setup_quality:39,combined_score:39,entry_status:'EXTENDED',entry_quality:'EXTENDED',strict_verdict:'WAIT',position:null,source_count:2}});
assert.equal(ranked.status,'BEST_TRADE_NOW');
assert.equal(ranked.bestTradeNow.asset,'BBB');
assert.equal(ranked.bestTradeNow.rank,2);
assert.equal(ranked.bestOpportunity.asset,'AAA');
assert.equal(ranked.rankedOpportunities[0].asset,'AAA');

// The first five underlying scores can be unenterable; the first later valid
// structural plan remains the customer trade while retaining its true rank.
const sixDeep=await runLiveScan({fetchImpl:fixtureFetch,now:NOW,markets:Array.from({length:6},(_,index)=>({invoInstrument:`A${index}A`,dataSymbol:`A${index}A`})),marketRunner:async market=>{
  const index=Number(market.invoInstrument[1]);
  return index<5?{asset:market.invoInstrument,instrument:market.invoInstrument,direction:'long',strategy:'TREND CONTINUATION',entry:null,stop:null,tp1:null,tp2:null,rr1:null,setup_quality:100-index,combined_score:100-index,entry_status:'INVALID',strict_verdict:'NO TRADE',source_count:2}:{asset:market.invoInstrument,instrument:market.invoInstrument,direction:'short',strategy:'MEAN REVERSION',entry:100,stop:102,tp1:96,tp2:93,rr1:2,setup_quality:20,combined_score:20,entry_status:'EXTENDED',entry_quality:'EXTENDED',strict_verdict:'WAIT',position:null,source_count:2};
}});
assert.equal(sixDeep.bestTradeNow.rank,6);
assert.equal(sixDeep.bestTradeNow.asset,'A5A');

const unavailable=await runLiveScan({fetchImpl:fixtureFetch,now:NOW,marketMetadata:{invoInstrument:'BTC',dataSymbol:'BTC'},marketRunner:async()=>({error:'All feeds unavailable'})});
assert.equal(unavailable.status,'DATA_UNAVAILABLE');
assert.equal(unavailable.bestTradeNow,null);
const chart=await fetchLiveMarketChart({asset:'BTC',timeframe:'15m',fetchImpl:fixtureFetch,now:NOW});
assert.equal(chart.asset,'BTC');
assert.equal(chart.timeframe,'15m');
assert.equal(chart.source,'HYPERLIQUID');
assert.ok(chart.candles.length>=60);
await assert.rejects(()=>fetchLiveMarketChart({asset:'BTC',timeframe:'2m',fetchImpl:fixtureFetch,now:NOW}),/Unsupported chart timeframe/);
console.log('Customer scan adapter tests passed');
