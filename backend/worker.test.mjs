import assert from 'node:assert/strict';
import {handleRequest,handleScheduled} from './worker.mjs';

const env={OPENAI_API_KEY:'test-only',ALLOWED_ORIGINS:'https://jamalmusialla81-hub.github.io',RATE_LIMIT_PER_MINUTE:'1000'};
const quant={asset:'ETH',price:100,decision:'WAIT',direction:'long',strategy:'BREAKOUT + RETEST',regime:'BREAKOUT RETEST',reason:'Await 15m confirmation'};
const analysis={
  asset:'ETH',bias:'neutral',ai_verdict:'WAIT',setup_type:'breakout retest',timeframe_summary:{'5m':'not supplied','15m':'bounce','1h':'range','4h':'bearish','1d':'not supplied'},
  observations:[{type:'OBSERVED',timeframe:'15m',evidence:'Visible bounce'}],conflicts:['4h and 15m conflict'],
  bull_case:{trigger:'15m close above resistance',entry_zone:[],invalidation:'UNKNOWN / NOT AVAILABLE',targets:[]},
  bear_case:{trigger:'Bounce fails',entry_zone:[],invalidation:'UNKNOWN / NOT AVAILABLE',targets:[]},risk_notes:['Paper only'],uncertainties:['No 1d chart'],explanation:'Wait for alignment.'
};
function request(path,payload,headers={}) {
  return new Request(`https://market-edge-ai.test${path}`,{method:'POST',headers:{origin:'https://jamalmusialla81-hub.github.io','content-type':'application/json',...headers},body:JSON.stringify(payload)});
}
function openAIResponse(output=analysis,model='gpt-5.6-terra') {
  return new Response(JSON.stringify({id:'resp_test',model,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}),{status:200,headers:{'content-type':'application/json'}});
}

let response=await handleRequest(new Request('https://market-edge-ai.test/health',{headers:{origin:'https://jamalmusialla81-hub.github.io'}}),env,{},{});
assert.equal(response.status,200);assert.equal((await response.json()).configured,true);

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[]}),env,{}, {fetch:async()=>openAIResponse()});
assert.equal(response.status,200);let body=await response.json();assert.equal(body.analysis.ai_verdict,'WAIT');assert.equal(body.image_count,0);

const png='data:image/png;base64,'+Buffer.from('small-image').toString('base64');
response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[{type:'image/png',timeframe:'5m',dataUrl:png},{type:'image/png',timeframe:'4h',dataUrl:png}]}),env,{}, {fetch:async(_url,options)=>{const sent=JSON.parse(options.body);const images=sent.input[0].content.filter(item=>item.type==='input_image');assert.equal(images.length,2);return openAIResponse();}});
assert.equal(response.status,200);assert.equal((await response.json()).image_count,2);

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[{type:'image/gif',timeframe:'5m',dataUrl:'data:image/gif;base64,AAAA'}]}),env,{}, {fetch:async()=>openAIResponse()});
assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_REQUEST');

const oversized='data:image/png;base64,'+'A'.repeat(2_400_000);
response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[{type:'image/png',timeframe:'5m',dataUrl:oversized}]}),env,{}, {fetch:async()=>openAIResponse()});
assert.equal(response.status,413);

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[]}),env,{}, {fetch:async()=>new Response('unavailable',{status:503})});
assert.equal(response.status,503);assert.equal((await response.json()).error.code,'AI_UNAVAILABLE');

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[]}),env,{}, {fetch:async()=>new Response(JSON.stringify({error:{code:'credit_balance_exhausted'}}),{status:429,headers:{'content-type':'application/json'}})});
assert.equal(response.status,503);body=await response.json();assert.equal(body.error.code,'AI_CREDITS_EXHAUSTED');assert.match(body.error.message,/credits are exhausted/i);

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[]}),env,{}, {fetch:async()=>new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429,headers:{'content-type':'application/json'}})});
assert.equal(response.status,503);assert.equal((await response.json()).error.code,'AI_RATE_LIMITED');

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[]}),env,{}, {fetch:async()=>new Response(JSON.stringify({error:{code:'invalid_api_key'}}),{status:401,headers:{'content-type':'application/json'}})});
assert.equal(response.status,503);assert.equal((await response.json()).error.code,'AI_AUTH_FAILED');

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[]}),env,{}, {fetch:async()=>new Response(JSON.stringify({id:'bad',output:[{type:'message',content:[{type:'output_text',text:'not-json'}]}]}),{status:200,headers:{'content-type':'application/json'}})});
assert.equal(response.status,502);assert.equal((await response.json()).error.code,'AI_MALFORMED');

response=await handleRequest(request('/v1/analyze',{asset:'ETH',quant,images:[]}),env,{}, {fetch:async()=>{const error=new Error('aborted');error.name='AbortError';throw error;}});
assert.equal(response.status,504);assert.equal((await response.json()).error.code,'AI_TIMEOUT');

const chatOutput={answer:'WAIT because the 4h and 15m disagree.',referenced_evidence:['4h bearish','15m bounce'],uncertainties:['No 1d chart']};
response=await handleRequest(request('/v1/chat',{question:'Why wait?',quant,analysis}),env,{}, {fetch:async(_url,options)=>{assert.equal(JSON.parse(options.body).model,'gpt-5.6-luna');return openAIResponse(chatOutput,'gpt-5.6-luna');}});
assert.equal(response.status,200);assert.match((await response.json()).message.answer,/WAIT/);

response=await handleRequest(request('/v1/chat',{question:'Why?',quant}, {origin:'https://evil.example'}),env,{}, {fetch:async()=>openAIResponse(chatOutput)});
assert.equal(response.status,403);

response=await handleRequest(new Request('https://market-edge-ai.test/v1/chat',{method:'POST',headers:{origin:'https://jamalmusialla81-hub.github.io','content-type':'text/plain'},body:'{}'}),env,{}, {fetch:async()=>openAIResponse(chatOutput)});
assert.equal(response.status,415);

const tvEnv={...env,TV_WEBHOOK_TOKEN:'test-tv-secret'},tvNow=2_000_000_000_000;
function tvRequest(payload,token='test-tv-secret') { return new Request(`https://market-edge-ai.test/v1/tradingview-alert?token=${encodeURIComponent(token)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}); }
const tvAlert={event_id:'fixture-1',symbol:'ETHUSDT',exchange:'BINANCE',timeframe:'15m',timestamp:tvNow-60_000,close:2500,volume:1200,condition:'EMA alignment candidate',state:'CANDIDATE'};
response=await handleRequest(tvRequest(tvAlert),tvEnv,{}, {now:tvNow});
assert.equal(response.status,200);body=await response.json();assert.equal(body.accepted,true);assert.equal(body.execution,'disabled');
response=await handleRequest(tvRequest(tvAlert),tvEnv,{}, {now:tvNow});
assert.equal(response.status,409);assert.equal((await response.json()).error.code,'TV_DUPLICATE_ALERT');
response=await handleRequest(tvRequest({...tvAlert,event_id:'stale',timestamp:tvNow-4_000_000}),tvEnv,{}, {now:tvNow});
assert.equal(response.status,400);assert.equal((await response.json()).error.code,'TV_STALE_ALERT');
response=await handleRequest(tvRequest({...tvAlert,event_id:'future',timestamp:tvNow+120_000}),tvEnv,{}, {now:tvNow});
assert.equal(response.status,400);assert.equal((await response.json()).error.code,'TV_FUTURE_ALERT');
response=await handleRequest(tvRequest({...tvAlert,event_id:'auth'},'wrong'),tvEnv,{}, {now:tvNow});
assert.equal(response.status,401);assert.equal((await response.json()).error.code,'TV_AUTH_FAILED');
response=await handleRequest(tvRequest({...tvAlert,event_id:'disabled'}),env,{}, {now:tvNow});
assert.equal(response.status,503);assert.equal((await response.json()).error.code,'TV_NOT_CONFIGURED');

class FakeStatement {
  constructor(db,sql){this.db=db;this.sql=sql;}
  bind(...args){this.args=args;return this;}
  async run(){this.db.calls.push({sql:this.sql,args:this.args});return {success:true};}
  async first(){return null;}
  async all(){return {results:[]};}
}
class FakeD1 { constructor(){this.calls=[];} prepare(sql){return new FakeStatement(this,sql);} async batch(items){for(const item of items)await item.run();} }
const researchEnv={...env,RESEARCH_INGEST_TOKEN:'test-research-secret',MARKET_EDGE_DB:new FakeD1()};
response=await handleRequest(new Request('https://market-edge-ai.test/v1/research/ml/dataset?id=EARLY-WINDOW-RESEARCH-V1',{headers:{origin:'https://jamalmusialla81-hub.github.io'}}),researchEnv,{},{});
assert.equal(response.status,401);assert.equal((await response.json()).error.code,'RESEARCH_AUTH_FAILED');
response=await handleRequest(new Request('https://market-edge-ai.test/v1/research/ml/dataset?id=EARLY-WINDOW-RESEARCH-V1',{headers:{origin:'https://jamalmusialla81-hub.github.io',authorization:'Bearer test-research-secret'}}),researchEnv,{},{});
assert.equal(response.status,409);assert.equal((await response.json()).error.code,'ML_DATASET_NOT_READY');
response=await handleRequest(request('/v1/research/ml/ingest',{operation:'ml_research_commit'}),researchEnv,{},{});
assert.equal(response.status,401);assert.equal((await response.json()).error.code,'RESEARCH_AUTH_FAILED');
const monitorNow=1_800_000_000_000,monitorRows=Array.from({length:100},(_,index)=>{const time=monitorNow-(100-index)*300000,price=100+index*.1;return[time,String(price),String(price+1),String(price-1),String(price+.2),'20',time+299999];});
const monitorDb=new FakeD1(),scheduled=await handleScheduled({scheduledTime:monitorNow},{MARKET_EDGE_DB:monitorDb},{},{watchlist:[{asset:'BTC',symbol:'BTCUSDT',exchange:'BINANCE'}],historicalAssets:[],delay:async()=>{},fetch:async()=>new Response(JSON.stringify(monitorRows),{status:200})});
assert.equal(scheduled.status,'COMPLETE');assert.equal(scheduled.executionDisabled,true);assert.equal(scheduled.researchRunner,'github-actions-node');assert.equal(scheduled.heavyReplay,'disabled');assert.equal(monitorDb.calls.length,0);

console.log('AI backend tests passed');
