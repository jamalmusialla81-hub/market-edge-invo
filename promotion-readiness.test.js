const assert=require('node:assert/strict'),Engine=require('./promotion-readiness.js');
const base={id:'challenger',generation:1,datasetHash:'hash'};
function scan(index,{challenger=1,incumbent=.5,quant=.7,asset,regime}={}){return{timestamp:1_800_000_000_000+index*86_400_000,asset:asset||['BTC','ETH','SOL','XRP','DOGE'][index%5],regime:regime||['UPTREND','RANGE'][index%2],outcome:{quantOnly:{finalR:quant,netUtility:quant,tp1BeforeSl:true},incumbent:{finalR:incumbent,netUtility:incumbent,tp1BeforeSl:true},challenger:{finalR:challenger,netUtility:challenger,tp1BeforeSl:true}}};}
const insufficient=Engine.evaluate({model:base,scans:[scan(0)]});assert.equal(insufficient.decision,'INSUFFICIENT_EVIDENCE');
const strong=Engine.evaluate({model:base,scans:Array.from({length:50},(_,i)=>scan(i)),thresholds:{minForwardDays:14}});assert.equal(strong.decision,'PROMOTION_READY');
const minimumDays=Engine.evaluate({model:base,scans:Array.from({length:50},()=>scan(0)),thresholds:{minForwardDays:14}});assert.equal(minimumDays.decision,'INSUFFICIENT_EVIDENCE');assert.match(minimumDays.decisionReasons.join(' '),/forward days/);
const assetDiversity=Engine.evaluate({model:base,scans:Array.from({length:50},(_,i)=>scan(i,{asset:'BTC'})),thresholds:{minForwardDays:14}});assert.equal(assetDiversity.decision,'INSUFFICIENT_EVIDENCE');assert.match(assetDiversity.decisionReasons.join(' '),/assets/);
const regimeDiversity=Engine.evaluate({model:base,scans:Array.from({length:50},(_,i)=>scan(i,{regime:'UPTREND'})),thresholds:{minForwardDays:14}});assert.equal(regimeDiversity.decision,'INSUFFICIENT_EVIDENCE');assert.match(regimeDiversity.decisionReasons.join(' '),/regimes/);
const mixed=Engine.evaluate({model:base,scans:Array.from({length:50},(_,i)=>scan(i,{challenger:.5,incumbent:.5,quant:.7})),thresholds:{minForwardDays:14}});assert.equal(mixed.decision,'KEEP_CHALLENGER');
const rejected=Engine.evaluate({model:base,scans:Array.from({length:50},(_,i)=>scan(i,{challenger:-1,incumbent:.5})),thresholds:{minForwardDays:14}});assert.equal(rejected.decision,'REJECTED');
const integrity=Engine.evaluate({model:base,scans:Array.from({length:50},(_,i)=>scan(i)),integrity:{noLookahead:false},thresholds:{minForwardDays:14}});assert.equal(integrity.decision,'REJECTED');
assert.equal(Engine.comparable([{...scan(0),outcome:{...scan(0).outcome,challenger:null}}]).length,0);
assert.equal(Engine.evaluate({model:{...base,id:'second-challenger'},scans:Array.from({length:50},(_,i)=>scan(i)),thresholds:{minForwardDays:14}}).modelId,'second-challenger');
console.log('Promotion readiness tests passed');
