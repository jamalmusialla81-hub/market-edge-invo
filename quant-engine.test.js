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

// ---- TASK A (#80): decision semantics -----------------------------------------------------------------------------
{
  const S = Quant.decisionSemantics, feeds = { sourceCount: 3, matchingFeeds: 3, maxPriceDisagreement: 0.004 };
  const setup = { direction: 'long', strategy: 'TREND CONTINUATION', setupQuality: 65, entryQuality: 'ACCEPTABLE', entry: 100, stop: 98, target1: 103.6, target2: 105, rr1: 1.8 };
  // The same setup reached WAIT through unrelated causes: each concept is reported separately and stays put.
  const timingWait = { ...setup, decision: 'WAIT', reason: '15m confirmation and 5m execution timing both oppose the setup' };
  const riskWait = { ...setup, decision: 'RANKED', strictDecision: 'WAIT', risk: { valid: false, reason: 'ACCOUNT/MINIMUM SIZE CONSTRAINT' } };
  const a = S(timingWait, feeds), b = S(riskWait, feeds);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.ranking_verdict, 'VALID');          // 65 sits in the existing minQuality-10 band, not WEAK
  assert.strictEqual(a.entry_readiness, 'ACCEPTABLE');
  assert.strictEqual(a.data_confirmation, 'CONFIRMED');
  assert.deepStrictEqual([a.risk_decision, a.execution_feasibility, a.final_execution_decision], [null, null, null]);
  assert.strictEqual(a.version, Quant.SEMANTICS_VERSION);
  // Bands reuse settings.minQuality; no fixed number is baked in.
  assert.strictEqual(S({ ...setup, setupQuality: 72 }, { ...feeds, minQuality: 72 }).ranking_verdict, 'STRONG');
  assert.strictEqual(S({ ...setup, setupQuality: 61 }, { ...feeds, minQuality: 72 }).ranking_verdict, 'WEAK');
  assert.strictEqual(S({ ...setup, setupQuality: 61 }, { ...feeds, minQuality: 60 }).ranking_verdict, 'STRONG');
  // Entry readiness is independent of quality; data confirmation is independent of both.
  assert.strictEqual(S({ ...setup, entryQuality: 'EXTENDED' }, feeds).entry_readiness, 'EXTENDED');
  assert.strictEqual(S(setup, { ...feeds, sourceCount: 1, matchingFeeds: 1 }).data_confirmation, 'PARTIAL');
  assert.strictEqual(S(setup, { ...feeds, matchingFeeds: 1 }).data_confirmation, 'PARTIAL');
  assert.strictEqual(S(setup, { ...feeds, maxPriceDisagreement: 0.03 }).data_confirmation, 'CONFLICTING');
  assert.strictEqual(S(setup, { ...feeds, stale: true }).data_confirmation, 'STALE');
  assert.strictEqual(S(setup, {}).data_confirmation, 'UNAVAILABLE');
  // No candidate, unavailable analysis or broken geometry is INVALID, never quietly WEAK.
  assert.strictEqual(S({ decision: 'NO TRADE', quality: null, setupQuality: null }, feeds).ranking_verdict, 'INVALID');
  const unavailable = S({ decision: 'ANALYSIS UNAVAILABLE', quality: 0 }, feeds);
  assert.deepStrictEqual([unavailable.ranking_verdict, unavailable.entry_readiness, unavailable.data_confirmation], ['INVALID', 'INVALID', 'UNAVAILABLE']);
  assert.strictEqual(S({ ...setup, stop: NaN }, feeds).ranking_verdict, 'INVALID');
  // A real evaluateRankedSetup output: the legacy fields are what they were, the semantics are additive.
  const ranked = Quant.evaluateRankedSetup({ timeframes: { m5: series(320, 1), m15: series(320, 1), h1: series(320, 1), h4: series(320, 1), d1: series(320, 1) },
    settings: { balance: 1000, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 2, requireMTF: false } });
  assert.ok(['TAKE TRADE', 'RANKED', 'WAIT', 'NO TRADE'].includes(ranked.decision));
  assert.strictEqual('semantics' in ranked, false);        // evaluateSetup itself is untouched
  const real = S(ranked, feeds);
  assert.ok(['STRONG', 'VALID', 'WEAK', 'INVALID'].includes(real.ranking_verdict) && ['IDEAL', 'ACCEPTABLE', 'EXTENDED', 'INVALID'].includes(real.entry_readiness));
}
{
  // Every historical strict_verdict value maps deterministically; nothing is guessed.
  const M = Quant.mapLegacyVerdict, market = { source_count: 3, matching_feeds: 3, max_price_disagreement: 0.004 };
  const row = (strict_verdict, extra = {}) => ({ strict_verdict, direction: 'long', strategy: 'TREND CONTINUATION', quant_score: 80, entry: 100, stop: 98, tp1: 103.6, rr1: 1.8, entry_quality: 'IDEAL', entry_status: 'IDEAL', market, ...extra });
  assert.deepStrictEqual(Quant.LEGACY_VERDICTS, ['TAKE TRADE', 'WAIT', 'NO TRADE', 'ANALYSIS UNAVAILABLE', 'RANKED']);
  const take = M(row('TAKE TRADE'));
  assert.deepStrictEqual([take.ranking_verdict, take.entry_readiness, take.data_confirmation, take.legacy.ambiguous, take.legacy.inferred], ['STRONG', 'IDEAL', 'CONFIRMED', false, []]);
  // WAIT is ambiguous by design and is reported so; with the row's own facts it is still resolved per concept.
  const wait = M(row('WAIT', { entry_quality: 'EXTENDED', market: { ...market, matching_feeds: 1 } }));
  assert.deepStrictEqual([wait.entry_readiness, wait.data_confirmation, wait.legacy.ambiguous], ['EXTENDED', 'PARTIAL', true]);
  // Old rows with no feed facts stay UNAVAILABLE for WAIT; TAKE TRADE's confirmation is inferred and says so.
  assert.strictEqual(M(row('WAIT', { market: undefined })).data_confirmation, 'UNAVAILABLE');
  const takeNoMarket = M(row('TAKE TRADE', { market: undefined }));
  assert.deepStrictEqual([takeNoMarket.data_confirmation, takeNoMarket.legacy.inferred], ['CONFIRMED', ['data_confirmation']]);
  const none = M({ strict_verdict: 'NO TRADE', direction: null });
  assert.deepStrictEqual([none.ranking_verdict, none.entry_readiness], ['INVALID', 'INVALID']);
  const gone = M({ strict_verdict: 'ANALYSIS UNAVAILABLE' });
  assert.deepStrictEqual([gone.ranking_verdict, gone.data_confirmation], ['INVALID', 'UNAVAILABLE']);
  assert.strictEqual(M(row('RANKED')).legacy.ambiguous, true);
  // Deterministic, and an unknown verdict is reported unmapped, never coerced into a known one.
  assert.deepStrictEqual(M(row('WAIT')), M(row('WAIT')));
  const unknown = M(row('MAYBE'));
  assert.deepStrictEqual([unknown.legacy.mapped, unknown.ranking_verdict, unknown.data_confirmation], [false, 'INVALID', 'UNAVAILABLE']);
  // Live and legacy paths agree on the same facts.
  const live = Quant.decisionSemantics({ direction: 'long', strategy: 'TREND CONTINUATION', setupQuality: 80, entryQuality: 'IDEAL', entry: 100, stop: 98, target1: 103.6, rr1: 1.8, decision: 'TAKE TRADE' },
    { sourceCount: 3, matchingFeeds: 3, maxPriceDisagreement: 0.004 });
  const { legacy, ...legacyFields } = take;
  assert.deepStrictEqual(legacyFields, live);
}

console.log('Quant engine tests passed');
