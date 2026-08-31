import {runMonitor, latestMonitor, MONITOR_VERSION, WATCHLIST} from './monitor-core.mjs';
import {runHistoricalBackfill,latestHistorical,HISTORICAL_VERSION,PRIORITY_ASSETS} from './historical-core.mjs';
import {runReplayChunk,replayProgress,materializeDataset} from './replay-core.mjs';

const DEFAULT_ORIGINS = ['https://jamalmusialla81-hub.github.io', 'http://127.0.0.1:4173', 'http://127.0.0.1:4174', 'http://localhost:4173'];
const MAX_BODY_BYTES = 8_500_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 1_750_000;
const MAX_TOTAL_IMAGE_BYTES = 6_000_000;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
const rateBuckets = new Map();
const tradingViewEvents = new Map();
const TRADINGVIEW_INTERVAL_MS = {'5m':300_000,'15m':900_000,'1h':3_600_000,'4h':14_400_000,'1d':86_400_000};

const caseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    trigger: {type:'string'}, entry_zone: {type:'array',items:{type:'number'},maxItems:2},
    invalidation: {type:'string'}, targets: {type:'array',items:{type:'number'},maxItems:4}
  },
  required: ['trigger','entry_zone','invalidation','targets']
};
const analysisSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    asset: {type:'string'}, bias: {type:'string',enum:['bullish','bearish','neutral']},
    ai_verdict: {type:'string',enum:['LONG','SHORT','WAIT','NO_TRADE']}, setup_type:{type:'string'},
    timeframe_summary: {
      type:'object',additionalProperties:false,
      properties:Object.fromEntries(TIMEFRAMES.map(tf=>[tf,{type:'string'}])),required:TIMEFRAMES
    },
    observations: {
      type:'array',maxItems:20,items:{type:'object',additionalProperties:false,properties:{
        type:{type:'string',enum:['OBSERVED','INFERRED']},timeframe:{type:'string',enum:[...TIMEFRAMES,'unknown']},evidence:{type:'string'}
      },required:['type','timeframe','evidence']}
    },
    conflicts:{type:'array',items:{type:'string'},maxItems:12},bull_case:caseSchema,bear_case:caseSchema,
    risk_notes:{type:'array',items:{type:'string'},maxItems:12},uncertainties:{type:'array',items:{type:'string'},maxItems:12},explanation:{type:'string'}
  },
  required:['asset','bias','ai_verdict','setup_type','timeframe_summary','observations','conflicts','bull_case','bear_case','risk_notes','uncertainties','explanation']
};
const chatSchema = {
  type:'object',additionalProperties:false,
  properties:{answer:{type:'string'},referenced_evidence:{type:'array',items:{type:'string'},maxItems:10},uncertainties:{type:'array',items:{type:'string'},maxItems:8}},
  required:['answer','referenced_evidence','uncertainties']
};

function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});
}
function safeText(value,max=2000) { return String(value==null?'':value).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max); }
function safeAsset(value) { const asset=safeText(value,15).toUpperCase(); return /^[A-Z0-9]{2,12}$/.test(asset)?asset:'UNKNOWN'; }
function allowedOrigins(env) {
  return [...new Set([...(safeText(env.ALLOWED_ORIGINS,1200)?safeText(env.ALLOWED_ORIGINS,1200).split(',').map(v=>v.trim()).filter(Boolean):[]),...DEFAULT_ORIGINS])];
}
function corsHeaders(request,env) {
  const origin=request.headers.get('origin')||'';
  return allowedOrigins(env).includes(origin)?{'access-control-allow-origin':origin,'vary':'Origin','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type,x-market-edge-token','access-control-max-age':'86400'}:{};
}
function isAllowedOrigin(request,env) {
  const origin=request.headers.get('origin');
  return !origin || allowedOrigins(env).includes(origin);
}
function rateLimit(request,env,now=Date.now()) {
  const limit=Math.max(1,Number(env.RATE_LIMIT_PER_MINUTE)||12),key=request.headers.get('cf-connecting-ip')||request.headers.get('x-forwarded-for')||'unknown';
  const bucket=rateBuckets.get(key);
  if (!bucket||now-bucket.started>=60000) { rateBuckets.set(key,{started:now,count:1}); return {allowed:true,remaining:limit-1}; }
  bucket.count+=1;
  if (rateBuckets.size>5000) for (const [bucketKey,value] of rateBuckets) if(now-value.started>120000) rateBuckets.delete(bucketKey);
  return {allowed:bucket.count<=limit,remaining:Math.max(0,limit-bucket.count),retryAfter:Math.ceil((60000-(now-bucket.started))/1000)};
}
function estimateDataBytes(dataUrl) {
  const comma=dataUrl.indexOf(','); if(comma<0) return 0;
  const base64=dataUrl.slice(comma+1).replace(/\s/g,''); return Math.floor(base64.length*3/4)-(base64.endsWith('==')?2:base64.endsWith('=')?1:0);
}
function sanitizeQuant(input) {
  if (!input||typeof input!=='object') return null;
  const decision=['TAKE TRADE','WAIT','NO TRADE','ANALYSIS UNAVAILABLE'].includes(input.decision)?input.decision:'ANALYSIS UNAVAILABLE';
  return {
    asset:safeAsset(input.asset),price:Number.isFinite(Number(input.price))?Number(input.price):null,decision,
    direction:['long','short'].includes(input.direction)?input.direction:null,strategy:safeText(input.strategy,120),regime:safeText(input.regime,100),macroRegime:safeText(input.macroRegime,100),
    quality:Number.isFinite(Number(input.quality))?Number(input.quality):null,reason:safeText(input.reason,700),entry:Number.isFinite(Number(input.entry))?Number(input.entry):null,
    entryZone:input.entryZone&&Number.isFinite(Number(input.entryZone.low))&&Number.isFinite(Number(input.entryZone.high))?{low:Number(input.entryZone.low),high:Number(input.entryZone.high)}:null,
    stop:Number.isFinite(Number(input.stop))?Number(input.stop):null,target1:Number.isFinite(Number(input.target1))?Number(input.target1):null,target2:Number.isFinite(Number(input.target2))?Number(input.target2):null,
    invalidationCondition:safeText(input.invalidationCondition,500),alignment:input.alignment&&typeof input.alignment==='object'?input.alignment:null,
    timeframes:input.timeframes&&typeof input.timeframes==='object'?input.timeframes:{},oos:input.oos&&typeof input.oos==='object'?input.oos:null
  };
}
function sanitizeImages(input) {
  if (input==null) return [];
  if (!Array.isArray(input)) throw new Error('Images must be a list');
  if (input.length>MAX_IMAGES) throw new Error(`Use no more than ${MAX_IMAGES} chart images`);
  let total=0;
  return input.map((image,index)=>{
    const type=safeText(image?.type,40).toLowerCase(),timeframe=safeText(image?.timeframe,5),dataUrl=safeText(image?.dataUrl,2_500_000);
    if(!ALLOWED_IMAGE_TYPES.includes(type)) throw new Error(`Image ${index+1} has an unsupported type`);
    if(!TIMEFRAMES.includes(timeframe)) throw new Error(`Image ${index+1} needs a supported timeframe`);
    if(!dataUrl.startsWith(`data:${type};base64,`)) throw new Error(`Image ${index+1} data does not match its declared type`);
    const bytes=estimateDataBytes(dataUrl); if(!bytes||bytes>MAX_IMAGE_BYTES) throw new Error(`Image ${index+1} is empty or too large`);
    total+=bytes; if(total>MAX_TOTAL_IMAGE_BYTES) throw new Error('Combined images are too large');
    return {type,timeframe,dataUrl,bytes};
  });
}
function constantTimeEqual(left,right) {
  const a=new TextEncoder().encode(String(left||'')),b=new TextEncoder().encode(String(right||''));
  let mismatch=a.length^b.length;
  for(let index=0;index<Math.max(a.length,b.length);index++) mismatch|=(a[index%Math.max(1,a.length)]||0)^(b[index%Math.max(1,b.length)]||0);
  return mismatch===0;
}
function sanitizeTradingViewAlert(payload,env,now=Date.now()) {
  if(!payload||typeof payload!=='object'||Array.isArray(payload)) throw Object.assign(new Error('Alert must be a JSON object'),{code:'TV_INVALID_ALERT'});
  const timestamp=Number(payload.timestamp),close=Number(payload.close),volume=Number(payload.volume),timeframe=safeText(payload.timeframe,4),exchange=safeText(payload.exchange,20).toUpperCase(),symbol=safeText(payload.symbol,24).toUpperCase();
  const alert={event_id:safeText(payload.event_id,120),symbol,exchange,timeframe,timestamp,close,volume,condition:safeText(payload.condition,180),state:safeText(payload.state,20).toUpperCase()};
  if(!alert.event_id) throw Object.assign(new Error('event_id is required'),{code:'TV_INVALID_ALERT'});
  if(!/^[A-Z0-9]{2,20}$/.test(symbol)) throw Object.assign(new Error('Invalid TradingView symbol'),{code:'TV_INVALID_ALERT'});
  const allowedExchanges=(safeText(env.TV_ALLOWED_EXCHANGES,200)||'BINANCE,COINBASE,KRAKEN,BYBIT').split(',').map(value=>value.trim().toUpperCase());
  if(!allowedExchanges.includes(exchange)) throw Object.assign(new Error('Unsupported TradingView exchange'),{code:'TV_INVALID_ALERT'});
  if(!TIMEFRAMES.includes(timeframe)) throw Object.assign(new Error('Unsupported TradingView timeframe'),{code:'TV_INVALID_ALERT'});
  if(!Number.isFinite(timestamp)||!Number.isFinite(close)||close<=0||!Number.isFinite(volume)||volume<0) throw Object.assign(new Error('Invalid TradingView numeric evidence'),{code:'TV_INVALID_ALERT'});
  if(!['CANDIDATE','WAIT','NO TRADE'].includes(alert.state)) throw Object.assign(new Error('Alert state must be CANDIDATE, WAIT or NO TRADE'),{code:'TV_INVALID_ALERT'});
  if(timestamp>now+60_000) throw Object.assign(new Error('Future TradingView alert rejected'),{code:'TV_FUTURE_ALERT'});
  const maxAge=Math.max(TRADINGVIEW_INTERVAL_MS[timeframe]*3,900_000);
  if(now-timestamp>maxAge) throw Object.assign(new Error('Stale TradingView alert rejected'),{code:'TV_STALE_ALERT'});
  return alert;
}
async function persistTradingViewEvidence(db,alert,now=Date.now()) {
  if(!db)return {storage:'unavailable'};
  const id=`tv-${alert.exchange}-${alert.symbol}-${alert.event_id}`.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,180);
  await db.prepare(`INSERT INTO tradingview_alert_evidence (id,event_id,asset,exchange,symbol,timeframe,alert_time,received_at,payload_json,state,immutable) VALUES (?,?,?,?,?,?,?,?,?,?,1)`).bind(id,alert.event_id,alert.symbol.replace(/(?:USDT|USD|PERP)$/,''),alert.exchange,alert.symbol,alert.timeframe,alert.timestamp,now,JSON.stringify(alert),alert.state).run();
  return {storage:'persisted',id};
}
async function acceptTradingViewAlert(request,env,payload,now=Date.now()) {
  if(!env.TV_WEBHOOK_TOKEN) throw Object.assign(new Error('TradingView webhook is disabled until its Worker secret is configured'),{status:503,code:'TV_NOT_CONFIGURED'});
  const url=new URL(request.url),provided=request.headers.get('x-market-edge-token')||url.searchParams.get('token')||'';
  if(!constantTimeEqual(provided,env.TV_WEBHOOK_TOKEN)) throw Object.assign(new Error('TradingView webhook authentication failed'),{status:401,code:'TV_AUTH_FAILED'});
  const alert=sanitizeTradingViewAlert(payload,env,now),key=`${alert.exchange}:${alert.symbol}:${alert.event_id}`;
  for(const [id,seenAt] of tradingViewEvents) if(now-seenAt>86_400_000) tradingViewEvents.delete(id);
  if(tradingViewEvents.has(key)) throw Object.assign(new Error('Duplicate TradingView alert rejected'),{status:409,code:'TV_DUPLICATE_ALERT'});
  tradingViewEvents.set(key,now);
  let stored={storage:'unavailable'};
  try { stored=await persistTradingViewEvidence(env.MARKET_EDGE_DB,alert,now); } catch(error) { throw Object.assign(new Error('TradingView evidence could not be persisted'),{status:503,code:'TV_STORAGE_UNAVAILABLE'}); }
  return {accepted:true,evidence:alert,storage:stored.storage,usage:'additional evidence only',execution:'disabled',deployment_verdict:'MANUAL LIVE DECISION SUPPORT / PAPER RESEARCH ONLY'};
}
function researchToken(request,env){
  if(!env.RESEARCH_INGEST_TOKEN)throw Object.assign(new Error('Research ingest is disabled until its Worker secret is configured'),{status:503,code:'RESEARCH_NOT_CONFIGURED'});
  const value=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  if(!constantTimeEqual(value,env.RESEARCH_INGEST_TOKEN))throw Object.assign(new Error('Research ingest authentication failed'),{status:401,code:'RESEARCH_AUTH_FAILED'});
}
function researchDecision(input){
  const asset=safeAsset(input?.asset),timestamp=Number(input?.timestamp),number=name=>Number(input?.[name]),required=['signal_price','preferred_entry','stop','tp1','tp2','rr'];
  if(!['BTC','ETH','SOL','XRP','DOGE','LTC'].includes(asset)||!Number.isFinite(timestamp)||timestamp<=0||required.some(name=>!Number.isFinite(number(name))))throw Object.assign(new Error('Invalid immutable decision payload'),{status:400,code:'RESEARCH_INVALID_DECISION'});
  const direction=input?.direction==='long'||input?.direction==='short'?input.direction:null,signalId=safeText(input?.signal_id,180),strategy=safeText(input?.strategy,120),datasetVersion=safeText(input?.dataset_version,80),sourceHash=safeText(input?.source_dataset_hash,120);
  if(!direction||!signalId||!strategy||!datasetVersion||!sourceHash||Math.abs(number('signal_price')-number('stop'))<=0)throw Object.assign(new Error('Incomplete immutable decision payload'),{status:400,code:'RESEARCH_INVALID_DECISION'});
  return {signalId,asset,timestamp,strategy,direction,regime:safeText(input?.regime,100)||'UNCLASSIFIED',quality:Number.isFinite(Number(input?.quality_score))?Number(input.quality_score):0,signal:number('signal_price'),entry:number('preferred_entry'),stop:number('stop'),tp1:number('tp1'),tp2:number('tp2'),rr:number('rr'),features:input?.features&&typeof input.features==='object'?input.features:{},targets:input?.targets&&typeof input.targets==='object'?input.targets:{status:'PENDING_OUTCOME'},datasetVersion,sourceHash};
}
async function researchIngest(request,env,payload,now=Date.now()){
  researchToken(request,env);
  if(payload?.operation!=='replay_commit')throw Object.assign(new Error('Unsupported research operation'),{status:400,code:'RESEARCH_INVALID_OPERATION'});
  const asset=safeAsset(payload.asset),version=safeText(payload.dataset_version,80),sourceHash=safeText(payload.source_dataset_hash,120),runId=safeText(payload.run_id,180),cursor=Number(payload.cursor_timestamp),last=Number(payload.last_processed_timestamp),processed=Number(payload.candles_processed),inputCursor=Number(payload.input_cursor);
  if(!['BTC','ETH','SOL','XRP','DOGE','LTC'].includes(asset)||version!=='EARLY-WINDOW-RESEARCH-V1'||!runId||!sourceHash||![cursor,last,processed,inputCursor].every(Number.isFinite)||processed<1||processed>288||last>=cursor)throw Object.assign(new Error('Invalid replay commit'),{status:400,code:'RESEARCH_INVALID_COMMIT'});
  const decisions=(Array.isArray(payload.decision_points)?payload.decision_points:[]);if(decisions.length>16)throw Object.assign(new Error('Too many decisions in one commit'),{status:413,code:'RESEARCH_COMMIT_TOO_LARGE'});
  const clean=decisions.map(researchDecision);if(clean.some(row=>row.asset!==asset||row.datasetVersion!==version||row.sourceHash!==sourceHash||row.timestamp<inputCursor||row.timestamp>=cursor))throw Object.assign(new Error('Decision does not belong to this replay window'),{status:400,code:'RESEARCH_WINDOW_MISMATCH'});
  const statements=clean.map(row=>env.MARKET_EDGE_DB.prepare(`INSERT OR IGNORE INTO historical_decision_points (signal_id,asset,timestamp,strategy,direction,regime,quality_score,signal_price,preferred_entry,stop,tp1,tp2,rr,features_json,targets_json,dataset_version,source_dataset_hash,created_at,immutable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(row.signalId,row.asset,row.timestamp,row.strategy,row.direction,row.regime,row.quality,row.signal,row.entry,row.stop,row.tp1,row.tp2,row.rr,JSON.stringify(row.features),JSON.stringify(row.targets),row.datasetVersion,row.sourceHash,now));
  if(statements.length)await env.MARKET_EDGE_DB.batch(statements);
  const written=Number((await env.MARKET_EDGE_DB.prepare(`SELECT COUNT(*) AS count FROM historical_decision_points WHERE asset=? AND dataset_version=? AND created_at=?`).bind(asset,version,now).first())?.count)||0;
  const resolved=clean.filter(row=>row.targets?.status==='RESOLVED').length;
  await env.MARKET_EDGE_DB.prepare(`INSERT INTO replay_states (asset,dataset_version,source_dataset_hash,status,cursor_timestamp,last_processed_timestamp,candles_processed,decision_points_written,targets_written,started_at,updated_at,last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(asset) DO UPDATE SET source_dataset_hash=excluded.source_dataset_hash,status='RUNNING',cursor_timestamp=excluded.cursor_timestamp,last_processed_timestamp=excluded.last_processed_timestamp,candles_processed=replay_states.candles_processed+excluded.candles_processed,decision_points_written=replay_states.decision_points_written+excluded.decision_points_written,targets_written=replay_states.targets_written+excluded.targets_written,updated_at=excluded.updated_at,last_error=NULL`).bind(asset,version,sourceHash,'RUNNING',cursor,last,processed,written,resolved,Number(payload.started_at)||now,now).run();
  const allowedMetrics=['providerRequests','provider429s','retries','bytesTransferred','fetchMs','cacheLoadMs','cacheCandles','candlesFetched','mtfMs','quantMs','outcomeMs','ingestMs','evaluations','signals','chunks','totalMs'],detailMetrics=Object.fromEntries(allowedMetrics.map(key=>[key,Number(payload?.detail?.metrics?.[key])||0]));
  const dataset=await materializeDataset(env.MARKET_EDGE_DB,now),detail={provider:safeText(payload?.detail?.provider,40),symbol:safeText(payload?.detail?.symbol,24),received_candles:Number(payload?.detail?.received_candles)||0,known_btc_checked:payload?.detail?.known_btc_checked===true,metrics:detailMetrics};
  await env.MARKET_EDGE_DB.prepare(`INSERT OR REPLACE INTO research_runs (id,runner,stage,asset,status,input_cursor,output_cursor,candles_processed,decision_points_written,outcomes_resolved,detail_json,started_at,completed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(runId,'github-actions-node','replay',asset,'COMPLETE',inputCursor,cursor,processed,written,resolved,JSON.stringify(detail),Number(payload.started_at)||now,now,now).run();
  return {accepted:true,run_id:runId,asset,cursor_timestamp:cursor,candles_processed:processed,decision_points_written:written,outcomes_resolved:resolved,dataset};
}
async function mlDataset(request,env,url){
  researchToken(request,env);const id=safeText(url.searchParams.get('id'),80)||'EARLY-WINDOW-RESEARCH-V1';
  const dataset=await env.MARKET_EDGE_DB.prepare(`SELECT id,dataset_hash,date_start,date_end,feature_schema_json,target_schema_json,summary_json,created_at,status FROM research_datasets WHERE id=?`).bind(id).first();
  if(!dataset||dataset.status!=='READY')throw Object.assign(new Error('Requested research dataset is not ready'),{status:409,code:'ML_DATASET_NOT_READY'});
  const rows=(await env.MARKET_EDGE_DB.prepare(`SELECT signal_id,asset,timestamp,strategy,direction,regime,quality_score,rr,features_json,targets_json FROM historical_decision_points WHERE dataset_version=? AND targets_json LIKE '%RESOLVED%' ORDER BY timestamp`).bind(id).all()).results||[];
  return {dataset,rows};
}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function stableHash(value){let hash=0x811c9dc5,text=stableJson(value);for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,0x01000193);}return(hash>>>0).toString(16).padStart(8,'0');}
function resolvedMlRows(rows){return(rows||[]).filter(row=>{let targets={};try{targets=JSON.parse(row.targets_json||'{}');}catch{}return String(targets.status||'').toUpperCase()==='RESOLVED'&&(targets.TP1_BEFORE_SL===true||targets.TP1_BEFORE_SL===false)&&Number.isFinite(Number(targets.FINAL_R))&&safeText(row.signal_id,180);}).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)||String(a.signal_id).localeCompare(String(b.signal_id)));}
async function mlGenerationStatus(request,env){
  researchToken(request,env);const [generations,rows,models]=await Promise.all([
    env.MARKET_EDGE_DB.prepare(`SELECT dataset_id,dataset_hash,row_ids_json,row_count,new_row_count,created_at FROM ml_dataset_generations ORDER BY created_at DESC LIMIT 1`).all(),
    env.MARKET_EDGE_DB.prepare(`SELECT signal_id,timestamp,targets_json FROM historical_decision_points WHERE dataset_version=? AND targets_json LIKE '%RESOLVED%' ORDER BY timestamp`).bind('EARLY-WINDOW-RESEARCH-V1').all(),
    env.MARKET_EDGE_DB.prepare(`SELECT id,status,metadata_json,created_at FROM model_registry ORDER BY created_at DESC LIMIT 40`).all()
  ]);
  const latest=(generations?.results||[])[0]||null;let latestGeneration=null;if(latest){let rowIds=[];try{rowIds=JSON.parse(latest.row_ids_json||'[]');}catch{}const model=(models?.results||[]).find(item=>parseModelMetadata(item.metadata_json).datasetId===latest.dataset_id),metadata=model?parseModelMetadata(model.metadata_json):{};latestGeneration={datasetId:latest.dataset_id,datasetHash:latest.dataset_hash,rowIds,datasetN:Number(latest.row_count)||0,newRowCount:Number(latest.new_row_count)||0,createdAt:Number(latest.created_at)||null,generation:Number(metadata.generation)||0,modelId:model?.id||null,status:model?.status||'UNKNOWN'};}
  const eligible=resolvedMlRows(rows?.results);const seen=new Set(latestGeneration?.rowIds||[]);return{threshold:Math.max(1,Number(env.ML_NEW_ROW_THRESHOLD)||10),currentEligibleN:eligible.length,newRowsSinceLastGeneration:latestGeneration?eligible.filter(row=>!seen.has(row.signal_id)).length:eligible.length,latestGeneration};
}
async function mlGenerationIngest(request,env,payload,now=Date.now()){
  researchToken(request,env);const dataset=payload?.dataset&&typeof payload.dataset==='object'?payload.dataset:null,models=Array.isArray(payload?.models)?payload.models:[],runId=safeText(payload?.run_id,180);if(!dataset||!runId||models.length<1||models.length>4)throw Object.assign(new Error('Invalid autonomous ML generation payload'),{status:400,code:'ML_GENERATION_INVALID'});
  const datasetId=safeText(dataset.id,180),datasetHash=safeText(dataset.datasetHash,120),sourceDatasetId=safeText(dataset.sourceDatasetId,80),sourceDatasetHash=safeText(dataset.sourceDatasetHash,120),rowIds=Array.isArray(dataset.rowIds)?dataset.rowIds.map(id=>safeText(id,180)).filter(Boolean):[],rowCount=Number(dataset.rowCount),newRowCount=Number(dataset.newRowCount),dateStart=Number(dataset.dateStart),dateEnd=Number(dataset.dateEnd),featureSchema=safeText(dataset.featureSchema,120),targetSchema=safeText(dataset.targetSchema,120);
  if(!datasetId||!datasetHash||sourceDatasetId!=='EARLY-WINDOW-RESEARCH-V1'||!sourceDatasetHash||!rowIds.length||new Set(rowIds).size!==rowIds.length||rowCount!==rowIds.length||!Number.isInteger(newRowCount)||newRowCount<0||![dateStart,dateEnd].every(Number.isFinite)||dateStart>dateEnd||!featureSchema||!targetSchema)throw Object.assign(new Error('Invalid immutable dataset metadata'),{status:400,code:'ML_DATASET_INVALID'});
  const [source,found]=await Promise.all([env.MARKET_EDGE_DB.prepare(`SELECT dataset_hash,status FROM research_datasets WHERE id=?`).bind(sourceDatasetId).first(),env.MARKET_EDGE_DB.prepare(`SELECT signal_id,timestamp,asset,strategy,direction,regime,quality_score,rr,features_json,targets_json FROM historical_decision_points WHERE dataset_version=? AND targets_json LIKE '%RESOLVED%' ORDER BY timestamp`).bind(sourceDatasetId).all()]);if(!source||source.status!=='READY'||source.dataset_hash!==sourceDatasetHash)throw Object.assign(new Error('Source dataset is unavailable or changed'),{status:409,code:'ML_SOURCE_DATASET_MISMATCH'});
  const rows=resolvedMlRows(found?.results),actualIds=rows.map(row=>row.signal_id);if(stableJson(actualIds)!==stableJson(rowIds))throw Object.assign(new Error('Dataset rows are not the complete current resolved observation set'),{status:409,code:'ML_DATASET_ROWS_MISMATCH'});const parseJson=value=>{try{return JSON.parse(value||'{}');}catch{return{};}},expectedHash=stableHash({sourceDatasetHash,featureSchema,targetSchema,rows:rows.map(row=>({id:row.signal_id,time:Number(row.timestamp),asset:row.asset,strategy:row.strategy,direction:row.direction,regime:row.regime,quality:Number(row.quality_score),rr:Number(row.rr),features:parseJson(row.features_json),targets:parseJson(row.targets_json)}))});if(datasetHash!==expectedHash)throw Object.assign(new Error('Dataset hash does not match immutable source rows'),{status:409,code:'ML_DATASET_HASH_MISMATCH'});
  const clean=models.map(model=>({id:safeText(model?.id,180),status:safeText(model?.status,20),algorithm:safeText(model?.algorithm,100),metadata:model?.metadata&&typeof model.metadata==='object'?model.metadata:null}));if(clean.some(model=>!model.id||!['CHALLENGER','REJECTED'].includes(model.status)||!model.algorithm||!model.metadata||model.metadata.datasetHash!==datasetHash||model.metadata.datasetId!==datasetId||Number(model.metadata.datasetN)!==rowCount||!['TP1_BEFORE_SL','FINAL_R'].includes(model.metadata.target)||model.metadata.status==='CHAMPION'))throw Object.assign(new Error('Autonomous ML candidate metadata is invalid'),{status:400,code:'ML_GENERATION_MODEL_INVALID'});
  const statements=[env.MARKET_EDGE_DB.prepare(`INSERT OR IGNORE INTO ml_dataset_generations (dataset_id,dataset_hash,source_dataset_id,source_dataset_hash,row_ids_json,row_count,new_row_count,date_start,date_end,feature_schema_version,target_schema_version,created_at,immutable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(datasetId,datasetHash,sourceDatasetId,sourceDatasetHash,JSON.stringify(rowIds),rowCount,newRowCount,dateStart,dateEnd,featureSchema,targetSchema,now),...clean.map(model=>env.MARKET_EDGE_DB.prepare(`INSERT OR IGNORE INTO model_registry (id,status,algorithm,dataset_hash,metadata_json,created_at,immutable) VALUES (?,?,?,?,?,?,1)`).bind(model.id,model.status,model.algorithm,datasetHash,JSON.stringify(model.metadata),now)),env.MARKET_EDGE_DB.prepare(`INSERT OR REPLACE INTO research_runs (id,runner,stage,asset,status,input_cursor,output_cursor,candles_processed,decision_points_written,outcomes_resolved,detail_json,started_at,completed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(runId,'github-actions-node','ml-generation','ALL',clean.every(model=>model.status==='CHALLENGER')?'CHALLENGER':'REJECTED',null,null,0,0,rowCount,JSON.stringify({datasetId,datasetHash,rowCount,newRowCount,models:clean.map(model=>({id:model.id,status:model.status,rejectionReason:model.metadata.rejectionReason||null})),autoChampionPromotion:false}),now,now,now)];await env.MARKET_EDGE_DB.batch(statements);return{accepted:true,datasetId,datasetHash,stored:clean.length,statuses:Object.fromEntries(clean.map(model=>[model.id,model.status])),autoChampionPromotion:false};
}
async function mlIngest(request,env,payload,now=Date.now()){
  if(payload?.operation==='ml_generation_commit')return mlGenerationIngest(request,env,payload,now);researchToken(request,env);if(payload?.operation!=='ml_research_commit')throw Object.assign(new Error('Unsupported ML research operation'),{status:400,code:'ML_INVALID_OPERATION'});
  const datasetId=safeText(payload.dataset_id,80),datasetHash=safeText(payload.dataset_hash,120),datasetN=Number(payload.dataset_n),models=Array.isArray(payload.models)?payload.models:[];
  if(datasetId!=='EARLY-WINDOW-RESEARCH-V1'||!datasetHash||!Number.isInteger(datasetN)||datasetN<20||models.length<1||models.length>8)throw Object.assign(new Error('Invalid ML research commit'),{status:400,code:'ML_INVALID_COMMIT'});
  const dataset=await env.MARKET_EDGE_DB.prepare(`SELECT dataset_hash,summary_json,status FROM research_datasets WHERE id=?`).bind(datasetId).first();let summary={};try{summary=JSON.parse(dataset?.summary_json||'{}');}catch{}
  if(!dataset||dataset.status!=='READY'||dataset.dataset_hash!==datasetHash||Number(summary.n)!==datasetN)throw Object.assign(new Error('ML commit does not match immutable Dataset V1'),{status:409,code:'ML_DATASET_MISMATCH'});
  const validStatus=['REJECTED','RESEARCH','SHADOW','CHALLENGER','CHAMPION','RETIRED'],clean=models.map(model=>({id:safeText(model?.id,180),status:safeText(model?.status,20),algorithm:safeText(model?.algorithm,100),metadata:model?.metadata&&typeof model.metadata==='object'?model.metadata:null}));
  if(clean.some(model=>!model.id||!validStatus.includes(model.status)||!model.algorithm||!model.metadata||model.metadata.datasetHash!==datasetHash||model.metadata.datasetN!==datasetN||!['TP1_BEFORE_SL','FINAL_R'].includes(model.metadata.target)||model.status==='CHAMPION'||model.status==='CHALLENGER'))throw Object.assign(new Error('ML registry promotion or metadata is invalid'),{status:400,code:'ML_INVALID_MODEL'});
  await env.MARKET_EDGE_DB.batch(clean.map(model=>env.MARKET_EDGE_DB.prepare(`INSERT OR IGNORE INTO model_registry (id,status,algorithm,dataset_hash,metadata_json,created_at,immutable) VALUES (?,?,?,?,?,?,1)`).bind(model.id,model.status,model.algorithm,datasetHash,JSON.stringify(model.metadata),now)));
  return {accepted:true,datasetHash,stored:clean.length,statuses:Object.fromEntries(clean.map(model=>[model.id,model.status]))};
}
async function activeMlModel(db){
  const rows=(await db.prepare(`SELECT id,status,algorithm,dataset_hash,metadata_json,created_at FROM model_registry WHERE status IN ('RESEARCH','SHADOW','CHAMPION') ORDER BY CASE status WHEN 'CHAMPION' THEN 3 WHEN 'SHADOW' THEN 2 ELSE 1 END DESC, created_at DESC LIMIT 20`).all()).results||[];
  const parsed=rows.map(row=>{let metadata={};try{metadata=JSON.parse(row.metadata_json||'{}');}catch{}return{row,metadata};}),selected=parsed.find(item=>item.metadata.target==='TP1_BEFORE_SL')||parsed[0];
  if(!selected)return {available:false,status:'UNAVAILABLE'};
  const {row,metadata}=selected;
  const model=metadata?.model;
  if(!model||!Array.isArray(model.featureNames)||!Array.isArray(model.coefficients)||!Array.isArray(model.means)||!Array.isArray(model.stds))return {available:false,status:row.status,id:row.id,reason:'Stored model artifact is incomplete'};
  return {available:true,id:row.id,status:row.status,algorithm:row.algorithm,datasetHash:row.dataset_hash,createdAt:row.created_at,target:metadata.target||null,calibration:metadata.calibration||null,model};
}
function forwardSelectionPick(value){
  if(!value||typeof value!=='object')return null;
  const asset=safeAsset(value.asset),direction=safeText(value.direction,12),strategy=safeText(value.strategy,120),score=Number(value.score);
  if(!asset||asset==='UNKNOWN'||!['long','short'].includes(direction)||!strategy)return null;
  return {asset,direction,strategy,score:Number.isFinite(score)?score:null};
}
function forwardSelectionRecord(payload){
  const selection=payload?.selection&&typeof payload.selection==='object'?payload.selection:{},timestamp=Number(selection.timestamp),id=safeText(selection.id,180),quantOnly=forwardSelectionPick(selection.quantOnly),mlAssisted=forwardSelectionPick(selection.mlAssisted);
  if(!id||!Number.isFinite(timestamp)||timestamp<=0||!quantOnly||!mlAssisted||selection.status!=='FORWARD / PENDING')throw Object.assign(new Error('Invalid pre-outcome selection snapshot'),{status:400,code:'FORWARD_SELECTION_INVALID'});
  return {id,timestamp,quantOnly,mlAssisted};
}
async function forwardSelectionIngest(payload,env,now=Date.now()){
  const record=forwardSelectionRecord(payload);
  await env.MARKET_EDGE_DB.prepare(`INSERT OR IGNORE INTO ml_forward_selection_snapshots (selection_id,timestamp,quant_only_json,ml_assisted_json,outcome_json,created_at,resolved_at,immutable) VALUES (?,?,?,?,NULL,?,NULL,1)`).bind(record.id,record.timestamp,JSON.stringify(record.quantOnly),JSON.stringify(record.mlAssisted),now).run();
  return {accepted:true,selectionId:record.id,status:'FORWARD / PENDING',immutable:true};
}
function communityPaperEvent(payload){
  const kind=safeText(payload?.event_type,16).toUpperCase(),input=payload?.signal&&typeof payload.signal==='object'?payload.signal:{},id=safeText(input.id,96),asset=safeAsset(input.symbol),direction=safeText(input.direction,12),strategy=safeText(input.strategy,120),timestamp=Number(input.timestamp),entry=Number(input.entry),stop=Number(input.stop),target1=Number(input.target1),target2=Number(input.target2),rr1=Number(input.rr1),rr2=Number(input.rr2);
  if(!['SIGNAL','OUTCOME'].includes(kind)||!id||!['long','short'].includes(direction)||!strategy||!Number.isFinite(timestamp)||timestamp<=0||![entry,stop,target1,target2,rr1,rr2].every(Number.isFinite))throw Object.assign(new Error('Invalid anonymous paper event'),{status:400,code:'COMMUNITY_EVENT_INVALID'});
  if((direction==='long'&&!(stop<entry&&target1>entry&&target2>=target1))||(direction==='short'&&!(stop>entry&&target1<entry&&target2<=target1)))throw Object.assign(new Error('Invalid anonymous paper price ordering'),{status:400,code:'COMMUNITY_EVENT_INVALID'});
  const signal={id,asset,direction,strategy,regime:safeText(input.regime,100)||'UNCLASSIFIED',timestamp,entry,stop,target1,target2,rr1,rr2,quality:Number.isFinite(Number(input.quality))?Number(input.quality):null,datasetHash:safeText(input.datasetHash,80)||null,engineVersion:safeText(input.engineVersion,40)||null,sourceCount:Number.isFinite(Number(input.sourceCount))?Number(input.sourceCount):null};
  if(kind==='SIGNAL')return{eventId:`SIGNAL:${id}`,kind,signal,outcome:null};
  const source=payload?.outcome&&typeof payload.outcome==='object'?payload.outcome:{},status=safeText(source.status,20),resultR=Number(source.resultR),closedAt=Number(source.closedAt),barsHeld=Number(source.barsHeld),costR=Number(source.costR);
  if(!['win','loss','partial','timed'].includes(status)||!Number.isFinite(resultR)||!Number.isFinite(closedAt)||closedAt<=timestamp||!Number.isFinite(barsHeld)||barsHeld<1)throw Object.assign(new Error('Invalid anonymous paper outcome'),{status:400,code:'COMMUNITY_EVENT_INVALID'});
  const outcome={status,resultR,closedAt,barsHeld,tp1Hit:source.tp1Hit===true,costR:Number.isFinite(costR)?costR:null};return{eventId:`OUTCOME:${id}:${closedAt}`,kind,signal,outcome};
}
async function communityPaperIngest(payload,env,now=Date.now()){
  const event=communityPaperEvent(payload);await env.MARKET_EDGE_DB.prepare(`INSERT OR IGNORE INTO community_paper_events (event_id,event_type,client_signal_id,signal_json,outcome_json,created_at,immutable) VALUES (?,?,?,?,?,?,1)`).bind(event.eventId,event.kind,event.signal.id,JSON.stringify(event.signal),event.outcome?JSON.stringify(event.outcome):null,now).run();return{accepted:true,event_id:event.eventId,event_type:event.kind,privacy:'anonymous-paper-research-only'};
}
function parseModelMetadata(value){try{return JSON.parse(value||'{}');}catch{return{};}}
async function researchStatus(db){const [progress,run,models,shadow,generation]=await Promise.all([replayProgress(db),db.prepare(`SELECT id,runner,stage,asset,status,input_cursor,output_cursor,candles_processed,decision_points_written,outcomes_resolved,detail_json,started_at,completed_at FROM research_runs ORDER BY created_at DESC LIMIT 1`).first().catch(()=>null),db.prepare(`SELECT id,status,algorithm,dataset_hash,metadata_json,created_at FROM model_registry ORDER BY created_at DESC LIMIT 40`).all().catch(()=>({results:[]})),db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN outcome_json IS NOT NULL THEN 1 ELSE 0 END) AS resolved FROM ml_shadow_predictions`).first().catch(()=>null),db.prepare(`SELECT dataset_id,dataset_hash,row_count,new_row_count,created_at FROM ml_dataset_generations ORDER BY created_at DESC LIMIT 1`).first().catch(()=>null)]),modelRows=models?.results||[],counts=Object.fromEntries(['REJECTED','RESEARCH','SHADOW','CHALLENGER','CHAMPION','RETIRED'].map(status=>[status,modelRows.filter(model=>model.status===status).length])),currentShadow=modelRows.find(model=>model.status==='SHADOW')||null,currentChampion=modelRows.find(model=>model.status==='CHAMPION')||null,latestCandidate=modelRows.find(model=>['CHALLENGER','REJECTED'].includes(model.status))||null,mlStatus=currentChampion?'CHAMPION':currentShadow?'SHADOW':counts.RESEARCH?'RESEARCH':'DISABLED',recentModels=modelRows.slice(0,6).map(model=>{let metadata={};try{metadata=JSON.parse(model.metadata_json||'{}');}catch{}return{id:model.id,status:model.status,algorithm:model.algorithm,datasetHash:model.dataset_hash,createdAt:model.created_at,target:metadata.target||null,oosN:Number(metadata.oosN)||0,metrics:metadata.metrics||null,baselineComparison:metadata.baselineComparison||null,calibration:metadata.calibration||null,rejectionReason:metadata.rejectionReason||null,generation:Number(metadata.generation)||null};}),latestCandidateMeta=latestCandidate?parseModelMetadata(latestCandidate.metadata_json):{},generationInfo={datasetId:generation?.dataset_id||null,datasetHash:generation?.dataset_hash||null,datasetN:Number(generation?.row_count)||0,newRowCount:Number(generation?.new_row_count)||0,createdAt:Number(generation?.created_at)||null,newRowsSinceLastGeneration:Math.max(0,(Number(progress.totalResolvedTargets)||0)-(Number(generation?.row_count)||0)),threshold:10,latestModelId:latestCandidate?.id||null,latestStatus:latestCandidate?.status||'NOT ENOUGH NEW DATA',generation:Number(latestCandidateMeta.generation)||0,rejectionReason:latestCandidateMeta.rejectionReason||null};return {...progress,lastResearchRun:run||null,runner:'github-actions-node',ml:{status:mlStatus,sampleN:progress.totalResolvedTargets,models:counts,recentModels,currentShadow:currentShadow?{id:currentShadow.id,algorithm:currentShadow.algorithm,datasetHash:currentShadow.dataset_hash}:null,currentChampion:currentChampion?{id:currentChampion.id,algorithm:currentChampion.algorithm,datasetHash:currentChampion.dataset_hash}:null,shadowPredictions:Number(shadow?.total)||0,resolvedShadowPredictions:Number(shadow?.resolved)||0,generation:generationInfo}};}
function chartNumber(value){const number=Number(value);return Number.isFinite(number)?number:null;}
function chartStrategyLabel(value){return safeText(value,120).toLowerCase().replace(/(^|[\s-])([a-z])/g,(_,prefix,letter)=>`${prefix}${letter.toUpperCase()}`);}
function chartTargets(value){
  let targets={};try{targets=JSON.parse(value||'{}');}catch{}
  const status=safeText(targets?.status,32).toUpperCase();
  return {
    status:['RESOLVED','PENDING_OUTCOME','PENDING'].includes(status)?status:'PENDING',
    tp1BeforeSl:targets?.TP1_BEFORE_SL===true?true:targets?.TP1_BEFORE_SL===false?false:null,
    finalR:chartNumber(targets?.FINAL_R),mfe:chartNumber(targets?.MFE),mae:chartNumber(targets?.MAE),
    breakoutFailure:targets?.BREAKOUT_FAILURE===true?true:targets?.BREAKOUT_FAILURE===false?false:null,
    resolutionTime:chartNumber(targets?.resolution_time||targets?.resolved_at||targets?.resolution_timestamp)
  };
}
function publicChartSignal(row){return {
  signalId:safeText(row.signal_id,180),asset:safeAsset(row.asset),timestamp:chartNumber(row.timestamp),
  strategy:chartStrategyLabel(row.strategy),direction:['long','short'].includes(row.direction)?row.direction:null,
  regime:safeText(row.regime,100),qualityScore:chartNumber(row.quality_score),signalPrice:chartNumber(row.signal_price),
  preferredEntry:chartNumber(row.preferred_entry),stop:chartNumber(row.stop),tp1:chartNumber(row.tp1),tp2:chartNumber(row.tp2),rr:chartNumber(row.rr),
  source:'RESEARCH',status:'HISTORICAL',outcome:chartTargets(row.targets_json)
};}
async function researchChart(db,asset,requestedAround,allSignals=false){
  const allowed=['BTC','ETH','SOL','XRP','DOGE','LTC']; if(!db||!allowed.includes(asset)) return {asset,candles:[],signals:[],dataHealth:'UNAVAILABLE'};
  const signalRows=(await db.prepare(`SELECT signal_id,asset,timestamp,strategy,direction,regime,quality_score,signal_price,preferred_entry,stop,tp1,tp2,rr,targets_json FROM historical_decision_points WHERE asset=? AND dataset_version='EARLY-WINDOW-RESEARCH-V1' ORDER BY timestamp DESC LIMIT 120`).bind(asset).all()).results||[];
  const signals=signalRows.map(publicChartSignal).filter(signal=>signal.timestamp&&signal.direction);
  const selected=Number.isFinite(requestedAround)&&requestedAround>0?requestedAround:(signals[0]?.timestamp||null);
  const window=300_000*720,signalTimes=signals.map(signal=>signal.timestamp),from=allSignals&&signalTimes.length?Math.min(...signalTimes)-window:selected?selected-window:0,to=allSignals&&signalTimes.length?Math.max(...signalTimes)+window:selected?selected+window:Date.now();
  let candleRows=[];
  if(selected) candleRows=(await db.prepare(`SELECT open_time,close_time,open,high,low,close,volume FROM canonical_candles WHERE asset=? AND exchange='COINBASE' AND interval='5m' AND open_time>=? AND open_time<=? ORDER BY open_time ASC LIMIT ?`).bind(asset,from,to,allSignals?5000:1500).all()).results||[];
  else candleRows=((await db.prepare(`SELECT open_time,close_time,open,high,low,close,volume FROM canonical_candles WHERE asset=? AND exchange='COINBASE' AND interval='5m' ORDER BY open_time DESC LIMIT 720`).bind(asset).all()).results||[]).reverse();
  const manifest=await db.prepare(`SELECT status,coverage,last_error FROM historical_dataset_manifests WHERE asset=? AND base_timeframe='5m' ORDER BY downloaded_at DESC LIMIT 1`).bind(asset).first().catch(()=>null);
  return {asset,timeframe:'5m',focusTimestamp:selected,candles:candleRows.map(row=>({time:chartNumber(row.open_time),closeTime:chartNumber(row.close_time),open:chartNumber(row.open),high:chartNumber(row.high),low:chartNumber(row.low),close:chartNumber(row.close),volume:chartNumber(row.volume)})).filter(row=>row.time&&row.open&&row.high&&row.low&&row.close&&row.volume!=null),signals,dataHealth:manifest?.status||'UNKNOWN',coverage:chartNumber(manifest?.coverage),warning:manifest?.last_error?safeText(manifest.last_error,180):null};
}
function extractOutputText(response) {
  if(typeof response?.output_text==='string') return response.output_text;
  for(const item of response?.output||[]) for(const content of item?.content||[]) if(content?.type==='output_text'&&typeof content.text==='string') return content.text;
  throw new Error('The model returned no structured text');
}
async function classifyOpenAIError(response) {
  const payload=await response.json().catch(()=>({})),upstreamCode=safeText(payload?.error?.code,100).toLowerCase();
  if(response.status===429) {
    if(upstreamCode==='credit_balance_exhausted') return {message:'OpenAI API credits are exhausted. Add credits in OpenAI billing, then try again.',code:'AI_CREDITS_EXHAUSTED'};
    if(['organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded'].includes(upstreamCode)) return {message:'The OpenAI API spend or usage limit has been reached. Raise the relevant limit, then try again.',code:'AI_SPEND_LIMIT'};
    if(upstreamCode==='insufficient_quota') return {message:'OpenAI API billing or quota needs attention before AI analysis can run.',code:'AI_QUOTA_REQUIRED'};
    return {message:'OpenAI API rate limit reached. Wait briefly, then try again.',code:'AI_RATE_LIMITED'};
  }
  if(response.status===401) return {message:'The OpenAI API key is invalid or inactive. Replace the Worker secret, then try again.',code:'AI_AUTH_FAILED'};
  if(response.status===403) return {message:'The OpenAI project or API key does not have access to this model.',code:'AI_ACCESS_DENIED'};
  if([408,409,500,502,503,504].includes(response.status)) return {message:'AI service is temporarily unavailable. Try again shortly.',code:'AI_UNAVAILABLE'};
  return {message:'AI request could not be completed.',code:'AI_REQUEST_FAILED'};
}
async function safetyIdentifier(request) {
  const source=`${request.headers.get('cf-connecting-ip')||''}|${request.headers.get('user-agent')||''}`;
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  return [...new Uint8Array(hash)].slice(0,16).map(value=>value.toString(16).padStart(2,'0')).join('');
}
async function openAIRequest({request,env,body,model,schema,name,instructions,fetchImpl}) {
  if(!env.OPENAI_API_KEY) throw Object.assign(new Error('AI backend is not configured'),{status:503,code:'AI_NOT_CONFIGURED'});
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.max(5000,Number(env.OPENAI_TIMEOUT_MS)||25000));
  try {
    const response=await fetchImpl('https://api.openai.com/v1/responses',{
      method:'POST',headers:{'authorization':`Bearer ${env.OPENAI_API_KEY}`,'content-type':'application/json'},signal:controller.signal,
      body:JSON.stringify({model,instructions,input:body,store:false,max_output_tokens:3000,reasoning:{effort:'low'},safety_identifier:await safetyIdentifier(request),text:{verbosity:'low',format:{type:'json_schema',name,strict:true,schema}}})
    });
    if(!response.ok) {
      const classified=await classifyOpenAIError(response);
      throw Object.assign(new Error(classified.message),{status:classified.code==='AI_REQUEST_FAILED'?502:503,code:classified.code});
    }
    const data=await response.json(),text=extractOutputText(data); let parsed;
    try { parsed=JSON.parse(text); } catch { throw Object.assign(new Error('AI returned malformed structured output'),{status:502,code:'AI_MALFORMED'}); }
    return {parsed,model:data.model||model,requestId:data.id||null};
  } catch(error) {
    if(error?.name==='AbortError') throw Object.assign(new Error('AI request timed out'),{status:504,code:'AI_TIMEOUT'});
    throw error;
  } finally { clearTimeout(timeout); }
}
function analysisInstructions() {
  return `You are the visual/context layer of Market Edge, a paper-trading research tool. The supplied quantitative result is the only source for numerical market facts. Never invent price, candles, performance, funding, exchange rules, or probabilities. Distinguish OBSERVED chart evidence from INFERRED interpretation. Compare all uploaded timeframes together: 1d/4h macro, 1h setup, 15m confirmation, 5m execution. One attractive lower-timeframe candle cannot override higher-timeframe conflict. If chart evidence is ambiguous, unavailable, conflicts with the quant result, or lacks confirmation, return WAIT or NO_TRADE. Entry zones and targets must be copied only from supplied quantitative levels; otherwise return empty arrays and UNKNOWN / NOT AVAILABLE. AI analysis cannot override a quantitative WAIT or NO TRADE and cannot change the PAPER TRADE ONLY deployment verdict.`;
}
function chatInstructions() {
  return `You are Market Edge AI's explanation layer. Answer only from the supplied quantitative snapshot, prior structured chart analysis, paper context, and question. Never invent live prices, unseen candles, statistics, or user history. State UNKNOWN / NOT AVAILABLE when evidence is absent. Explain disagreements and risk plainly. Do not promote a quantitative WAIT or NO TRADE into LONG or SHORT. The product remains PAPER TRADE ONLY.`;
}
async function analyze(request,env,payload,fetchImpl) {
  const quant=sanitizeQuant(payload.quant),images=sanitizeImages(payload.images),question=safeText(payload.question||'Analyse the current setup.',1500),asset=safeAsset(payload.asset||quant?.asset);
  const content=[{type:'input_text',text:JSON.stringify({task:'Compare all supplied charts and quantitative evidence, then return the structured visual assessment.',asset,question,quant,paperContext:payload.paperContext&&typeof payload.paperContext==='object'?payload.paperContext:null})}];
  images.forEach(image=>{content.push({type:'input_text',text:`Chart timeframe: ${image.timeframe}`});content.push({type:'input_image',image_url:image.dataUrl,detail:'auto'});});
  const result=await openAIRequest({request,env,model:env.VISION_MODEL||'gpt-5.6-terra',schema:analysisSchema,name:'market_edge_chart_analysis',instructions:analysisInstructions(),body:[{role:'user',content}],fetchImpl});
  return {analysis:result.parsed,model:result.model,request_id:result.requestId,image_count:images.length};
}
async function chat(request,env,payload,fetchImpl) {
  const quant=sanitizeQuant(payload.quant),question=safeText(payload.question,2000); if(!question) throw new Error('A question is required');
  const prior=payload.analysis&&typeof payload.analysis==='object'?payload.analysis:null,history=Array.isArray(payload.history)?payload.history.slice(-6).map(item=>({role:item.role==='assistant'?'assistant':'user',content:safeText(item.content,1000)})):[];
  const input=[...history,{role:'user',content:JSON.stringify({question,quant,priorChartAnalysis:prior,paperContext:payload.paperContext&&typeof payload.paperContext==='object'?payload.paperContext:null,explanationLevel:['beginner','intermediate','advanced'].includes(payload.level)?payload.level:'beginner'})}];
  const result=await openAIRequest({request,env,model:env.CHAT_MODEL||'gpt-5.6-luna',schema:chatSchema,name:'market_edge_chat_answer',instructions:chatInstructions(),body:input,fetchImpl});
  return {message:result.parsed,model:result.model,request_id:result.requestId};
}

export async function handleRequest(request,env={},ctx={},deps={}) {
  const fetchImpl=deps.fetch||fetch,cors=corsHeaders(request,env),url=new URL(request.url);
  if(request.method==='OPTIONS') return isAllowedOrigin(request,env)?new Response(null,{status:204,headers:cors}):json({error:{code:'ORIGIN_DENIED',message:'Origin is not allowed'}},403);
  if(!isAllowedOrigin(request,env)) return json({error:{code:'ORIGIN_DENIED',message:'Origin is not allowed'}},403,cors);
  if(request.method==='GET'&&url.pathname==='/health') {
    const [monitor,historical]=await Promise.all([latestMonitor(env.MARKET_EDGE_DB).catch(()=>({storage:'error',latestRun:null,states:[],events:[]})),latestHistorical(env.MARKET_EDGE_DB).catch(()=>({storage:'error',manifests:[]}))]);
    return json({ok:true,service:'market-edge-ai',configured:!!env.OPENAI_API_KEY,tradingview_webhook_configured:!!env.TV_WEBHOOK_TOKEN,monitor:{storage:monitor.storage,latest_run:monitor.latestRun,asset_states:monitor.states.length,engine_version:MONITOR_VERSION,execution:'disabled'},historical:{storage:historical.storage,manifests:historical.manifests.length,engine_version:HISTORICAL_VERSION,execution:'disabled'},vision_model:env.VISION_MODEL||'gpt-5.6-terra',chat_model:env.CHAT_MODEL||'gpt-5.6-luna'},200,cors);
  }
  if(request.method==='GET'&&url.pathname==='/v1/monitor/latest') return json(await latestMonitor(env.MARKET_EDGE_DB),200,cors);
  if(request.method==='GET'&&url.pathname==='/v1/research/historical') return json(await latestHistorical(env.MARKET_EDGE_DB),200,cors);
  if(request.method==='GET'&&url.pathname==='/v1/research/replay') return json(await replayProgress(env.MARKET_EDGE_DB),200,cors);
  if(request.method==='GET'&&url.pathname==='/v1/research/status') return json(await researchStatus(env.MARKET_EDGE_DB),200,cors);
  if(request.method==='GET'&&url.pathname==='/v1/research/ml/dataset') { try{return json(await mlDataset(request,env,url),200,cors);}catch(error){return json({error:{code:error.code||'ML_DATASET_ERROR',message:safeText(error.message,240)}},error.status||400,cors);} }
  if(request.method==='GET'&&url.pathname==='/v1/research/ml/generation-status') { try{return json(await mlGenerationStatus(request,env),200,cors);}catch(error){return json({error:{code:error.code||'ML_GENERATION_STATUS_ERROR',message:safeText(error.message,240)}},error.status||400,cors);} }
  if(request.method==='GET'&&url.pathname==='/v1/research/ml/active') return json(await activeMlModel(env.MARKET_EDGE_DB),200,cors);
  if(request.method==='GET'&&url.pathname==='/v1/research/chart') return json(await researchChart(env.MARKET_EDGE_DB,safeAsset(url.searchParams.get('asset')),Number(url.searchParams.get('around')),url.searchParams.get('range')==='all'),200,cors);
  if(request.method!=='POST'||!['/v1/analyze','/v1/chat','/v1/tradingview-alert','/v1/research/ingest','/v1/research/ml/ingest','/v1/research/forward-selections','/v1/community/paper-events'].includes(url.pathname)) return json({error:{code:'NOT_FOUND',message:'Endpoint not found'}},404,cors);
  const rate=rateLimit(request,env); if(!rate.allowed) return json({error:{code:'RATE_LIMITED',message:'Too many requests. Try again shortly.'}},429,{...cors,'retry-after':String(rate.retryAfter)});
  if(!String(request.headers.get('content-type')||'').toLowerCase().includes('application/json')) return json({error:{code:'UNSUPPORTED_MEDIA',message:'Use application/json'}},415,cors);
  const declared=Number(request.headers.get('content-length')||0); if(declared>MAX_BODY_BYTES) return json({error:{code:'REQUEST_TOO_LARGE',message:'Request is too large'}},413,cors);
  let payload;
  try { const text=await request.text(); if(new TextEncoder().encode(text).byteLength>MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large'),{status:413,code:'REQUEST_TOO_LARGE'}); payload=JSON.parse(text); }
  catch(error) { return json({error:{code:error.code||'BAD_JSON',message:error.message==='Request is too large'?error.message:'Request body must be valid JSON'}},error.status||400,cors); }
  try {
    const data=url.pathname==='/v1/analyze'?await analyze(request,env,payload,fetchImpl):url.pathname==='/v1/chat'?await chat(request,env,payload,fetchImpl):url.pathname==='/v1/tradingview-alert'?await acceptTradingViewAlert(request,env,payload,deps.now||Date.now()):url.pathname==='/v1/research/ml/ingest'?await mlIngest(request,env,payload,deps.now||Date.now()):url.pathname==='/v1/research/forward-selections'?await forwardSelectionIngest(payload,env,deps.now||Date.now()):url.pathname==='/v1/community/paper-events'?await communityPaperIngest(payload,env,deps.now||Date.now()):await researchIngest(request,env,payload,deps.now||Date.now());
    return json(data,200,{...cors,'x-ratelimit-remaining':String(rate.remaining)});
  } catch(error) {
    const status=error.status||(/too large/i.test(error.message)?413:400),code=error.code||(status===413?'REQUEST_TOO_LARGE':'INVALID_REQUEST');
    return json({error:{code,message:safeText(error.message||'Request failed',240)}},status,cors);
  }
}

export async function handleScheduled(controller,env={},ctx={},deps={}) {
  // Full historical work runs in GitHub Actions. Keeping this installed trigger
  // deliberately inert avoids Cloudflare Free's 10 ms Cron CPU ceiling without
  // removing the deployment-level schedule or affecting request-time APIs.
  return {status:'COMPLETE',scheduledAt:Number(controller?.scheduledTime)||Date.now(),executionDisabled:true,researchRunner:'github-actions-node',heavyReplay:'disabled'};
}

export default {fetch:handleRequest,scheduled:handleScheduled};
export {analysisSchema,chatSchema,sanitizeImages,sanitizeQuant,sanitizeTradingViewAlert,acceptTradingViewAlert,persistTradingViewEvidence,extractOutputText,communityPaperEvent,forwardSelectionRecord,forwardSelectionIngest,activeMlModel,resolvedMlRows,stableHash,MAX_BODY_BYTES};
