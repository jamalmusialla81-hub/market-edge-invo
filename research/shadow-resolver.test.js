const assert=require('node:assert/strict'),{resolveSelection}=require('./shadow-resolver.js');
const selection={asset:'BTC',direction:'long',strategy:'TREND CONTINUATION',entry:100,stop:95,target1:109,target2:115,mlRawScore:61};
const outcome=resolveSelection(selection,1000,[{time:1300,open:101,high:110,low:99,close:109,volume:1},{time:1600,open:110,high:116,low:108,close:115,volume:1}]);
assert.ok(outcome);assert.equal(outcome.tp1BeforeSl,true);assert.ok(outcome.finalR>0);assert.equal(outcome.rawScore,61);assert.equal(resolveSelection(selection,1000,[]),null);
console.log('Shadow outcome resolver tests passed');
