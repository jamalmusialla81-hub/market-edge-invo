const assert=require('node:assert/strict');
const {evaluate}=require('./ml-runner.js');

function row(index){
  const positive=index%6===0?1:0;
  return {
    id:`signal-${index}`,
    time:1_730_000_000_000+index*300_000,
    asset:['BTC','ETH','SOL','XRP','DOGE','LTC'][index%6],
    strategy:index%3===0?'BREAKOUT + RETEST':index%3===1?'TREND CONTINUATION':'LIQUIDITY-SWEEP REVERSAL',
    direction:index%2?'long':'short', regime:'BREAKOUT',
    features:{quality:.58+(index%10)/50,rr:1.5+(index%4)/10,long:index%2,breakout:index%3===0?1:0,liquiditySweep:index%3===2?1:0,h4Rsi:.4+(index%7)/20,h4Roc5:(index%9)/100,h4RelativeVolume:.8+(index%5)/10,m15Rsi:.43+(index%6)/20,m15RelativeVolume:.9+(index%4)/10},
    targets:{tp1BeforeSl:positive,finalR:positive?1.1+(index%3)/10:-.28+(index%4)/20}
  };
}

const rows=Array.from({length:50},(_,index)=>row(index));
const first=evaluate(rows),second=evaluate(rows.slice().reverse());
assert.equal(first.oosN,25);
assert.equal(first.classification.n,25);
assert.equal(first.regression.n,25);
assert.equal(first.finalTrain.length,40);
assert.deepEqual(first.classification,second.classification);
assert.deepEqual(first.regression,second.regression);
assert.deepEqual(first.buckets,second.buckets);
assert.ok(first.classification.brier>=0&&first.classification.brier<=1);
assert.ok(Number.isFinite(first.regression.mae));
assert.equal(first.logistic.target,'tp1BeforeSl');
assert.equal(first.ridge.target,'finalR');
console.log('ml-runner tests passed');
