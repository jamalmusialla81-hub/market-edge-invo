(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MarketEdgeQuant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '2.1.0';
  const LEVERAGE_CHOICES = [1, 2, 3, 5, 10];

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
  function median(values) {
    if (!values.length) return 0;
    const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
    return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
  }
  function std(values) {
    if (values.length < 2) return 0;
    const avg = mean(values);
    return Math.sqrt(mean(values.map(value => (value - avg) ** 2)));
  }
  function ema(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1), output = [values[0]];
    for (let i = 1; i < values.length; i++) output.push(values[i] * k + output[i - 1] * (1 - k));
    return output;
  }
  function sma(values, period) {
    let running = 0;
    return values.map((value, index) => {
      running += value;
      if (index >= period) running -= values[index - period];
      return index >= period - 1 ? running / period : null;
    });
  }
  function rsi(values, period = 14) {
    if (values.length <= period) return null;
    const changes = values.slice(1).map((value, index) => value - values[index]);
    const recent = changes.slice(-period);
    const gain = mean(recent.map(value => Math.max(0, value)));
    const loss = mean(recent.map(value => Math.max(0, -value)));
    if (!loss && !gain) return 50;
    if (!loss) return 100;
    return 100 - 100 / (1 + gain / loss);
  }
  function trueRanges(candles) {
    return candles.map((candle, index) => {
      if (!index) return candle.high - candle.low;
      const previous = candles[index - 1].close;
      return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
    });
  }
  function atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    return mean(trueRanges(candles).slice(-period));
  }
  function rollingVwap(candles, period) {
    const recent = candles.slice(-period);
    const volume = recent.reduce((sum, candle) => sum + Math.max(0, candle.volume || 0), 0);
    if (!volume) return null;
    return recent.reduce((sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume, 0) / volume;
  }
  function pctChange(from, to) { return from ? (to / from - 1) * 100 : 0; }
  function validateCandles(candles) {
    if (!Array.isArray(candles) || candles.length < 60) return { valid:false, reason:'Fewer than 60 complete candles', warnings:[] };
    const warnings=[], timestamps=new Set(), intervals=[];
    for (let index=0; index<candles.length; index++) {
      const candle=candles[index];
      if (![candle.time,candle.open,candle.high,candle.low,candle.close].every(Number.isFinite)) return { valid:false, reason:'Missing or invalid candle values', warnings };
      if (candle.high<Math.max(candle.open,candle.close)||candle.low>Math.min(candle.open,candle.close)||candle.low>candle.high) return { valid:false, reason:'Invalid OHLC relationship', warnings };
      if (timestamps.has(candle.time)) return { valid:false, reason:'Duplicate candle timestamps', warnings };
      timestamps.add(candle.time);
      if (index) intervals.push(candle.time-candles[index-1].time);
    }
    const sorted=[...intervals].sort((a,b)=>a-b), expected=sorted[Math.floor(sorted.length/2)]||0;
    const gaps=expected?intervals.filter(interval=>interval>expected*1.6).length:0;
    if (gaps>Math.max(2,intervals.length*.02)) return { valid:false, reason:'Too many missing candle intervals', warnings:[`${gaps} gaps detected`] };
    if (gaps) warnings.push(`${gaps} candle gap${gaps===1?'':'s'} detected`);
    const returns=candles.slice(1).map((candle,index)=>Math.abs(candle.close/candles[index].close-1));
    const baseline=[...returns].sort((a,b)=>a-b)[Math.floor(returns.length/2)]||0;
    const recentSpike=returns.slice(-12).some(value=>value>Math.max(.20,baseline*15));
    if (recentSpike) return { valid:false, reason:'Recent price spike failed data-quality validation', warnings };
    return { valid:true, reason:null, warnings, expectedInterval:expected };
  }
  function validateFreshness(candles,maxAgeMs,now=Date.now()) {
    if (!candles?.length) return {valid:false,reason:'No candles'};
    return now-candles.at(-1).time<=maxAgeMs?{valid:true,reason:null}:{valid:false,reason:'Stale candles'};
  }
  function swingPoints(candles, strength=3) {
    const highs=[], lows=[];
    for (let index=strength; index<candles.length-strength; index++) {
      const window=candles.slice(index-strength,index+strength+1), candle=candles[index];
      if (window.every((item,offset)=>offset===strength||candle.high>item.high)) highs.push({index,time:candle.time,price:candle.high});
      if (window.every((item,offset)=>offset===strength||candle.low<item.low)) lows.push({index,time:candle.time,price:candle.low});
    }
    return {highs,lows};
  }
  function recentStructure(candles) {
    const completed=candles.slice(0,-1), last=candles.at(-1), swings=swingPoints(completed,3);
    const highs=swings.highs.slice(-4), lows=swings.lows.slice(-4);
    if (highs.length<2||lows.length<2) return {label:'INSUFFICIENT STRUCTURE',support:null,resistance:null,breakout:null,failedBreakout:null,choch:null,retest:null,rejection:null,liquiditySweep:null,compression:false,expansion:false,exhaustion:false,swings};
    const lastHigh=highs.at(-1), previousHigh=highs.at(-2), lastLow=lows.at(-1), previousLow=lows.at(-2);
    const bullish=lastHigh.price>previousHigh.price&&lastLow.price>previousLow.price;
    const bearish=lastHigh.price<previousHigh.price&&lastLow.price<previousLow.price;
    const breakUp=last.close>lastHigh.price, breakDown=last.close<lastLow.price;
    const choch= bearish&&breakUp?'long':bullish&&breakDown?'short':null;
    const failedUp=last.high>lastHigh.price&&last.close<lastHigh.price;
    const failedDown=last.low<lastLow.price&&last.close>lastLow.price;
    const body=Math.abs(last.close-last.open), upperWick=last.high-Math.max(last.open,last.close), lowerWick=Math.min(last.open,last.close)-last.low;
    const rejection=upperWick>Math.max(body*2,(last.high-last.low)*.35)?'short':lowerWick>Math.max(body*2,(last.high-last.low)*.35)?'long':null;
    const currentAtr=atr(candles)||0, retestLong=completed.slice(-8).some(c=>c.close>lastHigh.price)&&last.low<=lastHigh.price+currentAtr*.2&&last.close>lastHigh.price;
    const retestShort=completed.slice(-8).some(c=>c.close<lastLow.price)&&last.high>=lastLow.price-currentAtr*.2&&last.close<lastLow.price;
    const recentAtr=mean(trueRanges(candles).slice(-10)), priorAtr=mean(trueRanges(candles).slice(-30,-10));
    const ema20Value=ema(candles.map(c=>c.close),20).at(-1), currentRsi=rsi(candles.map(c=>c.close));
    const exhaustion=(last.close>ema20Value+currentAtr*2.5&&currentRsi>75)?'long':(last.close<ema20Value-currentAtr*2.5&&currentRsi<25)?'short':null;
    const label=choch?`CHANGE OF CHARACTER ${choch.toUpperCase()}`:breakUp?'BULLISH BREAK OF STRUCTURE':breakDown?'BEARISH BREAK OF STRUCTURE':bullish?'HIGHER HIGH / HIGHER LOW':bearish?'LOWER HIGH / LOWER LOW':'RANGE / MIXED';
    return {
      label,support:lastLow.price,resistance:lastHigh.price,breakout:breakUp?'long':breakDown?'short':null,
      failedBreakout:failedUp?'short':failedDown?'long':null,choch,retest:retestLong?'long':retestShort?'short':null,
      rejection,liquiditySweep:failedUp?'short':failedDown?'long':null,compression:priorAtr?recentAtr/priorAtr<.72:false,
      expansion:priorAtr?recentAtr/priorAtr>1.55:false,exhaustion,trend:bullish?'long':bearish?'short':'range',swings
    };
  }
  function features(candles, barsPerDay = 6) {
    const validation=validateCandles(candles);
    if (!validation.valid) return { available:false,reason:validation.reason,dataQuality:validation };
    const clean = candles;
    const closes = clean.map(c => c.close), volumes = clean.map(c => Number(c.volume) || 0);
    const e9s = ema(closes, 9), e20s = ema(closes, 20), e50s = ema(closes, 50), e200s = ema(closes, 200);
    const last = clean.at(-1), currentAtr = atr(clean), averageAtr = mean(trueRanges(clean).slice(-50, -14));
    const volumeAverage = mean(volumes.slice(-21, -1).filter(value => value > 0));
    const macdLine = ema(closes, 12).map((value, index) => value - ema(closes, 26)[index]);
    const macdSignal = ema(macdLine, 9);
    const structure = recentStructure(clean);
    const returns = closes.slice(-31).slice(1).map((value, index) => Math.log(value / closes.slice(-31)[index]));
    return {
      available: true,
      dataQuality:validation,
      candles: clean,
      price: last.close,
      ema9: e9s.at(-1), ema20: e20s.at(-1), ema50: e50s.at(-1), ema200: clean.length >= 200 ? e200s.at(-1) : null,
      ema20Slope: pctChange(e20s.at(-6), e20s.at(-1)),
      ema50Slope: pctChange(e50s.at(-6), e50s.at(-1)),
      emaSeparation: Math.abs(e20s.at(-1) / e50s.at(-1) - 1) * 100,
      rsi: rsi(closes), roc5: pctChange(closes.at(-6), last.close), roc20: pctChange(closes.at(-21), last.close),
      acceleration: pctChange(closes.at(-6), last.close) - pctChange(closes.at(-11), closes.at(-6)),
      macd: macdLine.at(-1), macdSignal: macdSignal.at(-1),
      volumeAvailable: volumeAverage > 0,
      relativeVolume: volumeAverage > 0 ? (last.volume || 0) / volumeAverage : null,
      atr: currentAtr, atrPct: currentAtr / last.close * 100,
      volatilityExpansion: averageAtr ? currentAtr / averageAtr : 1,
      realisedVolatility: std(returns) * Math.sqrt(Math.max(1, barsPerDay * 365)) * 100,
      vwap: rollingVwap(clean, Math.max(3, barsPerDay)),
      structure,
      recentHigh: Math.max(...clean.slice(-21, -1).map(c => c.high)),
      recentLow: Math.min(...clean.slice(-21, -1).map(c => c.low)),
      timestamp: last.time
    };
  }
  function classifyRegime(frame) {
    if (!frame.available) return 'ANALYSIS UNAVAILABLE';
    const up = frame.price > frame.ema20 && frame.ema20 > frame.ema50;
    const down = frame.price < frame.ema20 && frame.ema20 < frame.ema50;
    if (frame.structure.retest) return 'BREAKOUT RETEST';
    if (frame.structure.breakout) return 'BREAKOUT';
    if (frame.structure.compression || (frame.volatilityExpansion < 0.72 && frame.emaSeparation < 1)) return 'COMPRESSION';
    if (!up && !down && frame.atrPct > 4) return 'HIGH-VOLATILITY RANGE';
    if (up && frame.ema20Slope > 0.7 && frame.emaSeparation > 1.2) return 'STRONG UPTREND';
    if (up) return 'WEAK UPTREND';
    if (down && frame.ema20Slope < -0.7 && frame.emaSeparation > 1.2) return 'STRONG DOWNTREND';
    if (down) return 'WEAK DOWNTREND';
    return 'RANGE';
  }
  function strategyCandidates(frame) {
    if (!frame.available) return [];
    const candidates=[], volumeRatio=frame.volumeAvailable?frame.relativeVolume:0.75;
    const add=(strategy,direction,score,reasons,invalidation,entryReason,invalidationReason)=>candidates.push({strategy,direction,score:clamp(score,0,100),reasons,invalidation,entryReason,invalidationReason});
    const upTrend=frame.price>frame.ema20&&frame.ema20>frame.ema50&&frame.ema20Slope>0&&frame.structure.trend!=='short';
    const downTrend=frame.price<frame.ema20&&frame.ema20<frame.ema50&&frame.ema20Slope<0&&frame.structure.trend!=='long';
    const extended=Math.abs(frame.price-frame.ema20)>frame.atr*2.2;
    if (upTrend&&!extended&&!frame.structure.exhaustion&&frame.rsi>=48&&frame.rsi<=68&&volumeRatio>=.8)
      add('TREND CONTINUATION','long',68+frame.emaSeparation*3+Math.min(10,volumeRatio*5),['Rising EMA20/EMA50 structure','Pullback remains within trend value','Momentum is constructive without exhaustion'],Math.min(frame.structure.support||frame.ema50,frame.ema50),'Pullback held bullish structure and resumed','A confirmed close below the latest higher low / EMA50');
    if (downTrend&&!extended&&!frame.structure.exhaustion&&frame.rsi>=32&&frame.rsi<=52&&volumeRatio>=.8)
      add('TREND CONTINUATION','short',68+frame.emaSeparation*3+Math.min(10,volumeRatio*5),['Falling EMA20/EMA50 structure','Bounce remains within trend value','Momentum is weak without downside exhaustion'],Math.max(frame.structure.resistance||frame.ema50,frame.ema50),'Relief bounce failed below bearish structure','A confirmed close above the latest lower high / EMA50');
    if (frame.structure.retest==='long'&&volumeRatio>=1)
      add('BREAKOUT + RETEST','long',76+Math.min(10,(volumeRatio-1)*15),['Prior resistance broke','Retest held above the broken level','Volume is not below normal'],frame.structure.resistance-frame.atr*.35,'Confirmed retest of broken resistance','A close back below the retest zone');
    if (frame.structure.retest==='short'&&volumeRatio>=1)
      add('BREAKOUT + RETEST','short',76+Math.min(10,(volumeRatio-1)*15),['Prior support broke','Retest failed below the broken level','Volume is not below normal'],frame.structure.support+frame.atr*.35,'Confirmed retest of broken support','A close back above the retest zone');
    if (upTrend&&frame.roc5>2&&frame.acceleration>0&&frame.rsi>=55&&frame.rsi<=70&&frame.macd>frame.macdSignal&&volumeRatio>=1.1&&!extended)
      add('MOMENTUM CONTINUATION','long',70+Math.min(12,frame.roc5*1.5),['Trend and momentum agree','Acceleration is positive','Volume expansion confirms the move'],frame.ema20,'Momentum re-expanded from an established uptrend','Momentum failure and close below EMA20');
    if (downTrend&&frame.roc5<-2&&frame.acceleration<0&&frame.rsi>=30&&frame.rsi<=45&&frame.macd<frame.macdSignal&&volumeRatio>=1.1&&!extended)
      add('MOMENTUM CONTINUATION','short',70+Math.min(12,Math.abs(frame.roc5)*1.5),['Trend and momentum agree','Acceleration is negative','Volume expansion confirms the move'],frame.ema20,'Momentum re-expanded from an established downtrend','Momentum failure and close above EMA20');
    const regime=classifyRegime(frame);
    if (['RANGE','HIGH-VOLATILITY RANGE'].includes(regime)&&frame.rsi<30&&['long',null].includes(frame.structure.rejection)&&frame.price<=frame.structure.support+frame.atr)
      add('MEAN REVERSION','long',68+(30-frame.rsi),['Range regime','Oversold momentum','Rejection formed near confirmed support'],frame.structure.support-frame.atr*.3,'Rejection at range support','A close below the range support zone');
    if (['RANGE','HIGH-VOLATILITY RANGE'].includes(regime)&&frame.rsi>70&&['short',null].includes(frame.structure.rejection)&&frame.price>=frame.structure.resistance-frame.atr)
      add('MEAN REVERSION','short',68+(frame.rsi-70),['Range regime','Overbought momentum','Rejection formed near confirmed resistance'],frame.structure.resistance+frame.atr*.3,'Rejection at range resistance','A close above the range resistance zone');
    if (frame.structure.liquiditySweep==='long'&&(frame.structure.choch==='long'||frame.structure.rejection==='long'))
      add('LIQUIDITY-SWEEP REVERSAL','long',78,['Liquidity swept below a confirmed swing','Price closed back above the level','Structure/rejection supports reversal'],frame.structure.support-frame.atr*.25,'Sweep and reclaim of support','A new close below the swept low');
    if (frame.structure.liquiditySweep==='short'&&(frame.structure.choch==='short'||frame.structure.rejection==='short'))
      add('LIQUIDITY-SWEEP REVERSAL','short',78,['Liquidity swept above a confirmed swing','Price closed back below the level','Structure/rejection supports reversal'],frame.structure.resistance+frame.atr*.25,'Sweep and rejection of resistance','A new close above the swept high');
    return candidates.sort((a,b)=>b.score-a.score);
  }
  function timeframeBias(frame) {
    if (!frame || !frame.available) return null;
    if (frame.price > frame.ema20 && frame.ema20 > frame.ema50) return 'long';
    if (frame.price < frame.ema20 && frame.ema20 < frame.ema50) return 'short';
    return 'neutral';
  }
  function socialAdjustment(social, direction) {
    if (!social || !social.sample || social.sample < 5) return { points: 0, text: 'No authorised social sample large enough to use' };
    const aligned = direction === 'long' ? social.weightedLong : social.weightedShort;
    const points = clamp((aligned - 0.5) * 30, -10, 10) * clamp(social.reliability / 70, 0, 1);
    return { points, text: `${Math.round(aligned * 100)}% reliability-weighted ${direction.toUpperCase()} across ${social.sample} imported records` };
  }
  function riskPlan(params) {
    const {
      balance, riskPct, maxLeverage, entry, stop, direction, minNotional = 10,
      feePct = 0.0005, slippagePct = 0.0003, maxExposurePct = 1
    } = params;
    if (![balance, riskPct, maxLeverage, entry, stop].every(value => Number.isFinite(value) && value > 0)) return { valid: false, reason: 'Invalid account or price inputs' };
    const stopPct = Math.abs(entry - stop) / entry;
    if (!stopPct) return { valid: false, reason: 'Stop distance is zero' };
    const maxLoss = balance * riskPct;
    const roundTripCostPct = feePct * 2 + slippagePct * 2;
    const riskPerNotional = stopPct + roundTripCostPct;
    const riskSizedNotional = maxLoss / riskPerNotional;
    const exposureCap = balance * Math.max(0, maxExposurePct);
    const notional = Math.min(riskSizedNotional, exposureCap || riskSizedNotional);
    if (notional < minNotional) return { valid: false, reason: 'ACCOUNT/MINIMUM SIZE CONSTRAINT', maxLoss, riskSizedNotional: notional, minimumNotional: minNotional };
    const allowed = LEVERAGE_CHOICES.filter(value => value <= maxLeverage);
    const leverage = allowed.find(value => notional / value <= balance) || allowed.at(-1);
    if (!leverage || notional / leverage > balance) return { valid: false, reason: 'Insufficient margin at selected maximum leverage' };
    const margin = notional / leverage;
    const lossAtStop = notional * riskPerNotional;
    const rawLiquidation = direction === 'long' ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
    const liquidationDistancePct = Math.abs(entry - rawLiquidation) / entry;
    const stopBeforeLiquidation = direction === 'long' ? stop > rawLiquidation : stop < rawLiquidation;
    const liquidationBuffer = liquidationDistancePct - stopPct;
    if (leverage > 1 && (!stopBeforeLiquidation || liquidationBuffer < Math.max(0.01, stopPct * 0.35))) {
      return { valid: false, reason: 'LIQUIDATION TOO CLOSE TO PLANNED STOP', maxLoss, notional, margin, leverage, lossAtStop, estimatedLiquidation: rawLiquidation, liquidationDistancePct };
    }
    return { valid: true, maxLoss, notional, margin, leverage, lossAtStop, stopPct, estimatedLiquidation: rawLiquidation, liquidationDistancePct, roundTripCostPct };
  }
  function opportunityScore(frames){const h4=frames.h4,h1=frames.h1,m15=frames.m15,m5=frames.m5,d1=frames.d1;if(!h4?.available)return {score:null,components:{data:0}};let trend=0,structure=0,momentum=0,volume=0,regime=0,location=0,conflict=0,extension=0,data=0;const bias=frame=>frame.price>frame.ema20&&frame.ema20>frame.ema50?'long':frame.price<frame.ema20&&frame.ema20<frame.ema50?'short':'neutral',biases=[bias(d1),bias(h4),bias(h1),bias(m15),bias(m5)],active=biases.filter(v=>v!=='neutral');trend=active.length?Math.round(active.filter(v=>v===active[0]).length/active.length*24):8;structure=h1.structure?.trend!=='neutral'?14:6;momentum=Math.round(clamp(12-Math.abs((h1.rsi||50)-50)*.22+Math.min(4,Math.abs(h1.roc5||0)),0,16));volume=Math.round(clamp((m15.relativeVolume||0)*8,0,12));regime=['COMPRESSION','HIGH-VOLATILITY RANGE'].includes(classifyRegime(h4))?5:12;location=Math.abs(m5.price-m5.ema20)<m5.atr*1.5?10:4;conflict=(new Set(active).size>1)?-12:0;extension=Math.abs(m5.price-m5.ema20)>m5.atr*2.2?-10:0;data=h4.dataQuality?.warnings?.length?-8:6;const components={trend,structure,momentum,volume,regime,location,conflict,extension,data};return{score:Math.round(clamp(Object.values(components).reduce((a,b)=>a+b,0),0,100)),components};}
  function evaluateSetup(input) {
    const settings=Object.assign({minQuality:72,minRR:1.8,balance:7,riskPct:.01,maxLeverage:10,minNotional:10,maxExposurePct:1,requireMTF:true},input.settings||{});
    const frames=input.timeframes||{}, tf={
      m5:features(frames.m5||[],288),m15:features(frames.m15||[],96),h1:features(frames.h1||[],24),
      h4:features(frames.h4||frames.primary||[],6),d1:features(frames.d1||[],1)
    };
    const primary=tf.h4;
    if (!primary.available) return {decision:'ANALYSIS UNAVAILABLE',quality:0,reason:primary.reason,frame:primary,timeframes:tf};
    const required=[tf.m5,tf.m15,tf.h1,tf.d1], missing=required.filter(frame=>!frame.available);
    if (settings.requireMTF&&missing.length) return {decision:'ANALYSIS UNAVAILABLE',quality:0,reason:`${missing.length} required timeframe${missing.length===1?' is':'s are'} unavailable`,frame:primary,timeframes:tf};
    const setup=tf.h1.available?tf.h1:primary, confirmation=tf.m15.available?tf.m15:setup, execution=tf.m5.available?tf.m5:confirmation;
    const regime=classifyRegime(primary), macroRegime=tf.d1.available?classifyRegime(tf.d1):'UNAVAILABLE';
    const candidates=strategyCandidates(setup);
    const opportunity=opportunityScore(tf);
    if (!candidates.length) return {decision:'NO TRADE',quality:null,setupQuality:null,opportunity,reason:'No independent strategy satisfies its entry rules',regime,macroRegime,frame:primary,timeframes:tf};
    const requested=input.selectedCandidate;
    const best=requested?candidates.find(candidate=>candidate.strategy===requested.strategy&&candidate.direction===requested.direction):candidates[0];
    if (!best) return {decision:'NO TRADE',quality:null,setupQuality:null,opportunity,reason:'Requested strategy candidate is no longer legitimate',regime,macroRegime,frame:primary,timeframes:tf};
    const opposite=candidates.find(candidate=>candidate.direction!==best.direction);
    if (!requested&&opposite&&Math.abs(best.score-opposite.score)<10) return {decision:'NO TRADE',quality:Math.round(best.score),reason:`Contradictory ${best.strategy} and ${opposite.strategy} signals`,regime,macroRegime,frame:primary,timeframes:tf};
    const direction=best.direction, macroBias=timeframeBias(tf.d1), primaryBias=timeframeBias(primary), setupBias=timeframeBias(setup), confirmationBias=timeframeBias(confirmation), executionBias=timeframeBias(execution);
    const meanReversion=best.strategy==='MEAN REVERSION', reversal=best.strategy==='LIQUIDITY-SWEEP REVERSAL';
    const strongMacroOpposition=(direction==='long'&&macroRegime==='STRONG DOWNTREND')||(direction==='short'&&macroRegime==='STRONG UPTREND');
    if (strongMacroOpposition) return {decision:'NO TRADE',quality:Math.round(best.score-15),reason:`${direction.toUpperCase()} conflicts with the ${macroRegime} daily regime`,direction,strategy:best.strategy,regime,macroRegime,frame:primary,timeframes:tf};
    if (!meanReversion&&!reversal&&primaryBias!==direction) return {decision:'NO TRADE',quality:Math.round(best.score-12),reason:`${direction.toUpperCase()} setup conflicts with the 4h primary direction`,direction,strategy:best.strategy,regime,macroRegime,frame:primary,timeframes:tf};
    if (!meanReversion&&[confirmationBias,executionBias].filter(bias=>bias&&bias!==direction&&bias!=='neutral').length>=2) return {decision:'WAIT',quality:Math.round(best.score-8),reason:'15m confirmation and 5m execution timing both oppose the setup',direction,strategy:best.strategy,regime,macroRegime,frame:primary,timeframes:tf};
    if (['HIGH-VOLATILITY RANGE','COMPRESSION'].includes(regime)&&['TREND CONTINUATION','MOMENTUM CONTINUATION'].includes(best.strategy)) return {decision:'NO TRADE',quality:Math.round(best.score-10),reason:`${best.strategy} is disabled in the ${regime} regime`,direction,strategy:best.strategy,regime,macroRegime,frame:primary,timeframes:tf};
    const social=socialAdjustment(input.social,direction), aligned=[macroBias,primaryBias,setupBias,confirmationBias,executionBias].filter(bias=>bias===direction).length;
    const opposed=[macroBias,primaryBias,setupBias,confirmationBias,executionBias].filter(bias=>bias&&bias!==direction&&bias!=='neutral').length;
    let quality=best.score+aligned*3-opposed*8+social.points;
    if (setup.volumeAvailable&&setup.relativeVolume<.8) quality-=10;
    if (setup.volatilityExpansion>2.2||setup.structure.exhaustion===direction) quality-=10;
    if (primary.dataQuality?.warnings?.length||setup.dataQuality?.warnings?.length) quality-=5;
    quality=Math.round(clamp(quality,0,100));
    let idealEntry=setup.price;
    if (best.strategy==='TREND CONTINUATION'||best.strategy==='MOMENTUM CONTINUATION') idealEntry=setup.ema20;
    if (best.strategy==='BREAKOUT + RETEST') idealEntry=direction==='long'?setup.structure.resistance:setup.structure.support;
    if (best.strategy==='MEAN REVERSION'||best.strategy==='LIQUIDITY-SWEEP REVERSAL') idealEntry=direction==='long'?setup.structure.support:setup.structure.resistance;
    if (!Number.isFinite(idealEntry)) idealEntry=setup.price;
    const zoneHalf=setup.atr*.25, entryZone={low:idealEntry-zoneHalf,high:idealEntry+zoneHalf}, entry=execution.price;
    const chaseDistance=Math.abs(entry-idealEntry)/setup.atr, chased=(direction==='long'&&entry>entryZone.high+setup.atr*.35)||(direction==='short'&&entry<entryZone.low-setup.atr*.35);
    let stop=direction==='long'?(best.invalidation-setup.atr*.15):(best.invalidation+setup.atr*.15);
    if (!Number.isFinite(stop)||(direction==='long'&&stop>=entry)||(direction==='short'&&stop<=entry)) stop=direction==='long'?entry-setup.atr*1.25:entry+setup.atr*1.25;
    const riskDistance=Math.abs(entry-stop), rr1=Math.max(settings.minRR,1.8), rr2=Math.max(rr1+1,3);
    const target1=direction==='long'?entry+riskDistance*rr1:entry-riskDistance*rr1;
    const target2=direction==='long'?entry+riskDistance*rr2:entry-riskDistance*rr2;
    const risk=riskPlan({balance:settings.balance,riskPct:settings.riskPct,maxLeverage:settings.maxLeverage,entry,stop,direction,minNotional:settings.minNotional,maxExposurePct:settings.maxExposurePct});
    const alignment={m5:executionBias,m15:confirmationBias,h1:setupBias,h4:primaryBias,d1:macroBias,aligned,opposed};
    const reasons=[...best.reasons,`Timeframes aligned ${aligned}/5; opposed ${opposed}/5`,social.text];
    const base={quality,setupQuality:quality,opportunity,direction,strategy:best.strategy,regime,macroRegime,entry,idealEntry,entryZone,stop,target:target1,target1,target2,rr:rr1,rr1,rr2,risk,reasons,frame:primary,timeframes:tf,alignment,entryReason:best.entryReason,invalidationCondition:best.invalidationReason,trailingRule:'After TP1, move the stop only after a new confirmed 15m swing; trail beyond that swing with a 0.25 ATR buffer',chaseDistance};
    if (chased) return {...base,decision:'WAIT',reason:'Current price has moved beyond the intended entry zone; do not chase'};
    if (quality<settings.minQuality) return {...base,decision:quality>=settings.minQuality-10?'WAIT':'NO TRADE',reason:`Setup quality is below the configured ${settings.minQuality}/100 research threshold`};
    if (!risk.valid) return {...base,decision:'NO TRADE',reason:risk.reason};
    return {...base,decision:'TAKE TRADE',reason:`${best.strategy} passes regime, timeframe, entry, cost and risk checks`};
  }
  function evaluateSetupCandidates(input) {
    const baseline=evaluateSetup(input), setup=baseline.timeframes?.h1?.available?baseline.timeframes.h1:baseline.frame;
    if (!setup?.available) return [];
    return strategyCandidates(setup).map(candidate=>{
      const evaluated=evaluateSetup({...input,selectedCandidate:{strategy:candidate.strategy,direction:candidate.direction}});
      return {...evaluated,candidateKey:`${candidate.strategy}:${candidate.direction}`,quantStrategyScore:candidate.score};
    });
  }
  function performanceStats(trades) {
    const results = trades.map(trade => trade.r).filter(Number.isFinite), wins = results.filter(r => r > 0), losses = results.filter(r => r <= 0);
    let equity = 0, peak = 0, maxDrawdown = 0, compounded=1, compoundedPeak=1, maxDrawdownPct=0;
    trades.filter(trade=>Number.isFinite(trade.r)).forEach(trade => {
      equity += trade.r; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
      compounded*=Math.max(.0001,1+trade.r*Math.max(.0001,Number(trade.riskPct)||.01));
      compoundedPeak=Math.max(compoundedPeak,compounded); maxDrawdownPct=Math.max(maxDrawdownPct,compoundedPeak?(compoundedPeak-compounded)/compoundedPeak:0);
    });
    const averageWin = mean(wins), averageLoss = Math.abs(mean(losses));
    const variance = std(results), downside = std(losses), mfe=trades.map(trade=>trade.mfeR).filter(Number.isFinite), mae=trades.map(trade=>trade.maeR).filter(Number.isFinite), duration=trades.map(trade=>trade.barsHeld).filter(Number.isFinite);
    return {
      trades: results.length, wins: wins.length, losses: losses.length,
      winRate: results.length ? wins.length / results.length : 0,
      averageWin, averageLoss,
      averageR: mean(results), medianR:median(results), expectancy: mean(results),
      profitFactor: losses.length && averageLoss ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : null,
      maxDrawdownR: maxDrawdown, maxDrawdownPct, totalR: results.reduce((a, b) => a + b, 0),
      averageMfeR:mean(mfe),averageMaeR:mean(mae),averageBarsHeld:mean(duration),
      sampleTier:results.length>=100?'decision-useful':results.length>=30?'directional':results.length>=10?'early':'tiny',
      sharpe: variance ? mean(results) / variance * Math.sqrt(Math.max(1, results.length)) : null,
      sortino: downside ? mean(results) / downside * Math.sqrt(Math.max(1, results.length)) : null
    };
  }
  function simulateBacktest(candles, settings, rangeStart=220, rangeEnd=candles.length-1) {
    const trades=[], start=Math.max(220,rangeStart), end=Math.min(candles.length-1,rangeEnd);
    for (let index=start; index<end-1; index++) {
      const history=candles.slice(0,index+1);
      const setup=evaluateSetup({timeframes:{h4:history},settings:Object.assign({},settings,{balance:10000,minNotional:1,maxExposurePct:100,requireMTF:false})});
      if (setup.decision!=='TAKE TRADE') continue;
      const next=candles[index+1], entry=next.open*(setup.direction==='long'?1.0003:.9997);
      const stopDistance=Math.abs(setup.entry-setup.stop);
      if (!stopDistance||!Number.isFinite(stopDistance)) continue;
      const stop=setup.direction==='long'?entry-stopDistance:entry+stopDistance;
      const tp1=setup.direction==='long'?entry+stopDistance*setup.rr1:entry-stopDistance*setup.rr1;
      const tp2=setup.direction==='long'?entry+stopDistance*setup.rr2:entry-stopDistance*setup.rr2;
      let exitIndex=Math.min(end,index+30),grossR=0,tp1Hit=false,mfeR=0,maeR=0;
      for (let cursor=index+1;cursor<=Math.min(end,index+30);cursor++) {
        const candle=candles[cursor], activeStop=tp1Hit?entry:stop;
        const favorable=(setup.direction==='long'?candle.high-entry:entry-candle.low)/stopDistance;
        const adverse=(setup.direction==='long'?candle.low-entry:entry-candle.high)/stopDistance;
        mfeR=Math.max(mfeR,favorable); maeR=Math.min(maeR,adverse);
        const hitStop=setup.direction==='long'?candle.low<=activeStop:candle.high>=activeStop;
        const hitFirst=setup.direction==='long'?candle.high>=tp1:candle.low<=tp1;
        const hitSecond=setup.direction==='long'?candle.high>=tp2:candle.low<=tp2;
        if (hitStop) { grossR=tp1Hit?setup.rr1*.5:-1; exitIndex=cursor; break; }
        if (!tp1Hit&&hitFirst) tp1Hit=true;
        if (tp1Hit&&hitSecond) { grossR=setup.rr1*.5+setup.rr2*.5; exitIndex=cursor; break; }
        if (cursor===Math.min(end,index+30)) {
          const move=(setup.direction==='long'?candle.close-entry:entry-candle.close)/stopDistance;
          grossR=tp1Hit?setup.rr1*.5+Math.max(0,move)*.5:move;
        }
      }
      const feePct=Math.max(0,Number(settings.feePct??.0005)),slippagePct=Math.max(0,Number(settings.slippagePct??.0003));
      const costR=(feePct*2+slippagePct*2)/(stopDistance/entry),riskPct=Math.max(.0001,Number(settings.riskPct)||.01);
      trades.push({signalIndex:index,entryIndex:index+1,exitIndex,timestamp:candles[index].time,direction:setup.direction,strategy:setup.strategy,regime:setup.regime,quality:setup.quality,r:grossR-costR,grossR,costR,riskPct,mfeR,maeR,barsHeld:exitIndex-index,tp1Hit});
      index=exitIndex;
    }
    return trades;
  }
  function groupedStats(trades,key) {
    return trades.reduce((groups,trade)=>{ const value=typeof key==='function'?key(trade):trade[key]; (groups[value]||=[]).push(trade); return groups; },{});
  }
  function summarizeGroups(groups) { return Object.fromEntries(Object.entries(groups).map(([key,trades])=>[key,performanceStats(trades)])); }
  function parameterGrid(settings) {
    const quality=[settings.minQuality||72].flatMap(value=>[value-5,value,value+5]).map(value=>clamp(Math.round(value),55,95));
    const rr=[settings.minRR||1.8].flatMap(value=>[value-.2,value,value+.2]).map(value=>clamp(+value.toFixed(1),1.2,3));
    return [...new Map(quality.flatMap(minQuality=>rr.map(minRR=>({minQuality,minRR}))).map(item=>[`${item.minQuality}-${item.minRR}`,item])).values()];
  }
  function walkForwardTest(candles,settings) {
    const grid=parameterGrid(settings), foldTestTrades=[], folds=[];
    const validationSize=Math.max(50,Math.floor(candles.length*.12)), testSize=validationSize;
    for (let trainEnd=Math.max(260,Math.floor(candles.length*.5));trainEnd+validationSize+testSize<=candles.length;trainEnd+=testSize) {
      const validationEnd=trainEnd+validationSize,testEnd=validationEnd+testSize;
      let selected=null;
      for (const params of grid) {
        const candidate=Object.assign({},settings,params), train=performanceStats(simulateBacktest(candles,candidate,220,trainEnd)), validation=performanceStats(simulateBacktest(candles,candidate,trainEnd,validationEnd));
        if (train.trades<3||train.expectancy<=0||validation.trades<2) continue;
        const score=validation.expectancy-validation.maxDrawdownR*.03;
        if (!selected||score>selected.score) selected={params,train,validation,score};
      }
      if (!selected) { folds.push({trainEnd,validationEnd,testEnd,selected:null,test:performanceStats([])}); continue; }
      const unseen=simulateBacktest(candles,Object.assign({},settings,selected.params),validationEnd,testEnd);
      foldTestTrades.push(...unseen); folds.push({...selected,trainEnd,validationEnd,testEnd,test:performanceStats(unseen)});
    }
    const stabilityChecks=grid.map(params=>({params,stats:performanceStats(simulateBacktest(candles,Object.assign({},settings,params),Math.floor(candles.length*.6),candles.length-1))}));
    const positive=stabilityChecks.filter(item=>item.stats.trades>=2&&item.stats.expectancy>0).length;
    return {folds,aggregate:performanceStats(foldTestTrades),unseenTrades:foldTestTrades,stability:{tested:grid.length,positive,positiveFraction:grid.length?positive/grid.length:0,stable:grid.length?positive/grid.length>=.4:false,checks:stabilityChecks}};
  }
  function backtest(candles,settings={}) {
    const trades=simulateBacktest(candles,settings,220,candles.length-1);
    const trainEnd=Math.floor(candles.length*.6),validationEnd=Math.floor(candles.length*.8);
    const training=trades.filter(trade=>trade.signalIndex<trainEnd),validation=trades.filter(trade=>trade.signalIndex>=trainEnd&&trade.signalIndex<validationEnd),test=trades.filter(trade=>trade.signalIndex>=validationEnd);
    const qualityBucket=trade=>trade.quality>=90?'90+':trade.quality>=80?'80-89':trade.quality>=70?'70-79':'60-69';
    const period=trade=>new Date(trade.timestamp).getUTCFullYear().toString();
    const costSensitivity=[.0008,.0016,.0025,.004].map(roundTripCostPct=>{
      const component=roundTripCostPct/4,scenarioTrades=simulateBacktest(candles,{...settings,feePct:component,slippagePct:component},220,candles.length-1);
      return {roundTripCostPct,stats:performanceStats(scenarioTrades)};
    });
    return {
      trades,training:performanceStats(training),validation:performanceStats(validation),test:performanceStats(test),overall:performanceStats(trades),
      byDirection:summarizeGroups(groupedStats(trades,'direction')),byStrategy:summarizeGroups(groupedStats(trades,'strategy')),
      byRegime:summarizeGroups(groupedStats(trades,'regime')),byQuality:summarizeGroups(groupedStats(test,qualityBucket)),
      byPeriod:summarizeGroups(groupedStats(trades,period)),walkForward:walkForwardTest(candles,settings),costSensitivity,
      executionModel:{entry:'next-bar open with directional slippage',sameCandle:'stop first',exit:'50% TP1 / 50% TP2; breakeven stop after TP1; 30-bar maximum',feePct:Number(settings.feePct??.0005),slippagePct:Number(settings.slippagePct??.0003),funding:'not modeled'}
    };
  }
  function traderReliability(record) {
    const trades = Math.max(0, Number(record.trades || ((record.wins || 0) + (record.losses || 0)))), wins = Math.max(0, Number(record.wins || 0));
    const winRate = trades ? wins / trades : 0, expectancy = Number(record.expectancy || 0), drawdown = Math.max(0, Number(record.maxDrawdown || 0)), leverage = Math.max(1, Number(record.leverage || 1));
    const sample = clamp(Math.log10(trades + 1) / 2, 0, 1) * 35;
    const consistency = clamp((winRate - 0.4) / 0.3, 0, 1) * 20;
    const edge = clamp(expectancy / 0.5, -1, 1) * 25;
    const risk = 20 - clamp(drawdown, 0, 50) * 0.25 - Math.max(0, leverage - 3) * 1.5;
    return Math.round(clamp(sample + consistency + edge + risk, 0, 100));
  }
  function aggregateSocial(records, symbol) {
    const relevant = (records || []).filter(record => String(record.asset || '').toUpperCase() === symbol.toUpperCase());
    let longWeight = 0, shortWeight = 0;
    relevant.forEach(record => {
      const reliability = traderReliability(record), weight = Math.max(0.05, reliability / 100);
      if (String(record.direction || '').toLowerCase() === 'long') longWeight += weight;
      if (String(record.direction || '').toLowerCase() === 'short') shortWeight += weight;
    });
    const total = longWeight + shortWeight;
    return { sample: relevant.length, reliability: relevant.length ? mean(relevant.map(traderReliability)) : 0, weightedLong: total ? longWeight / total : 0.5, weightedShort: total ? shortWeight / total : 0.5 };
  }
  return { VERSION, LEVERAGE_CHOICES, clamp, mean, median, std, ema, sma, rsi, atr, rollingVwap, validateCandles, validateFreshness, swingPoints, features, recentStructure, classifyRegime, strategyCandidates, riskPlan, opportunityScore, evaluateSetup, evaluateSetupCandidates, performanceStats, simulateBacktest, walkForwardTest, backtest, traderReliability, aggregateSocial };
});
