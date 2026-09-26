#!/usr/bin/env node
// Read-only research study: how long do frozen HISTORICAL-RANK-V1 candidates
// take to reach their stop or TP2 when given more time than the dataset's 24h
// outcome window?  It reads frozen candidate rows, replays later Binance
// USD-M 5m candles through the same resolver (same entry, stop, targets and
// stop-first ordering), and prints a report.  It writes nothing to D1.
import {writeFileSync} from 'node:fs';
import Rank from './historical-rank.js';
import {archiveCsv} from './recover-historical-rank-outcomes.mjs';
import Recovery from './outcome-recovery.js';

const CF=process.env.CLOUDFLARE_API_TOKEN||'',ACCOUNT=process.env.CLOUDFLARE_ACCOUNT_ID||'8ea7796a8fb13ffb612245e8a08a55d6',DB=process.env.MARKET_EDGE_D1_DATABASE_ID||'39a4082e-41a4-45e9-9b76-99cf10eaca01',ENGINE=process.env.HISTORICAL_RANK_ENGINE_VERSION||'HISTORICAL-RANK-V1',REPORT=process.env.HORIZON_STUDY_REPORT||'outcome-horizon-study.json';
const HOURS=[24,48,72,120,168],BARS_PER_HOUR=3_600_000/Rank.BASE_MS,MAX_BARS=HOURS.at(-1)*BARS_PER_HOUR;
// LTC is part of the frozen universe but not of the recovery proxy map; the
// study uses its USD-M perpetual only as a labelled proxy.
const SYMBOLS={...Recovery.SYMBOLS,LTC:'LTCUSDT'};
const parse=value=>{try{return JSON.parse(value||'{}');}catch{return{};}};
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const quantile=(values,q)=>{const sorted=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!sorted.length)return null;const position=(sorted.length-1)*q,low=Math.floor(position),high=Math.ceil(position);return sorted[low]+(sorted[high]-sorted[low])*(position-low);};
const ratio=(part,whole)=>whole?Number((part/whole).toFixed(4)):null;
const iso=timestamp=>new Date(timestamp).toISOString();

async function d1(sql,params=[]){if(!CF)throw new Error('CLOUDFLARE_API_TOKEN is required');const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`,{method:'POST',headers:{authorization:`Bearer ${CF}`,'content-type':'application/json'},body:JSON.stringify({sql,params})}),body=await response.json().catch(()=>({}));if(!response.ok||body.success===false)throw new Error(`D1 query failed: ${body?.errors?.[0]?.message||response.status}`);return body.result?.[0]?.results||[];}

async function zipRows(url){const response=await fetch(url);if(response.status===404)return null;if(!response.ok)throw new Error(`Binance archive ${url} failed: ${response.status}`);return archiveCsv(await response.arrayBuffer());}
function monthsBetween(start,end){const out=[];const date=new Date(Date.UTC(new Date(start).getUTCFullYear(),new Date(start).getUTCMonth(),1));while(date.getTime()<end){out.push(date.toISOString().slice(0,7));date.setUTCMonth(date.getUTCMonth()+1);}return out;}
function daysOfMonth(month,end){const out=[];const date=new Date(`${month}-01T00:00:00Z`),next=new Date(date);next.setUTCMonth(next.getUTCMonth()+1);for(let day=date.getTime();day<Math.min(next.getTime(),end);day+=86_400_000)out.push(new Date(day).toISOString().slice(0,10));return out;}
async function symbolCandles(symbol,start,end){
  const byTime=new Map(),sources={monthly:0,daily:0,missingDays:[]};
  for(const month of monthsBetween(start,end)){
    let rows=null;
    try{rows=await zipRows(`https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${symbol}-5m-${month}.zip`);}catch{rows=null;}
    if(rows){sources.monthly++;}else{rows=[];for(const day of daysOfMonth(month,end)){const daily=await zipRows(`https://data.binance.vision/data/futures/um/daily/klines/${symbol}/5m/${symbol}-5m-${day}.zip`);if(daily){rows.push(...daily);sources.daily++;}else sources.missingDays.push(day);}}
    for(const row of Recovery.candlesFromBinance(rows))if([row.time,row.open,row.high,row.low,row.close].every(Number.isFinite))byTime.set(row.time,row);
  }
  return {rows:[...byTime.values()].sort((a,b)=>a.time-b.time),sources};
}
function lowerBound(rows,time){let low=0,high=rows.length;while(low<high){const middle=(low+high)>>1;if(rows[middle].time<time)low=middle+1;else high=middle;}return low;}

function horizonSummary(results,hours){
  const evaluable=results.filter(item=>item.byHorizon[hours]?.status==='RESOLVED'),targets=evaluable.map(item=>item.byHorizon[hours]);
  const stop=targets.filter(t=>t.STOP_HIT).length,tp2=targets.filter(t=>t.TP2_HIT).length,tp1=targets.filter(t=>t.TP1_BEFORE_SL).length,natural=stop+tp2,firstTouch=targets.filter(t=>t.STOP_HIT||t.TP1_BEFORE_SL).length;
  return {hours,evaluable:evaluable.length,insufficient_future_data:results.length-evaluable.length,natural_exit_rate:ratio(natural,evaluable.length),first_touch_tp1_or_sl_rate:ratio(firstTouch,evaluable.length),stop_hit_rate:ratio(stop,evaluable.length),tp1_hit_rate:ratio(tp1,evaluable.length),tp2_hit_rate:ratio(tp2,evaluable.length),timeout_rate:ratio(evaluable.length-natural,evaluable.length),mean_final_r:mean(targets.map(t=>t.FINAL_R)),median_final_r:quantile(targets.map(t=>t.FINAL_R),.5)};
}

async function run(){
  const rows=await d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.quant_score,c.targets_json,s.scan_timestamp FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id WHERE c.valid_current_geometry=1 AND s.engine_version=? ORDER BY s.scan_timestamp,c.candidate_id`,[ENGINE]);
  const scans=[...new Map(rows.map(row=>[row.scan_id,Number(row.scan_timestamp)])).values()].sort((a,b)=>a-b);
  const candles=new Map(),sources={};
  for(const asset of [...new Set(rows.map(row=>row.asset))]){
    const symbol=SYMBOLS[asset];if(!symbol)continue;
    const times=rows.filter(row=>row.asset===asset).map(row=>Number(row.scan_timestamp));
    const loaded=await symbolCandles(symbol,Math.min(...times),Math.min(Date.now(),Math.max(...times)+(MAX_BARS+2)*Rank.BASE_MS));
    candles.set(asset,loaded.rows);sources[asset]={symbol,...loaded.sources,candles:loaded.rows.length};
  }
  const results=[];
  for(const row of rows){
    const stored=parse(row.targets_json),series=candles.get(row.asset)||[],timestamp=Number(row.scan_timestamp);
    const candidate={id:row.candidate_id,asset:row.asset,direction:row.direction,strategy:row.strategy,stop:Number(row.stop),rr:Number(row.rr),timestamp,valid_current_geometry:true};
    const future=series.slice(lowerBound(series,timestamp),lowerBound(series,timestamp)+MAX_BARS);
    const byHorizon=Object.fromEntries(HOURS.map(hours=>[hours,Rank.resolveCandidate(candidate,future,hours*BARS_PER_HOUR)]));
    const longest=byHorizon[HOURS.at(-1)];
    results.push({candidate_id:row.candidate_id,scan_id:row.scan_id,asset:row.asset,timestamp,quant_score:Number(row.quant_score),stored,byHorizon,natural_exit_hours:longest?.status==='RESOLVED'&&(longest.STOP_HIT||longest.TP2_HIT)?longest.duration_bars/BARS_PER_HOUR:null});
  }
  // Consistency check: the 24h proxy replay should agree with stored 24h labels.
  const comparable=results.filter(item=>item.stored.status==='RESOLVED'&&item.byHorizon[24]?.status==='RESOLVED');
  const agree=comparable.filter(item=>Boolean(item.stored.STOP_HIT)===Boolean(item.byHorizon[24].STOP_HIT)&&Boolean(item.stored.TP1_BEFORE_SL)===Boolean(item.byHorizon[24].TP1_BEFORE_SL)).length;
  const exits=results.map(item=>item.natural_exit_hours).filter(Number.isFinite);
  const top=[...Map.groupBy(results,item=>item.scan_id).values()].map(list=>list.slice().sort((a,b)=>b.quant_score-a.quant_score||String(a.candidate_id).localeCompare(String(b.candidate_id)))[0]);
  const report={
    engine:ENGINE,study:'OUTCOME_HORIZON_V1',writes:'NONE',outcome_source:'BINANCE_USDM_ARCHIVE_PROXY',rules:'same frozen entry basis (next 5m open + slippage), stop, TP1, TP2, rr; stop-first same-candle ordering; 0.16% cost',
    candidates:rows.length,scans:scans.length,scan_first:iso(scans[0]),scan_last:iso(scans.at(-1)),
    scan_quantiles:Object.fromEntries([.6,.7,.75,.8].map(q=>[q,iso(scans[Math.floor((scans.length-1)*q)])])),
    sources,
    stored_24h_consistency:{comparable:comparable.length,agree,agreement_rate:ratio(agree,comparable.length)},
    horizons:HOURS.map(hours=>horizonSummary(results,hours)),
    horizons_quant_rank1:HOURS.map(hours=>horizonSummary(top,hours)),
    natural_exit_hours_quantiles:Object.fromEntries([.25,.5,.75,.8,.9,.95].map(q=>[q,quantile(exits,q)])),
    natural_exits_within_7d:exits.length,
    exit_share_by_horizon:Object.fromEntries(HOURS.map(hours=>[hours,ratio(exits.filter(value=>value<=hours).length,exits.length)]))
  };
  writeFileSync(REPORT,JSON.stringify({...report,candidates_detail:results.map(({stored,byHorizon,...rest})=>({...rest,h:Object.fromEntries(Object.entries(byHorizon).map(([hours,t])=>[hours,{s:t?.status,stop:t?.STOP_HIT,tp1:t?.TP1_BEFORE_SL,tp2:t?.TP2_HIT,r:t?.FINAL_R,bars:t?.duration_bars}]))}))})+'\n');
  console.log(JSON.stringify(report,null,2));
}
export {horizonSummary,lowerBound,monthsBetween};
if(import.meta.url===`file://${process.argv[1]}`)run().catch(error=>{console.error(`horizon study failed: ${error.message}`);process.exitCode=1;});
