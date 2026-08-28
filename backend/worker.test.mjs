import assert from 'node:assert/strict';
import {handleRequest} from './worker.mjs';

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

console.log('AI backend tests passed');
