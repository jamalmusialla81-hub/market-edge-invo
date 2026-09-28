#!/usr/bin/env node
// Research-only V1 rank experiment. It reads frozen HISTORICAL-RANK-V1
// candidates, re-resolves their outcome ONLY over a longer, frozen research
// horizon (same entry, stop, targets, and stop-first ambiguity rule as
// production — see research/outcome-horizon-study.mjs and the 2026-09-26
// horizon study), evaluates models against a FIXED untouched test cutoff
// that does not move as the dataset grows, and persists only an immutable
// experiment report. Nothing here writes to D1, alters frozen candidate
// inputs, or is eligible to influence the live scanner.
import crypto from 'node:crypto';
import Rank from './historical-rank.js';
import Recovery from './outcome-recovery.js';
import {symbolCandles, lowerBound} from './outcome-horizon-study.mjs';
import {trainConv, trainLogistic, trainPairwiseRanker, trainStumps, trainMtfRidge, selectionMetrics} from './v0-epoch-training.mjs';
import Registry from './dataset-registry.js';

const CF=process.env.CLOUDFLARE_API_TOKEN||'',RESEARCH_TOKEN=process.env.MARKET_EDGE_RESEARCH_TOKEN||'',ACCOUNT=process.env.CLOUDFLARE_ACCOUNT_ID||'8ea7796a8fb13ffb612245e8a08a55d6',DATABASE=process.env.MARKET_EDGE_D1_DATABASE_ID||'39a4082e-41a4-45e9-9b76-99cf10eaca01',API=(process.env.MARKET_EDGE_API||'https://market-edge-ai.jakob-market-edge.workers.dev').replace(/\/$/,'');
const ENGINE=process.env.HISTORICAL_RANK_ENGINE_VERSION||'HISTORICAL-RANK-V1';
const MIN_RESOLVED=Math.max(30,Number(process.env.RANK_TRAINING_MIN_RESOLVED)||200);

// Frozen research decisions from the 2026-09-26 outcome-horizon study
// (research/outcome-horizon-study.mjs, run 36225349261). No tested window
// captured a majority of natural stop/TP2 resolutions (24h=11.65% natural,
// 48h=17.01%, 72h=19.78%, 5d=24.21%, 7d=27.73%); 7 days nearly doubles the
// 24h rate and is the longest window studied, so it is adopted as the
// frozen research horizon. A 10-14 day follow-up study is recommended
// before revisiting this value.
const HORIZON_HOURS=Number(process.env.RANK_TRAINING_HORIZON_HOURS)||168,BARS_PER_HOUR=3_600_000/Rank.BASE_MS,HORIZON_BARS=HORIZON_HOURS*BARS_PER_HOUR;
// Fixed once: the 80th percentile scan date of the dataset at study time.
// Scans at or after this timestamp are the untouched test set and MUST NOT
// move as the daily Phase 5 job appends new scans.
const FIXED_TEST_CUTOFF_MS=Date.parse(process.env.RANK_TRAINING_TEST_CUTOFF||'2025-06-08T00:00:00.000Z');
const EMBARGO_MS=HORIZON_BARS*Rank.BASE_MS; // one full horizon, per side, around a chronological boundary
const COSTS=[.0008,.0016,.0025,.004],BOOTSTRAP_SAMPLES=2000,WALK_FORWARD_FOLDS=4;
const SYMBOLS={...Recovery.SYMBOLS,LTC:'LTCUSDT'};

const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const parse=value=>{try{return JSON.parse(value||'{}');}catch{return{};}};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
function quantile(values,q){const sorted=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!sorted.length)return null;const position=(sorted.length-1)*q,low=Math.floor(position),high=Math.ceil(position);return sorted[low]+(sorted[high]-sorted[low])*(position-low);}
function mulberry32(seed){let state=seed>>>0;return()=>{state=(state+0x6D2B79F5)|0;let t=Math.imul(state^state>>>15,1|state);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function groups(rows){return Object.values(Object.groupBy(rows,row=>row.scan_id)).sort((left,right)=>left[0].timestamp-right[0].timestamp);}

// Splits scan groups into train / validation / a FIXED, never-moving test
// pool, purging one full horizon on each side of a chronological boundary
// so no train/validation candidate's outcome window overlaps a test-side
// candidate's outcome window (or vice versa).
function fixedSplit(rows,cutoffMs=FIXED_TEST_CUTOFF_MS,embargoMs=EMBARGO_MS){
  const grouped=groups(rows);
  const test=grouped.filter(group=>group[0].timestamp>=cutoffMs);
  const beforeTest=grouped.filter(group=>group[0].timestamp<cutoffMs-embargoMs);
  const trainEnd=Math.max(1,Math.floor(beforeTest.length*.75));
  const train=beforeTest.slice(0,trainEnd);
  const lastTrain=train.at(-1)?.[0]?.timestamp??-Infinity;
  const validation=beforeTest.slice(trainEnd).filter(group=>group[0].timestamp-lastTrain>=embargoMs);
  return {train:train.flat(),validation:validation.flat(),test:test.flat(),groups:{total:grouped.length,train:train.length,validation:validation.length,test:test.length,purged:grouped.length-train.length-validation.length-test.length},cutoffMs,embargoMs};
}

// Expanding-window walk-forward folds inside the pre-cutoff development
// pool only. Each fold trains on every earlier chunk and validates on the
// next chunk, purging one embargo at the boundary. The frozen test pool
// (>= FIXED_TEST_CUTOFF_MS) never appears here.
function walkForwardFolds(rows,folds=WALK_FORWARD_FOLDS,cutoffMs=FIXED_TEST_CUTOFF_MS,embargoMs=EMBARGO_MS){
  const development=groups(rows).filter(group=>group[0].timestamp<cutoffMs-embargoMs);
  if(development.length<folds+1)return [];
  const chunkSize=Math.floor(development.length/(folds+1)),out=[];
  for(let fold=1;fold<=folds;fold++){
    const trainGroups=development.slice(0,chunkSize*fold),lastTrain=trainGroups.at(-1)?.[0]?.timestamp??-Infinity;
    const validationGroups=development.slice(chunkSize*fold,chunkSize*(fold+1)).filter(group=>group[0].timestamp-lastTrain>=embargoMs);
    if(!trainGroups.length||!validationGroups.length)continue;
    out.push({fold,train:trainGroups.flat(),validation:validationGroups.flat()});
  }
  return out;
}

// Grouped (by scan) bootstrap: resamples whole scans with replacement so a
// candidate never appears independently of its scan-mates, then reports the
// 2.5th/97.5th percentile of after-cost expectancy across resamples.
function groupedBootstrapCI(rows,scores,cost=.0016,samples=BOOTSTRAP_SAMPLES,seed=1){
  const byScan=new Map();rows.forEach((row,index)=>{const list=byScan.get(row.scan_id)||[];list.push({row,score:scores[index]});byScan.set(row.scan_id,list);});
  const scans=[...byScan.values()];
  if(scans.length<8)return {samples:0,ci95:[null,null],note:'Too few scan groups for a stable bootstrap.'};
  const random=mulberry32(seed),draws=[];
  for(let sample=0;sample<samples;sample++){
    const resampled=[];
    for(let index=0;index<scans.length;index++)resampled.push(...scans[Math.floor(random()*scans.length)]);
    const selected=[...Map.groupBy(resampled,item=>item.row.scan_id).values()].map(list=>list.slice().sort((a,b)=>b.score-a.score||String(a.row.candidate_id).localeCompare(String(b.row.candidate_id)))[0].row);
    draws.push(mean(selected.map(row=>costAdjustedR(row,cost))));
  }
  return {samples,ci95:[quantile(draws,.025),quantile(draws,.975)],meanOfSamples:mean(draws)};
}

function costAdjustedR(row,cost){const reference=Math.max(Math.abs((row.entry||0)-(row.stop||0))/(row.entry||1),Number.EPSILON);return (finite(row.targets.FINAL_R)||0)-(cost-.0016)/reference;}

// Buckets by same-scan rank of the model's own score (#1, #2-5, #6-10,
// #11+). With ~2 candidates per scan today, the lower buckets will mostly
// be empty; report n honestly rather than hiding it.
function rankBuckets(rows,scores){
  const byScan=new Map();rows.forEach((row,index)=>{const list=byScan.get(row.scan_id)||[];list.push({row,score:scores[index]});byScan.set(row.scan_id,list);});
  const bucketed={'#1':[],'#2-5':[],'#6-10':[],'#11+':[]};
  for(const list of byScan.values()){
    const ranked=list.slice().sort((a,b)=>b.score-a.score||String(a.row.candidate_id).localeCompare(String(b.row.candidate_id)));
    ranked.forEach((item,index)=>{const bucket=index===0?'#1':index<5?'#2-5':index<10?'#6-10':'#11+';bucketed[bucket].push(item.row);});
  }
  return Object.fromEntries(Object.entries(bucketed).map(([bucket,rows])=>[bucket,{n:rows.length,meanFinalR:mean(rows.map(row=>finite(row.targets.FINAL_R))),medianFinalR:quantile(rows.map(row=>finite(row.targets.FINAL_R)),.5)}]));
}

// Leave-one-asset-out: retrains on every asset but one, tests only on that
// asset's frozen test-pool rows. Reported only where the held-out asset has
// enough test rows to say anything.
function leaveOneAssetOut(devRows,testRows,minTestRows=8){
  const assets=[...new Set([...devRows,...testRows].map(row=>row.asset))];
  return Object.fromEntries(assets.map(asset=>{
    const heldOutTest=testRows.filter(row=>row.asset===asset);
    if(heldOutTest.length<minTestRows)return [asset,{status:'INSUFFICIENT_SAMPLE',testRows:heldOutTest.length}];
    const trainRows=devRows.filter(row=>row.asset!==asset);
    const ridge=trainRidgeQuant(trainRows);
    const scores=heldOutTest.map(row=>row.quant_score);
    return [asset,{status:'EVALUATED',testRows:heldOutTest.length,currentQuant:selectionMetrics(heldOutTest,scores,.0016)}];
  }));
}
function trainRidgeQuant(){return null;} // Current Quant needs no training; placeholder keeps LOAO symmetric for future model types.

function deterministicRandom(row){return parseInt(hash(row.candidate_id).slice(0,8),16)/0xffffffff;}
function metricAtCosts(rows,scores){return Object.fromEntries(COSTS.map(cost=>[String((cost*100).toFixed(2))+'%',selectionMetrics(rows,scores,cost)]));}
function withCI(rows,scores,label){const point=selectionMetrics(rows,scores,.0016),ci=groupedBootstrapCI(rows,scores,.0016);return {model:label,pointEstimate:point,bootstrap95CI:ci,positiveWithConfidence:Number.isFinite(ci.ci95?.[0])?ci.ci95[0]>0:null};}

async function d1(sql,params=[]){if(!CF)throw new Error('CLOUDFLARE_API_TOKEN is required');const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,{method:'POST',headers:{authorization:`Bearer ${CF}`,'content-type':'application/json'},body:JSON.stringify({sql,params})}),body=await response.json().catch(()=>({}));if(!response.ok||body.success===false)throw new Error(`D1 query failed: ${body?.errors?.[0]?.message||response.status}`);return body.result?.[0]?.results||[];}
async function ingest(experiment){if(!RESEARCH_TOKEN)throw new Error('MARKET_EDGE_RESEARCH_TOKEN is required');const response=await fetch(`${API}/v1/research/ingest`,{method:'POST',headers:{authorization:`Bearer ${RESEARCH_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({operation:'experiment_commit',experiment})}),body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`Experiment ingest failed: ${body?.error?.code||response.status}`);return body;}

function sequenceSafe(row){const frames=row.sequence?.timeframes||{};return ['m5','m15','h1'].every(name=>{const frame=frames[name];return frame?.available===true&&Array.isArray(frame.rows)&&frame.rows.length>=256&&Number.isFinite(Number(frame.window_end))&&Number(frame.window_end)<=row.timestamp;});}

async function buildRows(){
  const raw=await d1(`SELECT c.candidate_id,c.scan_id,c.asset,c.direction,c.strategy,c.entry,c.stop,c.rr,c.quant_score,c.regime,c.feature_json,seq.sequence_json,s.scan_timestamp FROM historical_scan_candidates c JOIN historical_scan_snapshots s ON s.scan_id=c.scan_id JOIN historical_candidate_sequences seq ON seq.candidate_id=c.candidate_id WHERE c.valid_current_geometry=1 AND s.engine_version=? ORDER BY s.scan_timestamp,c.candidate_id`,[ENGINE]);
  const byAsset=new Map();
  for(const asset of [...new Set(raw.map(row=>row.asset))]){
    const symbol=SYMBOLS[asset];if(!symbol)continue;
    const timestamps=raw.filter(row=>row.asset===asset).map(row=>Number(row.scan_timestamp));
    const start=Math.min(...timestamps),end=Math.min(Date.now(),Math.max(...timestamps)+(HORIZON_BARS+2)*Rank.BASE_MS);
    const loaded=await symbolCandles(symbol,start,end);
    byAsset.set(asset,loaded.rows);
  }
  const rows=[];
  for(const row of raw){
    const sequence=parse(row.sequence_json),features=parse(row.feature_json),timestamp=Number(row.scan_timestamp);
    const candidate={id:row.candidate_id,asset:row.asset,direction:row.direction,strategy:row.strategy,stop:Number(row.stop),rr:Number(row.rr),timestamp,valid_current_geometry:true};
    const series=byAsset.get(row.asset)||[],future=series.slice(lowerBound(series,timestamp),lowerBound(series,timestamp)+HORIZON_BARS);
    const targets=Rank.resolveCandidate(candidate,future,HORIZON_BARS);
    if(targets.status!=='RESOLVED')continue;
    const built={candidate_id:row.candidate_id,scan_id:row.scan_id,asset:row.asset,direction:row.direction,strategy:row.strategy,regime:row.regime,entry:finite(row.entry),stop:finite(row.stop),rr:finite(row.rr)||0,quant_score:finite(row.quant_score)||0,timestamp,features,sequence,targets};
    if(!sequenceSafe(built))continue;
    rows.push(built);
  }
  return rows.sort((a,b)=>a.timestamp-b.timestamp||String(a.candidate_id).localeCompare(String(b.candidate_id)));
}

function evaluateSplit(train,validation,test,label){
  const conv=trainConv(train,validation,32,'m5'),logistic=trainLogistic(train,validation),direct=trainPairwiseRanker(train,validation),boosted=trainStumps(train),mtf=trainMtfRidge(train);
  const models={RANDOM:row=>deterministicRandom(row),CURRENT_QUANT:row=>row.quant_score,[`LOGISTIC_TP1_${label}`]:logistic.predict,[`DIRECT_PAIRWISE_RANKER_${label}`]:direct.predict,[`CONV1D_${label}`]:conv.predict,[`GRADIENT_STUMPS_${label}`]:boosted,[`MTF_RIDGE_${label}`]:mtf};
  const withUncertainty=Object.fromEntries(Object.entries(models).map(([name,predict])=>[name,withCI(test,test.map(predict),name)]));
  const withCosts=Object.fromEntries(Object.entries(models).map(([name,predict])=>[name,metricAtCosts(test,test.map(predict))]));
  const buckets=Object.fromEntries(Object.entries(models).map(([name,predict])=>[name,rankBuckets(test,test.map(predict))]));
  const ranked=Object.entries(withUncertainty).filter(([name])=>name!=='RANDOM').sort((left,right)=>(right[1].pointEstimate.afterCostExpectancy??-Infinity)-(left[1].pointEstimate.afterCostExpectancy??-Infinity));
  return {models,withUncertainty,withCosts,buckets,bestModel:ranked[0]?.[0]||null};
}

async function run(){// Legacy V1 research: HISTORICAL-RANK-V1 is INVALID_CONTAMINATED (stale inputs). Refuse any
// invalid or unregistered dataset generation before reading a single row.
Registry.assertTrainable(ENGINE);
  const rows=await buildRows();
  if(rows.length<MIN_RESOLVED){const status={status:'V1 TRAINING BLOCKED',resolvedRankable:rows.length,required:MIN_RESOLVED,horizonHours:HORIZON_HOURS};console.log(JSON.stringify(status));return status;}
  const split=fixedSplit(rows),folds=walkForwardFolds(rows);
  const held=evaluateSplit(split.train,split.validation,split.test,'V1');
  const walkForward=folds.map(({fold,train,validation})=>({fold,groups:{train:groups(train).length,validation:groups(validation).length},currentQuant:selectionMetrics(validation,validation.map(row=>row.quant_score),.0016),random:selectionMetrics(validation,validation.map(deterministicRandom),.0016)}));
  const loao=leaveOneAssetOut(split.train.concat(split.validation),split.test);
  const v0Reference={note:'Carried forward from the 24h-horizon, moving-cutoff V0/V1-relabel run (research/v0-epoch-training.mjs); not re-run here.',RANDOM:-0.1099,CURRENT_QUANT:-0.1447,LOGISTIC_TP1:-0.0556,CONV1D:-0.0940};
  const datasetHash=hash(rows.map(row=>[row.candidate_id,row.targets]));
  const summary={
    status:'RESEARCH',label:'V1-HORIZON',engine:ENGINE,resolvedRankable:rows.length,
    horizon:{hours:HORIZON_HOURS,bars:HORIZON_BARS,source:'2026-09-26 outcome-horizon study (research/outcome-horizon-study.mjs); no tested window reached majority natural resolution — see study report'},
    fixedTestCutoff:new Date(FIXED_TEST_CUTOFF_MS).toISOString(),embargoMs:EMBARGO_MS,
    split:split.groups,
    testHeldOut:held.withUncertainty,testAtCosts:held.withCosts,testRankBuckets:held.buckets,bestModel:held.bestModel,
    walkForward,leaveOneAssetOut:loao,
    v0Reference,
    unavailableComponents:{realGradientBoostedRanker:'NOT_YET_IMPLEMENTED: current GRADIENT_STUMPS_V1 is a deterministic squared-loss decision-stump stand-in, not LightGBM/XGBoost.',gru:'NOT_RUN: no audited native tensor backend is present.',multiTask:'NOT_YET_IMPLEMENTED.',crossMarketFeatures:'NOT_YET_IMPLEMENTED.',featureAblations:'NOT_YET_IMPLEMENTED.',conv1dMultiTimeframe:'NOT_YET_IMPLEMENTED: CONV1D_V1 runs on m5 only, as in V0.',fusion:'NOT_YET_IMPLEMENTED under the new horizon/cutoff.'},
    productionInfluence:'NONE',noLookahead:true
  };
  const experiment={experiment_id:`V1-HORIZON-EPOCH-${datasetHash}`,hypothesis:'A frozen 7-day research outcome horizon and a fixed untouched test cutoff give a stable, reproducible basis to evaluate whether numeric, direct-ranking, or sequence rankers can improve same-scan rank #1 after-cost expectancy without changing production.',dataset_hash:datasetHash,engine_hash:hash(ENGINE),record_hash:hash(summary),feature_set:['frozen numeric pre-entry fields','frozen completed m5/15m/1h candle sequences'],parameters:{horizon_hours:HORIZON_HOURS,fixed_test_cutoff:new Date(FIXED_TEST_CUTOFF_MS).toISOString(),embargo_ms:EMBARGO_MS,walk_forward_folds:WALK_FORWARD_FOLDS,bootstrap_samples:BOOTSTRAP_SAMPLES,costs:COSTS},train_range:{groups:split.groups.train},validation_range:{groups:split.groups.validation},test_range:{groups:split.groups.test},fees:{round_trip_costs:COSTS},results:summary,lookahead_status:'PASS',recursive_status:'PASS',decision:'RESEARCH',rejection_reason:null};
  await ingest(experiment);
  console.log(JSON.stringify({status:'V1-HORIZON TRAINING STARTED',...summary},null,2));
  return summary;
}

export {fixedSplit,walkForwardFolds,groupedBootstrapCI,rankBuckets,leaveOneAssetOut,groups};
if(import.meta.url===`file://${process.argv[1]}`)run().catch(error=>{console.error(`V1 horizon training failed: ${error.message}`);process.exitCode=1;});
