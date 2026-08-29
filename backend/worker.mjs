import {runMonitor, latestMonitor, MONITOR_VERSION, WATCHLIST} from './monitor-core.mjs';
import {runHistoricalBackfill,latestHistorical,HISTORICAL_VERSION,PRIORITY_ASSETS} from './historical-core.mjs';

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
  if(request.method!=='POST'||!['/v1/analyze','/v1/chat','/v1/tradingview-alert'].includes(url.pathname)) return json({error:{code:'NOT_FOUND',message:'Endpoint not found'}},404,cors);
  const rate=rateLimit(request,env); if(!rate.allowed) return json({error:{code:'RATE_LIMITED',message:'Too many requests. Try again shortly.'}},429,{...cors,'retry-after':String(rate.retryAfter)});
  if(!String(request.headers.get('content-type')||'').toLowerCase().includes('application/json')) return json({error:{code:'UNSUPPORTED_MEDIA',message:'Use application/json'}},415,cors);
  const declared=Number(request.headers.get('content-length')||0); if(declared>MAX_BODY_BYTES) return json({error:{code:'REQUEST_TOO_LARGE',message:'Request is too large'}},413,cors);
  let payload;
  try { const text=await request.text(); if(new TextEncoder().encode(text).byteLength>MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large'),{status:413,code:'REQUEST_TOO_LARGE'}); payload=JSON.parse(text); }
  catch(error) { return json({error:{code:error.code||'BAD_JSON',message:error.message==='Request is too large'?error.message:'Request body must be valid JSON'}},error.status||400,cors); }
  try {
    const data=url.pathname==='/v1/analyze'?await analyze(request,env,payload,fetchImpl):url.pathname==='/v1/chat'?await chat(request,env,payload,fetchImpl):await acceptTradingViewAlert(request,env,payload,deps.now||Date.now());
    return json(data,200,{...cors,'x-ratelimit-remaining':String(rate.remaining)});
  } catch(error) {
    const status=error.status||(/too large/i.test(error.message)?413:400),code=error.code||(status===413?'REQUEST_TOO_LARGE':'INVALID_REQUEST');
    return json({error:{code,message:safeText(error.message||'Request failed',240)}},status,cors);
  }
}

export async function handleScheduled(controller,env={},ctx={},deps={}) {
  const now=Number(controller?.scheduledTime)||Date.now(),slot=Math.floor(now/300_000),monitorWatchlist=deps.watchlist||WATCHLIST.slice((slot*4)%WATCHLIST.length,(slot*4)%WATCHLIST.length+4),historicalAssets=deps.historicalAssets||PRIORITY_ASSETS.slice((slot*2)%PRIORITY_ASSETS.length,(slot*2)%PRIORITY_ASSETS.length+2),operation=(async()=>{const monitor=await runMonitor({db:env.MARKET_EDGE_DB,fetchImpl:deps.fetch||fetch,now,watchlist:monitorWatchlist,throttleMs:deps.throttleMs??700});const historical=await runHistoricalBackfill({db:env.MARKET_EDGE_DB,fetchImpl:deps.fetch||fetch,now,assets:historicalAssets,days:deps.historicalDays,delay:deps.delay});return{...monitor,historical,scheduledScope:{monitorAssets:monitorWatchlist.map(item=>item.asset),historicalAssets}};})();
  if(ctx?.waitUntil) { ctx.waitUntil(operation); return {accepted:true,scheduledAt:now,execution:'disabled'}; }
  return operation;
}

export default {fetch:handleRequest,scheduled:handleScheduled};
export {analysisSchema,chatSchema,sanitizeImages,sanitizeQuant,sanitizeTradingViewAlert,acceptTradingViewAlert,persistTradingViewEvidence,extractOutputText,MAX_BODY_BYTES};
