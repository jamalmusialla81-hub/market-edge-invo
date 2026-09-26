#!/usr/bin/env node
// Read-only Phase A audit: how many valid candidates survive per scan, which
// assets almost never survive, and (for scans where an asset produced zero
// candidates) which gate in Quant.strategyCandidates() was the closest miss.
// It never writes to D1 and calls only functions quant-engine.js and
// replay-engine.js already export; it changes no scoring, geometry, or
// production behaviour.
import Rank from './historical-rank.js';
import Replay from '../replay-engine.js';
import Quant from '../quant-engine.js';

const CF=process.env.CLOUDFLARE_API_TOKEN||'',ACCOUNT=process.env.CLOUDFLARE_ACCOUNT_ID||'8ea7796a8fb13ffb612245e8a08a55d6',DATABASE=process.env.MARKET_EDGE_D1_DATABASE_ID||'39a4082e-41a4-45e9-9b76-99cf10eaca01',ENGINE=process.env.HISTORICAL_RANK_ENGINE_VERSION||'HISTORICAL-RANK-V1',REPORT=process.env.CANDIDATE_AUDIT_REPORT||'candidate-diversity-audit.json';
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
function quantile(values,q){const sorted=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!sorted.length)return null;const position=(sorted.length-1)*q,low=Math.floor(position),high=Math.ceil(position);return sorted[low]+(sorted[high]-sorted[low])*(position-low);}
const normalise=row=>({time:Number(row.open_time),open:finite(row.open),high:finite(row.high),low:finite(row.low),close:finite(row.close),volume:finite(row.volume)});

async function d1(sql,params=[]){if(!CF)throw new Error('CLOUDFLARE_API_TOKEN is required');const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,{method:'POST',headers:{authorization:`Bearer ${CF}`,'content-type':'application/json'},body:JSON.stringify({sql,params})}),body=await response.json().catch(()=>({}));if(!response.ok||body.success===false)throw new Error(`D1 query failed: ${body?.errors?.[0]?.message||response.status}`);return body.result?.[0]?.results||[];}
async function candles(asset,start,end){const all=[];let cursor=start-1;while(cursor<end){const rows=await d1(`SELECT open_time,open,high,low,close,volume FROM canonical_candles WHERE asset=? AND exchange='COINBASE' AND interval='5m' AND open_time>? AND open_time<? ORDER BY open_time LIMIT 10000`,[asset,cursor,end]);if(!rows.length)break;all.push(...rows.map(normalise));cursor=Number(rows.at(-1).open_time);if(rows.length<10000)break;}return all;}

// Part 1: what's already persisted (exact, from frozen production rows).
async function persistedDensity(){
  const rows=await d1(`SELECT c.scan_id,c.asset,c.valid_current_geometry,c.invalidation_reason,s.scan_timestamp FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id WHERE s.engine_version=? ORDER BY s.scan_timestamp,c.asset`,[ENGINE]);
  const byScan=Map.groupBy(rows,row=>row.scan_id);
  const perScan=[...byScan.values()].map(list=>({valid:list.filter(row=>row.valid_current_geometry).length,total:list.length}));
  const validCounts=perScan.map(item=>item.valid);
  const histogram={'0':0,'1':0,'2':0,'3':0,'4':0,'5+':0};
  for(const count of validCounts)histogram[count>=5?'5+':String(count)]=(histogram[count>=5?'5+':String(count)]||0)+1;
  const assetParticipation={};
  for(const asset of Rank.ASSETS){
    const scansWithValidCandidate=[...byScan.values()].filter(list=>list.some(row=>row.asset===asset&&row.valid_current_geometry)).length;
    assetParticipation[asset]={scansWithAnyRow:[...byScan.values()].filter(list=>list.some(row=>row.asset===asset)).length,scansWithValidCandidate};
  }
  const invalidReasons=new Map();
  for(const row of rows.filter(row=>!row.valid_current_geometry)){const reason=row.invalidation_reason||'(no reason recorded)';invalidReasons.set(reason,(invalidReasons.get(reason)||0)+1);}
  return {
    scans:byScan.size,
    medianValidCandidatesPerScan:quantile(validCounts,.5),
    meanValidCandidatesPerScan:mean(validCounts),
    validCandidatesPerScanHistogram:histogram,
    assetParticipation,
    topInvalidationReasons:[...invalidReasons.entries()].sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count})),
    scanTimestamps:[...byScan.values()].map(list=>Number(list[0].scan_timestamp)).sort((a,b)=>a-b)
  };
}

// Part 2: for scans where an asset produced zero persisted candidates,
// replay the exact same deterministic frame construction Quant.evaluateSetup
// uses (Replay.derived + Replay.cachedSnapshot), then call the already
// exported Quant.strategyCandidates() to confirm zero, and read (never
// recompute) frame fields to classify the closest-miss gate. This mirrors,
// but never modifies, quant-engine.js.
function closestMissGate(setup){
  if(!setup?.available)return 'FRAME_UNAVAILABLE';
  const upTrend=setup.price>setup.ema20&&setup.ema20>setup.ema50&&setup.ema20Slope>0&&setup.structure.trend!=='short';
  const downTrend=setup.price<setup.ema20&&setup.ema20<setup.ema50&&setup.ema20Slope<0&&setup.structure.trend!=='long';
  const extended=Math.abs(setup.price-setup.ema20)>setup.atr*2.2;
  const volumeRatio=setup.volumeAvailable?setup.relativeVolume:0.75;
  if(setup.structure.retest||setup.structure.liquiditySweep||setup.structure.rejection)return 'RANGE_OR_REVERSAL_SETUP_PRESENT_BUT_UNCONFIRMED'; // a reversal/retest condition exists but didn't clear its own volume/CHoCH gate
  if(!upTrend&&!downTrend)return 'NO_TREND_STRUCTURE';
  if(extended)return 'EXTENDED_FROM_EMA20';
  if((upTrend&&(setup.rsi<48||setup.rsi>68))||(downTrend&&(setup.rsi<32||setup.rsi>52)))return 'RSI_OUTSIDE_CONTINUATION_BAND';
  if(volumeRatio<.8)return 'LOW_RELATIVE_VOLUME';
  if(setup.structure.exhaustion)return 'STRUCTURE_EXHAUSTION';
  return 'TREND_PRESENT_BUT_NO_MOMENTUM_CONFIRMATION'; // trend/RSI/volume all clear the continuation gate's basic bar, but momentum/MACD/ROC did not
}

async function missDiagnosis(scanTimestamps){
  const bounds=await d1(`SELECT asset,MIN(open_time) AS first_time,MAX(open_time) AS last_time FROM canonical_candles WHERE exchange='COINBASE' AND interval='5m' AND asset IN (${Rank.ASSETS.map(()=>'?').join(',')}) GROUP BY asset`,Rank.ASSETS);
  const byAsset=new Map(bounds.map(row=>[row.asset,row]));
  const end=Math.max(...scanTimestamps)+Rank.BASE_MS;
  // Fetch per asset concurrently, bounded by that asset's OWN earliest candle
  // (not the earliest across all assets) so a late-listed asset doesn't pull
  // months of rows it never had. This is a performance change only: it does
  // not alter which candles are read once fetched, only how many empty pages
  // are requested before the asset's own history begins.
  console.error(`[candidate-diversity-audit] fetching candle history for ${Rank.ASSETS.length} assets...`);
  const fetchStart=Date.now();
  const derivedByAsset=new Map(await Promise.all(Rank.ASSETS.map(async asset=>{
    if(!byAsset.has(asset))return [asset,null];
    const assetStart=Number(byAsset.get(asset).first_time);
    const rows=await candles(asset,assetStart,end);
    console.error(`[candidate-diversity-audit] ${asset}: ${rows.length} candles fetched (${((Date.now()-fetchStart)/1000).toFixed(1)}s elapsed)`);
    return [asset,rows.length?Replay.derived(rows):null];
  })));
  console.error(`[candidate-diversity-audit] history fetched in ${((Date.now()-fetchStart)/1000).toFixed(1)}s; replaying ${scanTimestamps.length} scans x ${Rank.ASSETS.length} assets...`);
  const replayStart=Date.now();
  const tally=new Map(),perAsset={};
  for(const asset of Rank.ASSETS)perAsset[asset]={zeroCandidateScans:0,gates:{}};
  let scansChecked=0;
  for(let index=0;index<scanTimestamps.length;index++){
    const timestamp=scanTimestamps[index];
    if(index&&index%50===0)console.error(`[candidate-diversity-audit] replayed ${index}/${scanTimestamps.length} scans (${((Date.now()-replayStart)/1000).toFixed(1)}s elapsed)`);
    for(const asset of Rank.ASSETS){
      const derived=derivedByAsset.get(asset);
      if(!derived)continue;
      let timeframes;
      try{timeframes=Replay.cachedSnapshot(derived,timestamp).timeframes;}catch{continue;} // insufficient history this far back for this asset; not a strategy-gate rejection
      let baseline;
      try{baseline=Quant.evaluateSetup({timeframes,settings:Rank.SETTINGS});}catch{continue;}
      const setup=baseline.timeframes?.h1?.available?baseline.timeframes.h1:baseline.frame;
      const found=Quant.strategyCandidates(setup);
      scansChecked++;
      if(found.length)continue;
      const gate=closestMissGate(setup);
      perAsset[asset].zeroCandidateScans++;
      perAsset[asset].gates[gate]=(perAsset[asset].gates[gate]||0)+1;
      tally.set(gate,(tally.get(gate)||0)+1);
    }
  }
  return {assetTimeframesChecked:scansChecked,topClosestMissGates:[...tally.entries()].sort((a,b)=>b[1]-a[1]).map(([gate,count])=>({gate,count})),perAsset};
}

async function run(){
  const persisted=await persistedDensity();
  const diagnosis=await missDiagnosis(persisted.scanTimestamps);
  const report={
    study:'CANDIDATE_DIVERSITY_AUDIT',engine:ENGINE,writes:'NONE',productionInfluence:'NONE',
    scans:persisted.scans,
    medianValidCandidatesPerScan:persisted.medianValidCandidatesPerScan,
    meanValidCandidatesPerScan:persisted.meanValidCandidatesPerScan,
    validCandidatesPerScanHistogram:persisted.validCandidatesPerScanHistogram,
    validCandidatesPerScanHistogramPct:Object.fromEntries(Object.entries(persisted.validCandidatesPerScanHistogram).map(([bucket,count])=>[bucket,Number((count/persisted.scans*100).toFixed(1))])),
    assetParticipation:Object.fromEntries(Object.entries(persisted.assetParticipation).map(([asset,stats])=>[asset,{...stats,pctScansWithValidCandidate:Number((stats.scansWithValidCandidate/persisted.scans*100).toFixed(1))}])),
    topInvalidationReasons:persisted.topInvalidationReasons,
    closestMissDiagnosis:{
      method:'Replays the same deterministic frame (Replay.derived + Replay.cachedSnapshot) and calls the already-exported Quant.strategyCandidates() unmodified; buckets zero-candidate asset-scans by the frame field closest to failing a continuation/reversal gate. Approximate: it checks the dominant TREND CONTINUATION gates first, so a scan that also missed a narrower strategy (breakout, momentum, mean-reversion, liquidity-sweep) by a different margin may be bucketed under a coarser category.',
      assetTimeframesChecked:diagnosis.assetTimeframesChecked,
      topGates:diagnosis.topClosestMissGates,
      perAsset:diagnosis.perAsset
    }
  };
  console.log(JSON.stringify(report,null,2));
  const fs=await import('node:fs');fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n');
  return report;
}
export {closestMissGate};
if(import.meta.url===`file://${process.argv[1]}`)run().catch(error=>{console.error(`candidate diversity audit failed: ${error.message}`);process.exitCode=1;});
