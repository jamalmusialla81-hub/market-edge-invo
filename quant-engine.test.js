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

assert.deepStrictEqual(Quant.ema([5, 5, 5, 5], 3), [5, 5, 5, 5]);
assert.strictEqual(Quant.features(series(50)).available, false);
assert.strictEqual(Quant.features(series(260)).available, true);
assert.strictEqual(Quant.evaluateSetup({ timeframes: { h4: series(260, 1, true) }, settings: { balance: 100, riskPct: 0.01, maxLeverage: 10, minNotional: 10 } }).decision, 'NO TRADE');
const longSetup = Quant.evaluateSetup({ timeframes: { h4: series(320, 1) }, settings: { balance: 1000, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 2, minQuality: 60 } });
const shortSetup = Quant.evaluateSetup({ timeframes: { h4: series(320, -1) }, settings: { balance: 1000, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 2, minQuality: 60 } });
assert.strictEqual(longSetup.decision, 'TAKE TRADE');
assert.strictEqual(longSetup.direction, 'long');
assert.strictEqual(shortSetup.decision, 'TAKE TRADE');
assert.strictEqual(shortSetup.direction, 'short');
assert.strictEqual(Quant.evaluateSetup({ timeframes: { h4: series(320, 1) }, settings: { balance: 1000, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 2, minQuality: 90 } }).decision, 'WAIT');

const tiny = Quant.riskPlan({ balance: 7, riskPct: 0.01, maxLeverage: 10, entry: 100, stop: 95, direction: 'long', minNotional: 10, maxExposurePct: 10 });
assert.strictEqual(tiny.valid, false);
assert.strictEqual(tiny.reason, 'ACCOUNT/MINIMUM SIZE CONSTRAINT');

for (const maxLeverage of [1, 2, 3, 5, 10]) {
  const plan = Quant.riskPlan({ balance: 100, riskPct: 0.01, maxLeverage, entry: 100, stop: 98, direction: 'long', minNotional: 10, maxExposurePct: 10 });
  assert.strictEqual(plan.valid, true);
  assert(plan.lossAtStop <= 1.000001);
  assert(plan.margin <= 100);
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

const historical = Quant.backtest(series(520), { minQuality: 60, minRR: 1.5, maxLeverage: 10 });
assert(historical.trades.every(trade => trade.entryIndex === trade.signalIndex + 1));
assert(historical.trades.every(trade => trade.exitIndex >= trade.entryIndex));

console.log('Quant engine tests passed');
