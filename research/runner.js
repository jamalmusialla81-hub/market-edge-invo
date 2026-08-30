#!/usr/bin/env node
'use strict';

// Server-independent, deterministic research runner. It intentionally imports the
// same shared Quant and Replay modules used by Market Edge rather than a second
// strategy implementation.
const crypto=require('node:crypto');
const Quant=require('../quant-engine.js');
const Replay=require('../replay-engine.js');

const API=(process.env.MARKET_EDGE_API||'https://market-edge-ai.jakob-market-edge.workers.dev').replace(/\/$/,'');
const TOKEN=process.env.MARKET_EDGE_RESEARCH_TOKEN||'';
const VERSION='EARLY-WINDOW-RESEARCH-V1',BASE_MS=300000,WARMUP=17568,CHUNK=288,OUTCOME_BARS=288;
const ASSETS=['BTC','ETH','SOL','XRP','DOGE','LTC'];
const PRODUCT=Object.fromEntries(ASSETS.map(asset=>[asset,`${asset}-USD`]));
const args=process.argv.slice(2),command=args[0]||'status';
const option=name=>{const index=args.indexOf(`--${name}`);return index>=0?args[index+1]:null;};
const has=name=>args.includes(`--${name}`);
function finite(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function hash(value){let h=2166136261,text=JSON.stringify(value);for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return(h>>>0).toString(16);}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function resultId(asset,cursor){return `gha-${asset}-${cursor}-${crypto.randomUUID().slice(0,8)}`;}
function normalise(rows,end){
  const seen=new Set(),out=[];
  for(const row of Array.isArray(rows)?rows:[]){const time=finite(row?.[0])*1000,low=finite(row?.[1]),high=finite(row?.[2]),open=finite(row?.[3]),close=finite(row?.[4]),volume=finite(row?.[5]);
    if(![time,open,high,low,close,volume].every(Number.isFinite)||volume<0||open<=0||high<Math.max(open,close)||low>Math.min(open,close)||low>high||time+BASE_MS>end||seen.has(time))continue;
    seen.add(time);out.push({time,open,high,low,close,volume});
  }
  return out.sort((a,b)=>a.time-b.time);
}
async function coinbase(asset,start,end){
  const all=[];let from=start;
  while(from<end){const to=Math.min(end,from+300*BASE_MS),url=`https://api.exchange.coinbase.com/products/${encodeURIComponent(PRODUCT[asset])}/candles?granularity=300&start=${encodeURIComponent(new Date(from).toISOString())}&end=${encodeURIComponent(new Date(to).toISOString())}`;
    let response;for(let attempt=0;attempt<3;attempt++){response=await fetch(url,{headers:{accept:'application/json','user-agent':'MarketEdgeResearchRunner/1.0'}});if(response.ok)break;if(response.status===429||response.status>=500){await sleep(1000*(attempt+1));continue;}throw new Error(`${asset} Coinbase HTTP ${response.status}`);}
    if(!response?.ok)throw new Error(`${asset} Coinbase request exhausted retries`);
    all.push(...normalise(await response.json(),end));from=to;await sleep(120);
  }
  const unique=new Map(all.map(candle=>[candle.time,candle]));return [...unique.values()].sort((a,b)=>a.time-b.time);
}
function preEntryFeatures(timeframes){const output={};for(const name of ['m5','m15','h1','h4','d1']){const frame=timeframes?.[name]||{};output[name]={price:finite(frame.price),rsi:finite(frame.rsi),atr:finite(frame.atr),roc5:finite(frame.roc5),relativeVolume:finite(frame.relativeVolume),ema20:finite(frame.ema20),ema50:finite(frame.ema50),trend:frame.structure?.trend||null,support:finite(frame.structure?.support),resistance:finite(frame.structure?.resistance)};}return output;}
function decision(asset,timestamp,setup,sourceHash){
  const signalId=`ewr1-${asset}-${timestamp}-${hash([asset,timestamp,setup.strategy,setup.direction,sourceHash])}`;
  return {signal_id:signalId,asset,timestamp,strategy:setup.strategy,direction:setup.direction,regime:setup.regime||'UNCLASSIFIED',quality_score:finite(setup.setupQuality??setup.quality)??0,signal_price:finite(setup.entry),preferred_entry:finite(setup.idealEntry??setup.entry),stop:finite(setup.stop),tp1:finite(setup.target1),tp2:finite(setup.target2),rr:finite(setup.rr1??setup.rr),features:preEntryFeatures(setup.timeframes),targets:{status:'PENDING_OUTCOME'},dataset_version:VERSION,source_dataset_hash:sourceHash};
}
function valid(row){return Boolean(row.strategy&&row.direction&&row.signal_price&&row.preferred_entry&&row.stop&&row.tp1&&row.tp2&&row.rr&&Math.abs(row.signal_price-row.stop)>0);}
function outcome(signal,candles,fromIndex){
  const future=candles.slice(fromIndex+1,fromIndex+1+OUTCOME_BARS);if(future.length<OUTCOME_BARS)return null;
  const entry=future[0].open,risk=Math.abs(entry-signal.stop);if(!entry||!risk)return null;const long=signal.direction==='long',stop=long?entry-risk:entry+risk,tp1=long?entry+risk*signal.rr:entry-risk*signal.rr,tp2=long?entry+risk*Math.max(signal.rr+1,3):entry-risk*Math.max(signal.rr+1,3);
  let hitOne=false,mfe=0,mae=0,finalR=0,barsHeld=0,timeToTp1=null,timeToStop=null;
  for(const [index,candle] of future.entries()){barsHeld=index+1;const favourable=(long?candle.high-entry:entry-candle.low)/risk,adverse=(long?candle.low-entry:entry-candle.high)/risk;mfe=Math.max(mfe,favourable);mae=Math.min(mae,adverse);
    const hitStop=long?candle.low<=(hitOne?entry:stop):candle.high>=(hitOne?entry:stop),hitTarget=long?candle.high>=tp1:candle.low<=tp1,hitTwo=long?candle.high>=tp2:candle.low<=tp2;
    if(hitStop){finalR=hitOne?signal.rr*.5:-1;timeToStop=barsHeld;break;}
    if(!hitOne&&hitTarget){hitOne=true;timeToTp1=barsHeld;}
    if(hitOne&&hitTwo){finalR=signal.rr*.5+Math.max(signal.rr+1,3)*.5;break;}
    finalR=(long?candle.close-entry:entry-candle.close)/risk;
  }
  const costR=.0016/(risk/entry);return {status:'RESOLVED',TP1_BEFORE_SL:hitOne,FINAL_R:finalR-costR,MFE:mfe,MAE:mae,BREAKOUT_FAILURE:signal.strategy==='BREAKOUT + RETEST'&&!hitOne,time_to_tp1:timeToTp1,time_to_stop:timeToStop,bars_held:barsHeld,execution:'next-valid 5m open; directional slippage; stop-first same-candle ordering; 0.16% round-trip cost'};
}
async function api(path,method='GET',body){const response=await fetch(`${API}${path}`,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(TOKEN?{authorization:`Bearer ${TOKEN}`}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`${method} ${path}: ${data?.error?.message||response.status}`);return data;}
async function status(){return api('/v1/research/replay');}
function knownCheck(rows){const expected={timestamp:1730332800000,strategy:'Liquidity-Sweep Reversal',direction:'short',signal:72322.91,entry:72450,stop:72663.19,tp1:71710.40,rr:1.8},normalise=value=>String(value||'').replace(/[^a-z0-9]/gi,'').toLowerCase(),row=rows.find(item=>item.timestamp===expected.timestamp&&normalise(item.strategy)===normalise(expected.strategy)&&item.direction===expected.direction);if(!row)throw new Error('Known BTC signal was not reproduced');for(const [key,value] of Object.entries({signal_price:expected.signal,preferred_entry:expected.entry,stop:expected.stop,tp1:expected.tp1,rr:expected.rr}))if(Math.abs(Number(row[key])-value)>Math.max(.02,Math.abs(value)*.0005))throw new Error(`Known BTC ${key} mismatch: ${row[key]} vs ${value}`);return row;}
async function replay(asset,options={}){
  const progress=options.progress||await status(),prior=progress.states.find(row=>row.asset===asset),requestedCursor=Number(options.cursor||prior?.cursor_timestamp||Date.now()-((WARMUP+CHUNK+OUTCOME_BARS)*BASE_MS)),cursor=Math.floor(requestedCursor/BASE_MS)*BASE_MS;
  const start=cursor-WARMUP*BASE_MS,end=cursor+(CHUNK+OUTCOME_BARS)*BASE_MS,candles=await coinbase(asset,start,end);if(candles.length<WARMUP+CHUNK)throw new Error(`${asset} has ${candles.length} valid candles; requires ${WARMUP+CHUNK}`);const sourceHash=prior?.source_dataset_hash||hash(candles.map(candle=>[candle.time,candle.open,candle.high,candle.low,candle.close,candle.volume]));
  const cache=Replay.derived(candles),work=candles.filter(candle=>candle.time>=cursor&&candle.time<cursor+CHUNK*BASE_MS),rows=[];
  for(const candle of work){const timestamp=candle.time+BASE_MS;if(timestamp%14_400_000!==0)continue;const snapshot=Replay.cachedSnapshot(cache,timestamp);if(!Replay.readiness(snapshot).ready)continue;const setup=Quant.evaluateSetup({timeframes:snapshot.timeframes,settings:{minQuality:72,minRR:1.8,balance:10000,riskPct:.01,maxLeverage:3,minNotional:1,maxExposurePct:1,requireMTF:true}}),row=decision(asset,timestamp,setup,sourceHash);if(valid(row)){const index=candles.findIndex(item=>item.time===candle.time);row.targets=outcome(row,candles,index)||row.targets;rows.push(row);}}
  if(asset==='BTC'&&has('assert-known-btc'))knownCheck(rows);
  const payload={operation:'replay_commit',run_id:resultId(asset,cursor),asset,dataset_version:VERSION,source_dataset_hash:sourceHash,input_cursor:cursor,cursor_timestamp:cursor+CHUNK*BASE_MS,last_processed_timestamp:cursor+(CHUNK-1)*BASE_MS,candles_processed:work.length,decision_points:rows,started_at:Date.now(),detail:{provider:'COINBASE',symbol:PRODUCT[asset],received_candles:candles.length,known_btc_checked:asset==='BTC'&&has('assert-known-btc')}};
  if(options.dryRun)return {payload,known:asset==='BTC'&&has('assert-known-btc')?knownCheck(rows):null};
  return api('/v1/research/ingest','POST',payload);
}
async function cycle(){const progress=await status(),states=new Map(progress.states.map(row=>[row.asset,row]));const asset=[...ASSETS].sort((a,b)=>(Number(states.get(a)?.candles_processed)||0)-(Number(states.get(b)?.candles_processed||0))||a.localeCompare(b))[0];return replay(asset,{progress});}
(async()=>{if(command==='status')console.log(JSON.stringify(await status(),null,2));else if(command==='replay'){const asset=(option('asset')||'BTC').toUpperCase();console.log(JSON.stringify(await replay(asset,{dryRun:has('dry-run'),cursor:option('cursor')}),null,2));}else if(command==='cycle')console.log(JSON.stringify(await cycle(),null,2));else throw new Error(`Unknown command: ${command}`);})().catch(error=>{console.error(`research runner failed: ${error.message}`);process.exitCode=1;});
