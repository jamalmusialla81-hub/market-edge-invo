import assert from 'node:assert/strict';
import {normalizeBinanceKlines,normalizeHyperliquidCandles,aggregateCompleted,canonicalState,runMonitor,latestMonitor,fetchAssetCandles,INTERVAL_MS} from './monitor-core.mjs';

const now=1_800_000_000_000,base=now-300*INTERVAL_MS['5m'];
const rows=Array.from({length:300},(_,i)=>{const time=base+i*INTERVAL_MS['5m'],price=100+i*.1;return[time,String(price),String(price+1),String(price-1),String(price+.2),'20',time+INTERVAL_MS['5m']-1];});
let report=normalizeBinanceKlines(rows,{asset:'BTC',symbol:'BTCUSDT',now});
assert.equal(report.status,'HIGH');assert.equal(report.candles.length,300);assert.equal(report.errors.length,0);
assert.equal(aggregateCompleted(report.candles,'5m','15m',now).length,100);
assert.equal(aggregateCompleted(report.candles,'5m','1h',now).length,25);
assert.equal(canonicalState(report,now).status,'ACTIVE');assert.equal(canonicalState(report,now).executionDisabled,true);
report=normalizeBinanceKlines([...rows,rows[0]],{now});assert.equal(report.status,'INVALID');assert.match(report.errors[0],/duplicate/);
report=normalizeBinanceKlines([[now+1000000,'1','2','0.5','1','1',now+1300000]],{now});assert.equal(report.status,'INVALID');
report=normalizeBinanceKlines(rows.slice(-10),{now});assert.equal(canonicalState(report,now).status,'INSUFFICIENT DATA');
const hyperRows=rows.map(row=>({t:row[0],T:row[6],o:row[1],h:row[2],l:row[3],c:row[4],v:row[5]}));
assert.equal(normalizeHyperliquidCandles(hyperRows,{now}).status,'HIGH');
const fallback=await fetchAssetCandles({asset:'BTC',symbol:'BTCUSDT',exchange:'BINANCE'},async(url)=>url.includes('binance')?new Response('blocked',{status:451}):new Response(JSON.stringify(hyperRows),{status:200}),now);
assert.equal(fallback.exchange,'HYPERLIQUID');assert.match(fallback.providerStatus,/FALLBACK/);

class FakeStatement{constructor(db,sql){this.db=db;this.sql=sql;}bind(...args){this.args=args;return this;}async run(){this.db.calls.push({sql:this.sql,args:this.args});return {success:true};}async first(){return this.db.run||null;}async all(){return {results:this.db.states||[]};}}
class FakeDb{constructor(){this.calls=[];this.run=null;this.states=[];}prepare(sql){return new FakeStatement(this,sql);}async batch(items){for(const item of items)await item.run();}}
const db=new FakeDb();const monitor=await runMonitor({db,now,watchlist:[{asset:'BTC',symbol:'BTCUSDT',exchange:'BINANCE'}],fetchImpl:async()=>new Response(JSON.stringify(rows),{status:200})});
assert.equal(monitor.status,'COMPLETE');assert.equal(monitor.assetsCompleted,1);assert.equal(monitor.executionDisabled,true);assert.ok(db.calls.some(call=>call.sql.includes('canonical_candles')));assert.ok(db.calls.some(call=>call.sql.includes('market_states')));
const unavailable=await runMonitor({db:null,now,watchlist:[]});assert.equal(unavailable.status,'STORAGE_UNAVAILABLE');
db.run={id:'run',status:'COMPLETE'};db.states=[{asset:'BTC'}];const latest=await latestMonitor(db);assert.equal(latest.storage,'connected');assert.equal(latest.states.length,1);
console.log('Background monitor and canonical-state tests passed');
