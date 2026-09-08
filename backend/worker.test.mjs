import assert from 'node:assert/strict';
import {handleRequest,handleScheduled,communityPaperEvent,liveForwardSelectionRecord} from './worker.mjs';

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
const communitySignal={id:'paper-signal-1',symbol:'BTC',direction:'long',strategy:'TREND CONTINUATION',timestamp:tvNow-3_600_000,entry:100,stop:95,target1:109,target2:115,rr1:1.8,rr2:3,quality:62,balance:999999,notes:'must never persist'};
const cleanCommunity=communityPaperEvent({event_type:'SIGNAL',signal:communitySignal});assert.equal(cleanCommunity.eventId,'SIGNAL:paper-signal-1');assert.equal(cleanCommunity.signal.balance,undefined);assert.equal(cleanCommunity.signal.notes,undefined);
const resolvedCommunity=communityPaperEvent({event_type:'OUTCOME',signal:communitySignal,outcome:{status:'win',resultR:2.1,closedAt:tvNow,barsHeld:4,tp1Hit:true,costR:.02,notes:'must never persist'}});assert.equal(resolvedCommunity.outcome.notes,undefined);assert.equal(resolvedCommunity.outcome.status,'win');
assert.throws(()=>communityPaperEvent({event_type:'SIGNAL',signal:{...communitySignal,direction:'long',stop:105}}),/price ordering/);
const forwardLive=liveForwardSelectionRecord({status:'BEST_TRADE_NOW',scannedAt:tvNow,bestTradeNow:{scan_snapshot_id:'snapshot-1',asset:'BTC',direction:'long',strategy:'TREND CONTINUATION',quant_score:72,combined_score:73}});
assert.equal(forwardLive.id,`live-snapshot-1-${Math.floor(tvNow/300000)}`);assert.equal(forwardLive.quantOnly.score,72);assert.equal(forwardLive.mlAssisted.score,73);
assert.equal(forwardLive.mlAssisted.snapshot,null);
const sameMarketObservation=liveForwardSelectionRecord({status:'BEST_TRADE_NOW',scanId:'different-user-scan',scannedAt:tvNow+20_000,bestTradeNow:{scan_snapshot_id:'snapshot-1',asset:'BTC',direction:'long',strategy:'TREND CONTINUATION',quant_score:72,combined_score:73}});
assert.equal(sameMarketObservation.id,forwardLive.id);
assert.equal(liveForwardSelectionRecord({status:'DATA_UNAVAILABLE',scannedAt:tvNow,bestTradeNow:null}),null);
const resolvableForward=liveForwardSelectionRecord({status:'BEST_TRADE_NOW',scannedAt:tvNow,bestTradeNow:{scan_snapshot_id:'snapshot-complete',asset:'ETH',instrument:'ETH',direction:'long',strategy:'TREND CONTINUATION',rank:1,entry:100,stop:95,tp1:109,tp2:115,rr1:1.8,quant_score:72,combined_score:73}});
assert.equal(resolvableForward.mlAssisted.snapshot.entry,100);
assert.equal(resolvableForward.mlAssisted.snapshot.stop,95);
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
  async run(){this.db.calls.push({sql:this.sql,args:this.args});return {success:true,meta:{changes:/UPDATE historical_scan_candidates/.test(this.sql)?1:0}};}
  async first(){return null;}
  async all(){return {results:[]};}
}
class FakeD1 { constructor(){this.calls=[];} prepare(sql){return new FakeStatement(this,sql);} async batch(items){for(const item of items)await item.run();} }
const researchEnv={...env,RESEARCH_INGEST_TOKEN:'test-research-secret',MARKET_EDGE_DB:new FakeD1()};
class ExhaustedReplayD1 { prepare(){return {all:async()=>{throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");}};} }
response=await handleRequest(new Request('https://market-edge-ai.test/v1/research/replay',{headers:{origin:'https://jamalmusialla81-hub.github.io'}}),{...env,MARKET_EDGE_DB:new ExhaustedReplayD1()},{},{});
assert.equal(response.status,503);assert.equal((await response.json()).error.code,'RESEARCH_D1_READ_LIMITED');
function stable(value){if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function stableHash(value){let hash=0x811c9dc5,text=stable(value);for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,0x01000193);}return(hash>>>0).toString(16).padStart(8,'0');}
response=await handleRequest(new Request('https://market-edge-ai.test/v1/research/ml/dataset?id=EARLY-WINDOW-RESEARCH-V1',{headers:{origin:'https://jamalmusialla81-hub.github.io'}}),researchEnv,{},{});
assert.equal(response.status,401);assert.equal((await response.json()).error.code,'RESEARCH_AUTH_FAILED');
response=await handleRequest(new Request('https://market-edge-ai.test/v1/research/ml/dataset?id=EARLY-WINDOW-RESEARCH-V1',{headers:{origin:'https://jamalmusialla81-hub.github.io',authorization:'Bearer test-research-secret'}}),researchEnv,{},{});
assert.equal(response.status,409);assert.equal((await response.json()).error.code,'ML_DATASET_NOT_READY');
response=await handleRequest(request('/v1/research/ml/ingest',{operation:'ml_research_commit'}),researchEnv,{},{});
assert.equal(response.status,401);assert.equal((await response.json()).error.code,'RESEARCH_AUTH_FAILED');
response=await handleRequest(request('/v1/research/forward-selections',{selection:{id:'selection-fixture-1',timestamp:tvNow-60_000,status:'FORWARD / PENDING',quantOnly:{asset:'BTC',direction:'long',strategy:'TREND CONTINUATION',score:72},mlAssisted:{asset:'BTC',direction:'long',strategy:'TREND CONTINUATION',score:73}}}),researchEnv,{},{});
assert.equal(response.status,200);body=await response.json();assert.equal(body.status,'FORWARD / PENDING');assert.equal(researchEnv.MARKET_EDGE_DB.calls.some(call=>call.sql.includes('ml_forward_selection_snapshots')),true);
response=await handleRequest(request('/v1/research/ingest',{operation:'experiment_commit',experiment:{experiment_id:'baseline-fixture',hypothesis:'Freeze baseline',dataset_hash:'dataset-hash',engine_hash:'engine-hash',record_hash:'record-hash',feature_set:[],decision:'REJECTED',rejection_reason:'Insufficient evidence'}}),researchEnv,{},{});
assert.equal(response.status,401);
response=await handleRequest(request('/v1/research/ingest',{operation:'experiment_commit',experiment:{experiment_id:'baseline-fixture',hypothesis:'Freeze baseline',dataset_hash:'dataset-hash',engine_hash:'engine-hash',record_hash:'record-hash',feature_set:[],decision:'REJECTED',rejection_reason:'Insufficient evidence'}},{authorization:'Bearer test-research-secret'}),researchEnv,{},{});
assert.equal(response.status,200);body=await response.json();assert.equal(body.immutable,true);assert.equal(researchEnv.MARKET_EDGE_DB.calls.some(call=>call.sql.includes('research_experiments')),true);
const rankSnapshot={scan_id:'rank-fixture',scan_timestamp:tvNow-600000,data_timestamp:tvNow-600000,universe_mode:'HISTORICAL_DATA_UNIVERSE_PROXY',eligible_universe:['BTC'],engine_version:'rank-v1',strategy_version:'quant-engine-shared',quant_version:'quant-engine-shared',ml_version:'ML_NOT_AVAILABLE_FOR_HISTORICAL_TIMESTAMP',feature_version:'features-v1',source_dataset_hash:'source-fixture',scan_cadence_ms:604800000,candidate_count:1};rankSnapshot.snapshot_hash=stableHash(rankSnapshot);
const rankCandidate={candidate_id:'rank-candidate-fixture',asset:'BTC',invo_instrument:'BTC',direction:'long',strategy:'TREND CONTINUATION',reference_price:100,entry:100,stop:95,tp1:109,tp2:115,rr:1.8,setup_quality:72,entry_quality:'IDEAL',quant_score:72,ml_applicability:'ML_NOT_AVAILABLE_FOR_HISTORICAL_TIMESTAMP',ml_raw_score:null,combined_score:72,regime:'BREAKOUT',feature_json:{m5:{rsi:50}},feature_hash:'feature-fixture',candidate_rank:1,candidate_count:1,valid_current_geometry:true,invalidation_reason:null,targets:{status:'PENDING_OUTCOME'}};rankCandidate.candidate_hash=stableHash({...rankCandidate,targets:undefined,candidate_hash:undefined});
response=await handleRequest(request('/v1/research/ingest',{operation:'historical_rank_snapshot_commit',snapshot:rankSnapshot,candidates:[rankCandidate]},{authorization:'Bearer test-research-secret'}),researchEnv,{},{ });
assert.equal(response.status,200);body=await response.json();assert.equal(body.candidate_count,1);assert.equal(researchEnv.MARKET_EDGE_DB.calls.some(call=>call.sql.includes('historical_scan_candidates')),true);
const resolvedTarget={status:'RESOLVED',TP1_BEFORE_SL:false,FINAL_R:-1.1,MFE:.4,MAE:-1.05,STOP_HIT:true,TP2_HIT:false,duration_bars:2};
response=await handleRequest(request('/v1/research/ingest',{operation:'historical_rank_outcome_commit',scan_id:'rank-fixture',outcomes:[{candidate_id:'rank-candidate-fixture',targets:resolvedTarget,outcome_hash:stableHash({candidate_id:'rank-candidate-fixture',targets:resolvedTarget})}]},{authorization:'Bearer test-research-secret'}),researchEnv,{},{ });
assert.equal(response.status,200);assert.equal((await response.json()).operation,'historical_rank_outcome_commit');
// Phase 4 inputs are accepted only when a candidate carries a frozen,
// versioned sequence record.  This keeps the Worker from silently accepting
// an unproven V2 candidate without its pre-entry candle provenance.
const rankSnapshotV2={...rankSnapshot,scan_id:'rank-v2-fixture',engine_version:'HISTORICAL-RANK-PILOT-V2'};rankSnapshotV2.snapshot_hash=stableHash({...rankSnapshotV2,snapshot_hash:undefined});delete rankSnapshotV2.snapshot_hash;rankSnapshotV2.snapshot_hash=stableHash(rankSnapshotV2);
const sequenceV2={version:'candle-sequence-v1',signal_timestamp:rankSnapshotV2.scan_timestamp,windows:[32,64,128,256],timeframes:{m5:{available:true,rows:[]},m15:{available:false,rows:null},h1:{available:false,rows:null}}};
const rankCandidateV2={...rankCandidate,candidate_id:'rank-v2-candidate-fixture',sequence_json:sequenceV2,sequence_hash:stableHash(sequenceV2),sequence_version:'candle-sequence-v1'};rankCandidateV2.candidate_hash=stableHash({...rankCandidateV2,targets:undefined,candidate_hash:undefined});
response=await handleRequest(request('/v1/research/ingest',{operation:'historical_rank_snapshot_commit',snapshot:rankSnapshotV2,candidates:[rankCandidateV2]},{authorization:'Bearer test-research-secret'}),researchEnv,{},{ });
assert.equal(response.status,200);assert.equal(researchEnv.MARKET_EDGE_DB.calls.some(call=>call.sql.includes('historical_candidate_sequences')),true);
const dataGapTarget={status:'UNRESOLVED_DATA_GAP',reason:'OUTCOME_CANDLE_GAP_EXCEEDED',next_valid_candle_gap_ms:900000,available_bars:12};
response=await handleRequest(request('/v1/research/ingest',{operation:'historical_rank_outcome_commit',scan_id:'rank-v2-fixture',outcomes:[{candidate_id:'rank-v2-candidate-fixture',targets:dataGapTarget,outcome_hash:stableHash({candidate_id:'rank-v2-candidate-fixture',targets:dataGapTarget})}]},{authorization:'Bearer test-research-secret'}),researchEnv,{},{ });
assert.equal(response.status,200);body=await response.json();assert.equal(body.data_gaps,1);assert.equal(body.resolved,0);
const recoveredTarget={...resolvedTarget,outcome_source:'BINANCE_PROXY',signal_venue:'COINBASE',proxy_basis:'Binance USD-M BTCUSDT 5m historical proxy'};
response=await handleRequest(request('/v1/research/ingest',{operation:'historical_rank_outcome_recovery_commit',scan_id:'rank-v2-fixture',outcomes:[{candidate_id:'rank-v2-candidate-fixture',targets:recoveredTarget,outcome_hash:stableHash({candidate_id:'rank-v2-candidate-fixture',targets:recoveredTarget})}]},{authorization:'Bearer test-research-secret'}),researchEnv,{},{ });
assert.equal(response.status,200);body=await response.json();assert.equal(body.resolved,1);assert.equal(researchEnv.MARKET_EDGE_DB.calls.some(call=>call.sql.includes("UNRESOLVED_DATA_GAP")),true);
const monitorNow=1_800_000_000_000,monitorRows=Array.from({length:100},(_,index)=>{const time=monitorNow-(100-index)*300000,price=100+index*.1;return[time,String(price),String(price+1),String(price-1),String(price+.2),'20',time+299999];});
const monitorDb=new FakeD1(),scheduled=await handleScheduled({scheduledTime:monitorNow},{MARKET_EDGE_DB:monitorDb},{},{watchlist:[{asset:'BTC',symbol:'BTCUSDT',exchange:'BINANCE'}],historicalAssets:[],delay:async()=>{},fetch:async()=>new Response(JSON.stringify(monitorRows),{status:200})});
assert.equal(scheduled.status,'COMPLETE');assert.equal(scheduled.executionDisabled,true);assert.equal(scheduled.researchRunner,'github-actions-node');assert.equal(scheduled.heavyReplay,'disabled');assert.equal(monitorDb.calls.length,0);

console.log('AI backend tests passed');
