const assert = require('assert');
const Quant = require('./quant-engine.js');

function series(count, direction = 1, flat = false) {
  const candles = [];
  for (let index = 0; index < count; index++) {
    const trend = flat ? 0 : direction * index * 0.08;
    const wave = flat ? 0 : Math.sin(index * 0.9) * 0.7;
    const close = 100 + trend + wave;
    const open = index ? candles[index - 1].close : close;
    candles.push({ time: index * 14400000, open, high: Math.max(open, close) + 0.35, low: Math.min(open, close) - 0.35, close, volume: 1000 + (index % 12) * 25 });
  }
  return candles;
}
function readyShortSeries(count) {
  const candles=[];
  for (let index=0;index<count;index++) {
    const close=100-index*.02+Math.sin(index*.6)*.3, open=index?candles[index-1].close:close;
    candles.push({time:index*14400000,open,high:Math.max(open,close)+.25,low:Math.min(open,close)-.25,close,volume:1000+(index%12)*25});
  }
  return candles;
}

assert.deepStrictEqual(Quant.ema([5, 5, 5, 5], 3), [5, 5, 5, 5]);
assert.strictEqual(Quant.features(series(50)).available, false);
assert.strictEqual(Quant.features(series(260)).available, true);
const duplicate=series(80); duplicate[40]={...duplicate[40],time:duplicate[39].time};
assert.strictEqual(Quant.validateCandles(duplicate).valid,false);
const missing=series(100); missing.splice(20,2); missing.splice(40,2); missing.splice(60,2);
assert.strictEqual(Quant.validateCandles(missing).valid,false);
const spike=series(100); spike[95]={...spike[95],open:spike[94].close,close:spike[94].close*1.5,high:spike[94].close*1.51,low:spike[94].close*.99};
assert.strictEqual(Quant.validateCandles(spike).valid,false);
assert.strictEqual(Quant.validateFreshness(series(80),14400000,series(80).at(-1).time+14400001).valid,false);
assert(Array.isArray(Quant.swingPoints(series(260)).highs));
assert('choch' in Quant.recentStructure(series(260)));
assert.strictEqual(Quant.evaluateSetup({ timeframes: { h4: series(260, 1, true) }, settings: { balance: 100, riskPct: 0.01, maxLeverage: 10, minNotional: 10, requireMTF: false } }).decision, 'NO TRADE');
const longSetup = Quant.evaluateSetup({ timeframes: { h4: series(320, 1) }, settings: { balance: 1000, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 2, minQuality: 60, requireMTF: false } });
const shortSetup = Quant.evaluateSetup({ timeframes: { h4: readyShortSeries(320) }, settings: { balance: 1000, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 2, minQuality: 60, requireMTF: false } });
assert.strictEqual(longSetup.decision, 'TAKE TRADE');
assert.strictEqual(longSetup.direction, 'long');
assert.strictEqual(shortSetup.decision, 'TAKE TRADE');
assert.strictEqual(shortSetup.direction, 'short');
const longCandidates=Quant.evaluateSetupCandidates({timeframes:{h4:series(320,1)},settings:{balance:1000,riskPct:.01,maxLeverage:10,minNotional:10,maxExposurePct:2,minQuality:60,requireMTF:false}});
assert(longCandidates.length>=1);
assert(longCandidates.every(candidate=>candidate.strategy&&['long','short'].includes(candidate.direction)));
assert(longCandidates.filter(candidate=>candidate.decision==='TAKE TRADE').every(candidate=>candidate.target1>candidate.entry&&candidate.target2>candidate.target1&&candidate.stop<candidate.entry&&candidate.risk.valid));
assert.strictEqual(Quant.evaluateSetup({ timeframes: { h4: series(320, 1) }, settings: { balance: 1000, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 2, minQuality: 90, requireMTF: false } }).decision, 'WAIT');
assert(longSetup.target1>longSetup.entry&&longSetup.target2>longSetup.target1&&longSetup.stop<longSetup.entry);
assert(shortSetup.target1<shortSetup.entry&&shortSetup.target2<shortSetup.target1&&shortSetup.stop>shortSetup.entry);
const conflict=Quant.evaluateSetup({timeframes:{m5:readyShortSeries(320),m15:readyShortSeries(320),h1:readyShortSeries(320),h4:series(320,1),d1:series(320,1)},settings:{balance:1000,riskPct:.01,maxLeverage:10,minNotional:10,maxExposurePct:2,minQuality:60,requireMTF:true}});
assert(['NO TRADE','WAIT'].includes(conflict.decision));
const rankedConflict=Quant.evaluateRankedSetup({timeframes:{m5:readyShortSeries(320),m15:readyShortSeries(320),h1:readyShortSeries(320),h4:series(320,1),d1:series(320,1)},settings:{balance:1000,riskPct:.01,maxLeverage:10,minNotional:10,maxExposurePct:2,minQuality:60,requireMTF:true}});
assert(['TAKE TRADE','RANKED'].includes(rankedConflict.decision));
assert(['IDEAL','ACCEPTABLE','EXTENDED'].includes(rankedConflict.entryQuality));
assert(['IDEAL','ACCEPTABLE','EXTENDED'].includes(rankedConflict.entryStatus));
assert(Number.isFinite(rankedConflict.entryQualityScore));
assert(rankedConflict.risk.valid);
const rankTooSmall=Quant.evaluateRankedSetup({timeframes:{h4:series(320,1)},settings:{balance:7,riskPct:.01,maxLeverage:10,minNotional:10,maxExposurePct:10,requireMTF:false}});
assert.equal(rankTooSmall.decision,'RANKED');
assert.equal(rankTooSmall.risk.valid,false);
assert.equal(rankTooSmall.risk.reason,'ACCOUNT/MINIMUM SIZE CONSTRAINT');

const tiny = Quant.riskPlan({ balance: 7, riskPct: 0.01, maxLeverage: 10, entry: 100, stop: 95, direction: 'long', minNotional: 10, maxExposurePct: 10 });
assert.strictEqual(tiny.valid, false);
assert.strictEqual(tiny.reason, 'ACCOUNT/MINIMUM SIZE CONSTRAINT');

for (const maxLeverage of [1, 2, 3, 5, 10]) {
  const plan = Quant.riskPlan({ balance: 100, riskPct: 0.01, maxLeverage, entry: 100, stop: 98, direction: 'long', minNotional: 10, maxExposurePct: 10 });
  assert.strictEqual(plan.valid, true);
  assert(plan.lossAtStop <= 1.000001);
  assert(plan.margin <= 100);
}
const expectedLeverage=[[.015,2],[.03,3],[.05,5],[.10,10]];
for(const [riskPct,expected] of expectedLeverage) {
  const plan=Quant.riskPlan({balance:20,riskPct,maxLeverage:10,entry:100,stop:99,direction:'long',minNotional:10,maxExposurePct:10});
  assert.strictEqual(plan.valid,true);
  assert.strictEqual(plan.leverage,expected);
}

const leveraged = Quant.riskPlan({ balance: 20, riskPct: 0.10, maxLeverage: 10, entry: 100, stop: 99, direction: 'long', minNotional: 10, maxExposurePct: 10 });
assert.strictEqual(leveraged.valid, true);
assert.strictEqual(leveraged.leverage, 10);
assert(leveraged.estimatedLiquidation < 99);
assert.strictEqual(Quant.riskPlan({ balance: 20, riskPct: 0.50, maxLeverage: 10, entry: 100, stop: 91, direction: 'long', minNotional: 10, maxExposurePct: 10 }).valid, false);

const stats = Quant.performanceStats([{ r: 2 }, { r: -1 }, { r: 2 }, { r: -1 }]);
assert.strictEqual(stats.trades, 4);
assert.strictEqual(stats.winRate, 0.5);
assert.strictEqual(stats.expectancy, 0.5);
assert.strictEqual(stats.profitFactor, 2);
assert.strictEqual(stats.medianR,0.5);
assert.strictEqual(stats.sampleTier,'tiny');

const historical = Quant.backtest(series(520), { minQuality: 60, minRR: 1.5, maxLeverage: 10 });
assert(historical.trades.every(trade => trade.entryIndex === trade.signalIndex + 1));
assert(historical.trades.every(trade => trade.exitIndex >= trade.entryIndex));
assert(historical.trades.every(trade => Number.isFinite(trade.costR)&&Number.isFinite(trade.mfeR)&&Number.isFinite(trade.maeR)&&trade.barsHeld>=1));
assert(historical.walkForward.folds.every(fold=>fold.trainEnd<fold.validationEnd&&fold.validationEnd<fold.testEnd));
assert(historical.walkForward.unseenTrades.every(trade=>historical.walkForward.folds.some(fold=>trade.signalIndex>=fold.validationEnd&&trade.signalIndex<fold.testEnd)));
assert('long' in historical.byDirection);
assert('60-69' in historical.byQuality||'70-79' in historical.byQuality||'80-89' in historical.byQuality||'90+' in historical.byQuality||historical.test.trades===0);
assert.deepStrictEqual(historical.costSensitivity.map(row=>row.roundTripCostPct),[.0008,.0016,.0025,.004]);
for(let index=1;index<historical.costSensitivity.length;index++) assert(historical.costSensitivity[index].stats.expectancy<=historical.costSensitivity[index-1].stats.expectancy+1e-12);
assert.match(historical.executionModel.sameCandle,/stop first/);

console.log('Quant engine tests passed');
