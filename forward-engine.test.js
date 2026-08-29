const assert=require('node:assert/strict');
const Forward=require('./forward-engine.js');

const signal={symbol:'ETH',direction:'long',strategy:'BREAKOUT + RETEST',timestamp:1_000,entry:100,stop:95,target1:110,target2:115,rr1:2,rr2:3,datasetHash:'abc',engineVersion:'2.1.0'};
let result=Forward.appendSignal(null,signal,1_100);
assert.equal(result.added,true); assert.equal(result.ledger.signals.length,1);
const id=result.id,original=JSON.stringify(result.ledger.signals[0]);
assert.equal(Forward.appendSignal(result.ledger,signal).added,false);

let settled=Forward.settle(result.ledger,{ETH:[{time:2_000,open:100,high:111,low:99,close:109},{time:3_000,open:109,high:116,low:107,close:115}]},{now:4_000});
assert.equal(settled.outcomes[id].status,'win'); assert.ok(settled.outcomes[id].resultR<2.5); assert.equal(JSON.stringify(settled.signals[0]),original);
assert.equal(Forward.stats(settled).completed,1); assert.equal(Forward.stats(settled).sampleTier,'tiny');

result=Forward.appendSignal(null,signal);
settled=Forward.settle(result.ledger,{ETH:[{time:2_000,open:100,high:111,low:94,close:105}]});
assert.equal(settled.outcomes[result.id].status,'loss'); assert.match(settled.outcomes[result.id].reason,/conservative/);

const short={...signal,symbol:'BTC',direction:'short',entry:100,stop:105,target1:90,target2:85};
result=Forward.appendSignal(null,short); assert.equal(result.added,true);
settled=Forward.settle(result.ledger,{BTC:[{time:2_000,open:100,high:101,low:89,close:91},{time:3_000,open:91,high:100,low:88,close:99}]});
assert.equal(settled.outcomes[result.id].status,'partial');

const migrated=Forward.migrate([{key:'legacy',symbol:'SOL',direction:'long',strategy:'X',timestamp:10,entry:10,stop:9,target1:12,target2:13,rr1:2,rr2:3,status:'win',resultR:2,closedAt:20}]);
assert.equal(migrated.schema,Forward.SCHEMA); assert.equal(migrated.signals.length,1); assert.equal(Object.keys(migrated.outcomes).length,1);
assert.equal(Forward.validateSignal({...signal,stop:101}).valid,false);
console.log('Immutable forward engine tests passed');
