import assert from 'node:assert/strict';
import {runHistoricalBackfill,latestHistorical} from './historical-core.mjs';

const now=1_800_000_000_000,interval=300_000,start=now-300*interval;
const coinbaseRows=Array.from({length:300},(_,index)=>{const time=(start+index*interval)/1000,price=100+index*.1;return[time,price-1,price+1,price,price+.2,20];});
class Statement{constructor(db,sql){this.db=db;this.sql=sql;}bind(...args){this.args=args;return this;}async run(){this.db.calls.push({sql:this.sql,args:this.args});return{success:true};}async all(){if(this.sql.includes('historical_dataset_manifests'))return{results:this.db.manifests};return{results:[]};}}
class Db{constructor(){this.calls=[];this.manifests=[];}prepare(sql){return new Statement(this,sql);}async batch(items){for(const item of items)await item.run();}}
const db=new Db(),result=await runHistoricalBackfill({db,now,assets:['BTC'],days:2,delay:async()=>{},fetchImpl:async(_url,options)=>{assert.match(options.headers['user-agent'],/historical cache/);return new Response(JSON.stringify(coinbaseRows),{status:200});}});
assert.equal(result.status,'BUILDING');assert.equal(result.pages,1);assert.equal(result.errors.length,0);assert.ok(db.calls.some(call=>call.sql.includes('canonical_candles')));assert.ok(db.calls.some(call=>call.sql.includes('historical_dataset_manifests')));
db.manifests=[{asset:'BTC',status:'BUILDING'}];const latest=await latestHistorical(db);assert.equal(latest.storage,'connected');assert.equal(latest.manifests.length,1);
const failed=await runHistoricalBackfill({db:new Db(),now,assets:['BTC'],days:2,delay:async()=>{},fetchImpl:async()=>new Response('busy',{status:429})});assert.equal(failed.status,'FAILED');assert.equal(failed.errors.length,1);
console.log('Historical cache and manifest tests passed');
