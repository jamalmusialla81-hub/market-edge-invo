import {PRIORITY_ASSETS} from './historical-core.mjs';
import Quant from '../quant-engine.js';
import Replay from '../replay-engine.js';

// 61 complete UTC days guarantees 60 completed daily bars even when a chunk starts mid-day.
const VERSION='EARLY-WINDOW-RESEARCH-V1',WARMUP=17_568,CHUNK=288,BASE_MS=300_000,EVALUATION_MS=14_400_000,OUTCOME_BARS=288;
const FEATURE_SCHEMA=['m5/m15/h1/h4/d1 price,rsi,atr,roc5,relativeVolume,ema20,ema50,trend,support,resistance'];
const TARGET_SCHEMA=['TP1_BEFORE_SL','FINAL_R','MFE','MAE','BREAKOUT_FAILURE'];
function hash(v){let h=2166136261,s=JSON.stringify(v);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return(h>>>0).toString(16);}
function finite(value){const number=Number(value);return Number.isFinite(number)?number:null;}
function json(value){return JSON.stringify(value,(_,item)=>Number.isFinite(item)||typeof item!=='number'?item:null);}
function rows(result){return result?.results||[];}
async function state(db,asset){return db.prepare(`SELECT * FROM replay_states WHERE asset=?`).bind(asset).first();}
function normalized(candle){return{time:Number(candle.open_time),open:finite(candle.open),high:finite(candle.high),low:finite(candle.low),close:finite(candle.close),volume:finite(candle.volume)};}
function rejection(reason=''){
  const text=String(reason).toLowerCase();
  if(text.includes('no independent strategy'))return'no candidate';
  if(text.includes('regime')||text.includes('conflict'))return'regime conflict';
  if(text.includes('structure'))return'structure fail';
  if(text.includes('confirmation')||text.includes('timing'))return'momentum fail';
  if(text.includes('volume'))return'volume fail';
  if(text.includes('entry zone')||text.includes('chase')||text.includes('extension'))return'location/extension fail';
  if(text.includes('risk')||text.includes('liquidation')||text.includes('minimum')||text.includes('margin'))return'R:R fail';
  return'data-quality fail';
}
function emptyRejections(){return{'no candidate':0,'regime conflict':0,'structure fail':0,'momentum fail':0,'volume fail':0,'location/extension fail':0,'R:R fail':0,'data-quality fail':0};}
function preEntryFeatures(frames){const result={};for(const name of ['m5','m15','h1','h4','d1']){const frame=frames?.[name]||{};result[name]={price:finite(frame.price),rsi:finite(frame.rsi),atr:finite(frame.atr),roc5:finite(frame.roc5),relativeVolume:finite(frame.relativeVolume),ema20:finite(frame.ema20),ema50:finite(frame.ema50),trend:frame.structure?.trend||null,support:finite(frame.structure?.support),resistance:finite(frame.structure?.resistance)};}return result;}
function setupRow({asset,timestamp,setup,sourceHash,now}){
  const signalId=`ewr1-${asset}-${timestamp}-${hash([asset,timestamp,setup.strategy,setup.direction,sourceHash])}`;
  return{signalId,asset,timestamp,strategy:setup.strategy,direction:setup.direction,regime:setup.regime||'UNCLASSIFIED',quality:finite(setup.setupQuality??setup.quality)??0,signalPrice:finite(setup.entry),entry:finite(setup.idealEntry??setup.entry),stop:finite(setup.stop),tp1:finite(setup.target1),tp2:finite(setup.target2),rr:finite(setup.rr1??setup.rr),features:preEntryFeatures(setup.timeframes),targets:{status:'PENDING_OUTCOME'},sourceHash,now};
}
function validSetup(row){return Boolean(row.strategy&&row.direction&&row.signalPrice&&row.entry&&row.stop&&row.tp1&&row.tp2&&row.rr&&Math.abs(row.signalPrice-row.stop)>0);}
async function writeDecision(db,row){const result=await db.prepare(`INSERT OR IGNORE INTO historical_decision_points (signal_id,asset,timestamp,strategy,direction,regime,quality_score,signal_price,preferred_entry,stop,tp1,tp2,rr,features_json,targets_json,dataset_version,source_dataset_hash,created_at,immutable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(row.signalId,row.asset,row.timestamp,row.strategy,row.direction,row.regime,row.quality,row.signalPrice,row.entry,row.stop,row.tp1,row.tp2,row.rr,json(row.features),json(row.targets),VERSION,row.sourceHash,row.now).run();return Number(result?.meta?.changes)||0;}
function targetsFromFuture(signal,future){
  if(future.length<OUTCOME_BARS)return null;
  const direction=signal.direction,first=future[0],rawEntry=finite(first.open),plannedStop=finite(signal.stop),riskDistance=Math.abs(rawEntry-plannedStop);
  if(!rawEntry||!plannedStop||!riskDistance)return null;
  const entry=rawEntry*(direction==='long'?1.0003:.9997),stop=direction==='long'?entry-riskDistance:entry+riskDistance,tp1=direction==='long'?entry+riskDistance*finite(signal.rr):entry-riskDistance*finite(signal.rr),tp2=direction==='long'?entry+riskDistance*Math.max(finite(signal.rr)+1,3):entry-riskDistance*Math.max(finite(signal.rr)+1,3);
  let tp1Hit=false,mfe=0,mae=0,finalR=0;
  for(const candle of future.slice(0,OUTCOME_BARS)){
    const favorable=(direction==='long'?candle.high-entry:entry-candle.low)/riskDistance,adverse=(direction==='long'?candle.low-entry:entry-candle.high)/riskDistance;mfe=Math.max(mfe,favorable);mae=Math.min(mae,adverse);
    const activeStop=tp1Hit?entry:stop,hitStop=direction==='long'?candle.low<=activeStop:candle.high>=activeStop,hitOne=direction==='long'?candle.high>=tp1:candle.low<=tp1,hitTwo=direction==='long'?candle.high>=tp2:candle.low<=tp2;
    if(hitStop){finalR=tp1Hit?finite(signal.rr)*.5:-1;break;}
    if(!tp1Hit&&hitOne)tp1Hit=true;
    if(tp1Hit&&hitTwo){finalR=finite(signal.rr)*.5+Math.max(finite(signal.rr)+1,3)*.5;break;}
    finalR=(direction==='long'?candle.close-entry:entry-candle.close)/riskDistance;
  }
  const costR=(.0005*2+.0003*2)/(riskDistance/entry);
  return{status:'RESOLVED',TP1_BEFORE_SL:tp1Hit,FINAL_R:finalR-costR,MFE:mfe,MAE:mae,BREAKOUT_FAILURE:signal.strategy==='BREAKOUT + RETEST'&&!tp1Hit,execution:'next-valid 5m open with directional slippage; stop-first same-candle ordering; round-trip fee/slippage applied'};
}
async function resolveOutcomes({db,asset}){
  const pending=rows(await db.prepare(`SELECT signal_id,asset,timestamp,strategy,direction,stop,rr,targets_json FROM historical_decision_points WHERE asset=? AND dataset_version=? AND targets_json LIKE '%PENDING_OUTCOME%' ORDER BY timestamp LIMIT 12`).bind(asset,VERSION).all());let resolved=0;
  for(const signal of pending){const future=rows(await db.prepare(`SELECT open,high,low,close FROM canonical_candles WHERE asset=? AND exchange='COINBASE' AND interval='5m' AND open_time>? ORDER BY open_time LIMIT ?`).bind(asset,signal.timestamp,OUTCOME_BARS).all()).map(row=>({open:finite(row.open),high:finite(row.high),low:finite(row.low),close:finite(row.close)})),outcome=targetsFromFuture(signal,future);if(!outcome)continue;await db.prepare(`UPDATE historical_decision_points SET targets_json=? WHERE signal_id=? AND targets_json LIKE '%PENDING_OUTCOME%'`).bind(json(outcome),signal.signal_id).run();resolved++;}
  return resolved;
}
function sampleGate(n){return n<20?'INSUFFICIENT':n<50?'VERY LOW':n<100?'EARLY':n<200?'MODERATE SAMPLE':'LARGE SAMPLE';}
function grouped(values,key){return values.reduce((out,value)=>{const name=value[key]||'UNCLASSIFIED';out[name]=(out[name]||0)+1;return out;},{});}
function median(values){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length?sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2:null;}
async function materializeDataset(db,now){
  const records=rows(await db.prepare(`SELECT signal_id,asset,timestamp,strategy,direction,regime,source_dataset_hash,targets_json FROM historical_decision_points WHERE dataset_version=? AND targets_json LIKE '%RESOLVED%' ORDER BY timestamp`).bind(VERSION).all()),n=records.length;
  if(n<20)return{id:VERSION,status:sampleGate(n),n};
  const parsed=records.map(row=>({...row,target:JSON.parse(row.targets_json)})),finalRs=parsed.map(row=>finite(row.target.FINAL_R)).filter(Number.isFinite),summary={n,sample_gate:sampleGate(n),by_asset:grouped(parsed,'asset'),by_strategy:grouped(parsed,'strategy'),by_direction:grouped(parsed,'direction'),by_regime:grouped(parsed,'regime'),tp1_class_balance:{true:parsed.filter(row=>row.target.TP1_BEFORE_SL===true).length,false:parsed.filter(row=>row.target.TP1_BEFORE_SL!==true).length},mean_final_r:finalRs.length?finalRs.reduce((sum,value)=>sum+value,0)/finalRs.length:null,median_final_r:median(finalRs)};
  const sources=[...new Set(parsed.map(row=>row.source_dataset_hash))].sort(),datasetHash=hash([VERSION,records.map(row=>row.signal_id),sources]),start=Math.min(...parsed.map(row=>Number(row.timestamp))),end=Math.max(...parsed.map(row=>Number(row.timestamp)));
  await db.prepare(`INSERT INTO research_datasets (id,dataset_hash,source_hashes_json,date_start,date_end,feature_schema_json,target_schema_json,summary_json,created_at,status) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET dataset_hash=excluded.dataset_hash,source_hashes_json=excluded.source_hashes_json,date_start=excluded.date_start,date_end=excluded.date_end,feature_schema_json=excluded.feature_schema_json,target_schema_json=excluded.target_schema_json,summary_json=excluded.summary_json,created_at=excluded.created_at,status=excluded.status`).bind(VERSION,datasetHash,json(sources),start,end,json(FEATURE_SCHEMA),json(TARGET_SCHEMA),json(summary),now,'READY').run();
  return{id:VERSION,status:'READY',n,datasetHash,summary};
}
async function persistState({db,chosen,manifest,prior,last,work,decisionPoints,targets,now}){await db.prepare(`INSERT INTO replay_states (asset,dataset_version,source_dataset_hash,status,cursor_timestamp,last_processed_timestamp,candles_processed,decision_points_written,targets_written,started_at,updated_at,last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(asset) DO UPDATE SET source_dataset_hash=excluded.source_dataset_hash,status=excluded.status,cursor_timestamp=excluded.cursor_timestamp,last_processed_timestamp=excluded.last_processed_timestamp,candles_processed=replay_states.candles_processed+excluded.candles_processed,decision_points_written=replay_states.decision_points_written+excluded.decision_points_written,targets_written=replay_states.targets_written+excluded.targets_written,updated_at=excluded.updated_at,last_error=NULL`).bind(chosen,VERSION,manifest.dataset_hash,'RUNNING',last+BASE_MS,last,work.length,decisionPoints,targets,prior?.started_at||now,now).run();}
export async function runReplayChunk({db,now=Date.now(),asset}={}){
  if(!db)return{status:'STORAGE_UNAVAILABLE'};
  const progress=asset?[]:rows(await db.prepare(`SELECT asset,candles_processed,last_processed_timestamp FROM replay_states WHERE asset IN ('BTC','ETH','SOL','XRP','DOGE','LTC')`).all()),byAsset=new Map(progress.map(row=>[row.asset,row])),chosen=asset||[...PRIORITY_ASSETS].sort((left,right)=>((Number(byAsset.get(left)?.candles_processed)||0)-(Number(byAsset.get(right)?.candles_processed)||0))||left.localeCompare(right))[0],manifest=await db.prepare(`SELECT dataset_hash,dataset_version,target_start,cursor_start,candle_count FROM historical_dataset_manifests WHERE asset=? AND exchange='COINBASE' AND base_timeframe='5m'`).bind(chosen).first();
  if(!manifest)return{asset:chosen,status:'PENDING',reason:'No historical manifest'};
  const prior=await state(db,chosen),cursor=prior?.cursor_timestamp||manifest.target_start,sourceRows=rows(await db.prepare(`SELECT open_time,open,high,low,close,volume FROM canonical_candles WHERE asset=? AND exchange='COINBASE' AND interval='5m' AND open_time>=? ORDER BY open_time LIMIT ?`).bind(chosen,Math.max(manifest.target_start,cursor-WARMUP*BASE_MS),WARMUP+CHUNK).all());
  if(sourceRows.length<=WARMUP){await db.prepare(`INSERT INTO replay_states (asset,dataset_version,source_dataset_hash,status,cursor_timestamp,last_processed_timestamp,updated_at,last_error) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(asset) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,last_error=excluded.last_error`).bind(chosen,VERSION,manifest.dataset_hash,'PENDING',cursor,prior?.last_processed_timestamp||null,now,'Awaiting enough cached candles').run();return{asset:chosen,status:'PENDING',candles:sourceRows.length};}
  const base=sourceRows.map(normalized),derived=Replay.derived(base),work=sourceRows.slice(WARMUP),rejections=emptyRejections();let written=0,evaluated=0;
  for(const candle of work){const timestamp=Number(candle.open_time)+BASE_MS;if(timestamp%EVALUATION_MS!==0)continue;const snapshot=Replay.cachedSnapshot(derived,timestamp),ready=Replay.readiness(snapshot);if(!ready.ready){rejections['data-quality fail']++;continue;}evaluated++;const setup=Quant.evaluateSetup({timeframes:snapshot.timeframes,settings:{minQuality:72,minRR:1.8,balance:10000,riskPct:.01,maxLeverage:3,minNotional:1,maxExposurePct:1,requireMTF:true}}),decision=setupRow({asset:chosen,timestamp,setup,sourceHash:manifest.dataset_hash,now});if(!validSetup(decision)){rejections[rejection(setup.reason)]++;continue;}written+=await writeDecision(db,decision);}
  const targets=await resolveOutcomes({db,asset:chosen}),dataset=await materializeDataset(db,now),last=Number(work.at(-1).open_time);await persistState({db,chosen,manifest,prior,last,work,decisionPoints:written,targets,now});const persisted=await db.prepare(`SELECT COUNT(*) AS count FROM historical_decision_points WHERE asset=? AND dataset_version=?`).bind(chosen,VERSION).first();
  return{asset:chosen,status:'RUNNING',candlesProcessed:work.length,evaluated,decisionPoints:Number(persisted?.count)||0,decisionPointsWritten:written,targetsResolved:targets,dataset,cursor:last+BASE_MS,sourceHash:manifest.dataset_hash,rejections};
}
export {materializeDataset};
export async function replayProgress(db){const states=rows(await db.prepare(`SELECT * FROM replay_states ORDER BY asset`).all()),counts=rows(await db.prepare(`SELECT asset,COUNT(*) AS count,SUM(CASE WHEN targets_json LIKE '%RESOLVED%' THEN 1 ELSE 0 END) AS resolved FROM historical_decision_points WHERE dataset_version=? GROUP BY asset ORDER BY asset`).bind(VERSION).all()),byAsset=Object.fromEntries(counts.map(row=>[row.asset,{decisionPoints:Number(row.count)||0,resolved:Number(row.resolved||0)}])),dataset=await db.prepare(`SELECT id,dataset_hash,date_start,date_end,summary_json,created_at,status FROM research_datasets WHERE id=?`).bind(VERSION).first();return{dataset:dataset||{id:VERSION,status:sampleGate(counts.reduce((n,row)=>n+Number(row.resolved||0),0))},states,byAsset,totalDecisionPoints:counts.reduce((n,row)=>n+Number(row.count||0),0),totalResolvedTargets:counts.reduce((n,row)=>n+Number(row.resolved||0),0)};}
