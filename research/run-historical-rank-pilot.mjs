#!/usr/bin/env node
// Runs a bounded, reproducible rank-universe pilot against cached D1 candles.
// It never reads an outcome until after the corresponding immutable candidate
// snapshot has been accepted by the protected Worker.
import Rank from './historical-rank.js';
import Replay from '../replay-engine.js';

const API=(process.env.MARKET_EDGE_API||'https://market-edge-ai.jakob-market-edge.workers.dev').replace(/\/$/,''),RESEARCH_TOKEN=process.env.MARKET_EDGE_RESEARCH_TOKEN||'',CF_TOKEN=process.env.CLOUDFLARE_API_TOKEN||'',ACCOUNT=process.env.CLOUDFLARE_ACCOUNT_ID||'8ea7796a8fb13ffb612245e8a08a55d6',DB=process.env.MARKET_EDGE_D1_DATABASE_ID||'39a4082e-41a4-45e9-9b76-99cf10eaca01';
const CADENCE=7*24*60*60*1000,SCAN_LIMIT=Math.max(1,Math.min(8,Number(process.env.HISTORICAL_RANK_PILOT_SCANS)||4)),START_INDEX=Math.max(0,Number(process.env.HISTORICAL_RANK_START_INDEX)||0);
const args=new Set(process.argv.slice(2)),dryRun=args.has('--dry-run');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const normalise=row=>({time:Number(row.open_time),open:finite(row.open),high:finite(row.high),low:finite(row.low),close:finite(row.close),volume:finite(row.volume)});
function align(value,period){return Math.ceil(value/period)*period;}
async function d1(sql,params=[]) {
  if(!CF_TOKEN)throw new Error('CLOUDFLARE_API_TOKEN is required for protected cached-candle research');
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`,{method:'POST',headers:{authorization:`Bearer ${CF_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({sql,params})}),body=await response.json().catch(()=>({}));
  if(!response.ok||body.success===false)throw new Error(`D1 query failed: ${body?.errors?.[0]?.message||response.status}`);
  return body.result?.[0]?.results||[];
}
async function worker(payload) {
  if(!RESEARCH_TOKEN)throw new Error('MARKET_EDGE_RESEARCH_TOKEN is required to persist protected rank research');
  const response=await fetch(`${API}/v1/research/ingest`,{method:'POST',headers:{authorization:`Bearer ${RESEARCH_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(payload)}),body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Historical rank ingest failed: ${body?.error?.code||response.status} ${body?.error?.message||''}`);
  return body;
}
async function candles(asset,start,end) {
  const all=[]; let cursor=start-1;
  while(cursor<end) { const rows=await d1(`SELECT open_time,open,high,low,close,volume FROM canonical_candles WHERE asset=? AND exchange='COINBASE' AND interval='5m' AND open_time>? AND open_time<? ORDER BY open_time LIMIT 10000`,[asset,cursor,end]); if(!rows.length)break; all.push(...rows.map(normalise)); cursor=Number(rows.at(-1).open_time); if(rows.length<10000)break; }
  return all;
}
async function completedScans(scanIds) {
  if(!scanIds.length)return new Set();
  // A scan may be skipped only when its immutable snapshot exists and every
  // rankable candidate has already reached a terminal label.  A pending
  // outcome is deliberately replayed, but frozen candidate inputs are never
  // replaced because the Worker accepts only the identical provenance hash.
  const placeholders=scanIds.map(()=>'?').join(','),rows=await d1(`SELECT snapshot.scan_id AS scan_id,SUM(CASE WHEN candidate.valid_current_geometry=1 AND candidate.targets_json LIKE '%PENDING_OUTCOME%' THEN 1 ELSE 0 END) AS pending_rankable FROM historical_scan_snapshots snapshot LEFT JOIN historical_scan_candidates candidate ON candidate.scan_id=snapshot.scan_id WHERE snapshot.scan_id IN (${placeholders}) GROUP BY snapshot.scan_id`,scanIds);
  return new Set(rows.filter(row=>Number(row.pending_rankable||0)===0).map(row=>String(row.scan_id)));
}
async function main() {
  const bounds=await d1(`SELECT asset,MIN(open_time) AS first_time,MAX(open_time) AS last_time,COUNT(*) AS candle_count FROM canonical_candles WHERE exchange='COINBASE' AND interval='5m' AND asset IN ('BTC','ETH','SOL','XRP','DOGE','LTC') GROUP BY asset ORDER BY asset`);
  if(bounds.length!==Rank.ASSETS.length)throw new Error('Cached pilot asset set is incomplete');
  const byAsset=new Map(bounds.map(row=>[row.asset,row]));
  const commonStart=Math.max(...Rank.ASSETS.map(asset=>Number(byAsset.get(asset).first_time))),commonEnd=Math.min(...Rank.ASSETS.map(asset=>Number(byAsset.get(asset).last_time)+Rank.BASE_MS));
  const first=align(commonStart+17568*Rank.BASE_MS,CADENCE),lastAllowed=commonEnd-(Rank.OUTCOME_BARS+1)*Rank.BASE_MS;
  const selected=Array.from({length:SCAN_LIMIT},(_,index)=>first+(START_INDEX+index)*CADENCE).filter(timestamp=>timestamp<=lastAllowed);
  if(!selected.length){console.log(JSON.stringify({dataset:Rank.VERSION,status:'NO_COMPLETE_COMMON_HISTORY_REMAINING',start_index:START_INDEX,scan_limit:SCAN_LIMIT}));return;}
  const sourceHashes=await d1(`SELECT asset,dataset_hash FROM historical_dataset_manifests WHERE exchange='COINBASE' AND base_timeframe='5m' AND asset IN ('BTC','ETH','SOL','XRP','DOGE','LTC') ORDER BY asset`);
  const sourceHash=Rank.hash(sourceHashes.map(row=>[row.asset,row.dataset_hash]));
  const planned=selected.map(timestamp=>({timestamp,scanId:`hrp2-${timestamp}-${sourceHash}`})),complete=await completedScans(planned.map(item=>item.scanId)),remaining=planned.filter(item=>!complete.has(item.scanId)),report={dataset:Rank.VERSION,universe_mode:'HISTORICAL_DATA_UNIVERSE_PROXY',cadence_ms:CADENCE,start_index:START_INDEX,selection:'Earliest complete common-history timestamp, then every seven days; no performance-based selection',scan_timestamps:selected,skipped_complete:planned.filter(item=>complete.has(item.scanId)).map(item=>item.scanId),scans:[]};
  if(!remaining.length){console.log(JSON.stringify(report,null,2));return;}
  const start=commonStart,end=remaining.at(-1).timestamp+(Rank.OUTCOME_BARS+2)*Rank.BASE_MS,frames=new Map();
  // These D1 reads are independent and immutable. Parallelising this load does
  // not alter snapshot order, inputs, scoring, or persistence order.
  const loaded=await Promise.all(Rank.ASSETS.map(async asset=>({asset,rows:await candles(asset,start,end)})));
  for(const {asset,rows} of loaded) { if(rows.length<17568+Rank.OUTCOME_BARS)throw new Error(`${asset} cached candles are insufficient for rank pilot`); frames.set(asset,{rows,derived:Replay.derived(rows)}); }
  for(const {timestamp,scanId} of remaining) {
    const assetCandidates=[];
    for(const asset of Rank.ASSETS) { const source=frames.get(asset),snapshot=Replay.cachedSnapshot(source.derived,timestamp); if(!Replay.readiness(snapshot).ready)throw new Error(`${asset} failed completed-candle MTF readiness at ${timestamp}`); assetCandidates.push(...Rank.candidateRows({scanId,timestamp,asset,timeframes:snapshot.timeframes,sourceHash,instrument:asset})); }
    const combined=Rank.finalizeCandidates(assetCandidates);
    const snapshot=Rank.snapshot({scanId,timestamp,universe:Rank.ASSETS,sourceHash,cadenceMs:CADENCE,candidates:combined});
    if(!dryRun) await worker({operation:'historical_rank_snapshot_commit',snapshot,candidates:combined});
    // The snapshot is now immutable.  Only then do we inspect the subsequent
    // completed candles to form outcome labels.
    const outcomes=[]; let dataGaps=0;
    for(const candidate of combined) { if(!candidate.valid_current_geometry)continue; const assetRows=frames.get(candidate.asset).rows, position=assetRows.findIndex(row=>row.time>=timestamp); const target=position<0?{status:'UNRESOLVED_DATA_GAP',reason:'OUTCOME_WINDOW_NOT_AVAILABLE_IN_CACHE',next_valid_candle_gap_ms:null,available_bars:0,execution:'No execution or outcome was inferred because the cached 5m outcome window is unavailable'}:Rank.resolveCandidate(candidate,assetRows.slice(position))||{status:'UNRESOLVED_DATA_GAP',reason:'INVALID_NEXT_VALID_EXECUTION_CANDLE',next_valid_candle_gap_ms:null,available_bars:assetRows.length-position,execution:'No execution or outcome was inferred because the next valid execution candle is unusable'};if(target.status==='UNRESOLVED_DATA_GAP')dataGaps++;outcomes.push({candidate_id:candidate.candidate_id,targets:target,outcome_hash:Rank.hash({candidate_id:candidate.candidate_id,targets:target})}); }
    if(!dryRun&&outcomes.length)await worker({operation:'historical_rank_outcome_commit',scan_id:scanId,outcomes});
    report.scans.push({scan_id:scanId,timestamp,candidates:combined.length,ranked:combined.filter(row=>row.candidate_rank!==null).length,resolved:outcomes.filter(row=>row.targets.status==='RESOLVED').length,unresolved_data_gap:dataGaps});
    console.log(JSON.stringify({progress:'historical-rank-scan-complete',scan_id:scanId,timestamp,candidates:combined.length,ranked:combined.filter(row=>row.candidate_rank!==null).length,resolved:outcomes.filter(row=>row.targets.status==='RESOLVED').length,unresolved_data_gap:dataGaps}));
    await sleep(100);
  }
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(`historical rank pilot failed: ${error.message}`);process.exitCode=1;});
