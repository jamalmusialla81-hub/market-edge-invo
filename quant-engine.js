(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MarketEdgeQuant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const LEVERAGE_CHOICES = [1, 2, 3, 5, 10];

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
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
  function recentStructure(candles) {
    const completed = candles.slice(0, -1), lookback = completed.slice(-40);
    if (lookback.length < 12) return { label: 'INSUFFICIENT', support: null, resistance: null, breakout: false, failedBreakout: false };
    const previous = lookback.slice(0, -5), recent = lookback.slice(-5);
    const oldHigh = Math.max(...previous.map(c => c.high)), oldLow = Math.min(...previous.map(c => c.low));
    const recentHigh = Math.max(...recent.map(c => c.high)), recentLow = Math.min(...recent.map(c => c.low));
    const last = candles.at(-1), breakoutUp = last.close > oldHigh, breakoutDown = last.close < oldLow;
    const failedUp = last.high > oldHigh && last.close < oldHigh;
    const failedDown = last.low < oldLow && last.close > oldLow;
    const label = breakoutUp ? 'BULLISH BREAK OF STRUCTURE' : breakoutDown ? 'BEARISH BREAK OF STRUCTURE'
      : recentHigh > oldHigh && recentLow > oldLow ? 'HIGHER HIGH / HIGHER LOW'
      : recentHigh < oldHigh && recentLow < oldLow ? 'LOWER HIGH / LOWER LOW'
      : 'RANGE / MIXED';
    return {
      label,
      support: Math.min(...recent.map(c => c.low)),
      resistance: Math.max(...recent.map(c => c.high)),
      breakout: breakoutUp ? 'long' : breakoutDown ? 'short' : null,
      failedBreakout: failedUp ? 'short' : failedDown ? 'long' : null
    };
  }
  function features(candles, barsPerDay = 6) {
    if (!Array.isArray(candles) || candles.length < 60) return { available: false, reason: 'Fewer than 60 complete candles' };
    const clean = candles.filter(candle => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
    if (clean.length < 60) return { available: false, reason: 'Missing or invalid candle values' };
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
    if (frame.structure.breakout) return 'BREAKOUT';
    if (frame.volatilityExpansion < 0.72 && frame.emaSeparation < 1) return 'COMPRESSION';
    if (!up && !down && frame.atrPct > 4) return 'HIGH-VOLATILITY RANGE';
    if (up && frame.ema20Slope > 0.7 && frame.emaSeparation > 1.2) return 'STRONG UPTREND';
    if (up) return 'WEAK UPTREND';
    if (down && frame.ema20Slope < -0.7 && frame.emaSeparation > 1.2) return 'STRONG DOWNTREND';
    if (down) return 'WEAK DOWNTREND';
    return 'RANGE';
  }
  function strategyCandidates(frame) {
    if (!frame.available) return [];
    const candidates = [], volumeOK = !frame.volumeAvailable || frame.relativeVolume >= 0.9;
    const add = (strategy, direction, score, reasons, invalidation) => candidates.push({ strategy, direction, score: clamp(score, 0, 100), reasons, invalidation });
    const upTrend = frame.price > frame.ema20 && frame.ema20 > frame.ema50 && frame.ema20Slope > 0;
    const downTrend = frame.price < frame.ema20 && frame.ema20 < frame.ema50 && frame.ema20Slope < 0;
    if (upTrend && frame.rsi >= 48 && frame.rsi <= 70) add('TREND FOLLOWING', 'long', 66 + frame.emaSeparation * 4 + (volumeOK ? 8 : -8), ['Price above rising EMA20 and EMA50', `RSI ${frame.rsi.toFixed(0)} supports continuation`, volumeOK ? 'Volume is adequate' : 'Volume confirmation is weak'], Math.min(frame.structure.support || frame.ema50, frame.ema50));
    if (downTrend && frame.rsi >= 30 && frame.rsi <= 52) add('TREND FOLLOWING', 'short', 66 + frame.emaSeparation * 4 + (volumeOK ? 8 : -8), ['Price below falling EMA20 and EMA50', `RSI ${frame.rsi.toFixed(0)} supports downside continuation`, volumeOK ? 'Volume is adequate' : 'Volume confirmation is weak'], Math.max(frame.structure.resistance || frame.ema50, frame.ema50));
    if (frame.structure.breakout === 'long') add('BREAKOUT', 'long', 70 + (frame.relativeVolume ? Math.min(15, (frame.relativeVolume - 1) * 20) : 0), ['Close broke above the prior 20-bar range', frame.volumeAvailable ? `Relative volume ${frame.relativeVolume.toFixed(1)}×` : 'Volume unavailable; score reduced'], frame.recentHigh);
    if (frame.structure.breakout === 'short') add('BREAKOUT', 'short', 70 + (frame.relativeVolume ? Math.min(15, (frame.relativeVolume - 1) * 20) : 0), ['Close broke below the prior 20-bar range', frame.volumeAvailable ? `Relative volume ${frame.relativeVolume.toFixed(1)}×` : 'Volume unavailable; score reduced'], frame.recentLow);
    if (frame.roc5 > 2 && frame.rsi >= 55 && frame.rsi <= 72 && frame.macd > frame.macdSignal) add('MOMENTUM', 'long', 62 + Math.min(20, frame.roc5 * 2) + (volumeOK ? 7 : -7), ['Positive rate of change', 'MACD momentum is positive', 'RSI is strong without being extreme'], frame.ema20);
    if (frame.roc5 < -2 && frame.rsi >= 28 && frame.rsi <= 45 && frame.macd < frame.macdSignal) add('MOMENTUM', 'short', 62 + Math.min(20, Math.abs(frame.roc5) * 2) + (volumeOK ? 7 : -7), ['Negative rate of change', 'MACD momentum is negative', 'RSI confirms weakness without being extreme'], frame.ema20);
    const regime = classifyRegime(frame);
    if (['RANGE', 'HIGH-VOLATILITY RANGE'].includes(regime) && frame.rsi < 31) add('MEAN REVERSION', 'long', 65 + (31 - frame.rsi), ['Range regime detected', `RSI ${frame.rsi.toFixed(0)} is stretched`, 'Entry is near range support'], frame.recentLow - frame.atr * 0.25);
    if (['RANGE', 'HIGH-VOLATILITY RANGE'].includes(regime) && frame.rsi > 69) add('MEAN REVERSION', 'short', 65 + (frame.rsi - 69), ['Range regime detected', `RSI ${frame.rsi.toFixed(0)} is stretched`, 'Entry is near range resistance'], frame.recentHigh + frame.atr * 0.25);
    if (frame.structure.failedBreakout) add('REVERSAL', frame.structure.failedBreakout, 72 + (volumeOK ? 6 : -6), ['Failed break of the prior range', 'Price closed back inside structure', volumeOK ? 'Volume supports the rejection' : 'Volume confirmation is weak'], frame.structure.failedBreakout === 'long' ? frame.recentLow : frame.recentHigh);
    return candidates.sort((a, b) => b.score - a.score);
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
  function evaluateSetup(input) {
    const settings = Object.assign({ minQuality: 72, minRR: 1.8, balance: 7, riskPct: 0.01, maxLeverage: 10, minNotional: 10, maxExposurePct: 1 }, input.settings || {});
    const frames = input.timeframes || {};
    const primary = features(frames.h4 || frames.primary || [], 6);
    if (!primary.available) return { decision: 'ANALYSIS UNAVAILABLE', quality: 0, reason: primary.reason, frame: primary };
    const regime = classifyRegime(primary), candidates = strategyCandidates(primary);
    if (!candidates.length) return { decision: 'NO TRADE', quality: 35, reason: 'No deterministic strategy qualifies in the current regime', regime, frame: primary };
    const best = candidates[0], direction = best.direction;
    const tfFrames = {
      m15: features(frames.m15 || [], 96), h1: features(frames.h1 || [], 24),
      h4: primary, d1: features(frames.d1 || [], 1)
    };
    const availableHigher = [tfFrames.h1, tfFrames.h4, tfFrames.d1].filter(frame => frame.available);
    const aligned = availableHigher.filter(frame => timeframeBias(frame) === direction).length;
    const opposed = availableHigher.filter(frame => !['neutral', direction].includes(timeframeBias(frame))).length;
    const social = socialAdjustment(input.social, direction);
    let quality = best.score + aligned * 4 - opposed * 7 + social.points;
    if (primary.rsi > 76 || primary.rsi < 24) quality -= 8;
    if (primary.volumeAvailable && primary.relativeVolume < 0.65) quality -= 8;
    if (primary.volatilityExpansion > 2.2) quality -= 7;
    quality = Math.round(clamp(quality, 0, 100));
    const execution = tfFrames.h1.available ? tfFrames.h1 : primary;
    const entry = execution.price;
    const structureStop = best.invalidation;
    const volatilityStop = direction === 'long' ? entry - execution.atr * 1.25 : entry + execution.atr * 1.25;
    const stop = direction === 'long' ? Math.min(structureStop || volatilityStop, volatilityStop) : Math.max(structureStop || volatilityStop, volatilityStop);
    const riskDistance = Math.abs(entry - stop), rr = Math.max(settings.minRR, 2);
    const target = direction === 'long' ? entry + riskDistance * rr : entry - riskDistance * rr;
    const risk = riskPlan({ balance: settings.balance, riskPct: settings.riskPct, maxLeverage: settings.maxLeverage, entry, stop, direction, minNotional: settings.minNotional, maxExposurePct: settings.maxExposurePct });
    const reasons = [...best.reasons, `${aligned}/${availableHigher.length || 0} available higher timeframes align`, social.text];
    if (quality < settings.minQuality) return { decision: quality >= settings.minQuality - 10 ? 'WAIT' : 'NO TRADE', quality, reason: `Setup quality is below the configured ${settings.minQuality}/100 threshold`, direction, strategy: best.strategy, regime, entry, stop, target, rr, risk, reasons, frame: primary, timeframes: tfFrames };
    if (!risk.valid) return { decision: 'NO TRADE', quality, reason: risk.reason, direction, strategy: best.strategy, regime, entry, stop, target, rr, risk, reasons, frame: primary, timeframes: tfFrames };
    return { decision: 'TAKE TRADE', quality, reason: `${best.strategy} qualifies after regime, timeframe, cost and risk checks`, direction, strategy: best.strategy, regime, entry, stop, target, rr, risk, reasons, frame: primary, timeframes: tfFrames };
  }
  function performanceStats(trades) {
    const results = trades.map(trade => trade.r).filter(Number.isFinite), wins = results.filter(r => r > 0), losses = results.filter(r => r <= 0);
    let equity = 0, peak = 0, maxDrawdown = 0;
    results.forEach(r => { equity += r; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); });
    const averageWin = mean(wins), averageLoss = Math.abs(mean(losses));
    const variance = std(results), downside = std(losses);
    return {
      trades: results.length, wins: wins.length, losses: losses.length,
      winRate: results.length ? wins.length / results.length : 0,
      averageWin, averageLoss,
      averageR: mean(results), expectancy: mean(results),
      profitFactor: losses.length && averageLoss ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : null,
      maxDrawdownR: maxDrawdown, totalR: results.reduce((a, b) => a + b, 0),
      sharpe: variance ? mean(results) / variance * Math.sqrt(Math.max(1, results.length)) : null,
      sortino: downside ? mean(results) / downside * Math.sqrt(Math.max(1, results.length)) : null
    };
  }
  function backtest(candles, settings) {
    const trades = [], start = Math.max(220, Math.floor(candles.length * 0.1));
    for (let index = start; index < candles.length - 31; index++) {
      const history = candles.slice(0, index + 1);
      const setup = evaluateSetup({ timeframes: { h4: history }, settings: Object.assign({}, settings, { balance: 10000, minNotional: 1, maxExposurePct: 100 }) });
      if (setup.decision !== 'TAKE TRADE') continue;
      const next = candles[index + 1], entry = next.open * (setup.direction === 'long' ? 1.0003 : 0.9997);
      const stopDistance = Math.abs(setup.entry - setup.stop), stop = setup.direction === 'long' ? entry - stopDistance : entry + stopDistance;
      const target = setup.direction === 'long' ? entry + stopDistance * setup.rr : entry - stopDistance * setup.rr;
      let exitIndex = index + 30, grossR = 0;
      for (let cursor = index + 1; cursor <= Math.min(candles.length - 1, index + 30); cursor++) {
        const candle = candles[cursor];
        const hitStop = setup.direction === 'long' ? candle.low <= stop : candle.high >= stop;
        const hitTarget = setup.direction === 'long' ? candle.high >= target : candle.low <= target;
        if (hitStop || hitTarget) { grossR = hitStop ? -1 : setup.rr; exitIndex = cursor; break; }
        if (cursor === Math.min(candles.length - 1, index + 30)) {
          const move = setup.direction === 'long' ? candle.close - entry : entry - candle.close;
          grossR = move / stopDistance;
        }
      }
      const costR = (0.0005 * 2 + 0.0003 * 2) / (stopDistance / entry);
      trades.push({ signalIndex: index, entryIndex: index + 1, exitIndex, timestamp: candles[index].time, direction: setup.direction, strategy: setup.strategy, regime: setup.regime, quality: setup.quality, r: grossR - costR });
      index = exitIndex;
    }
    const trainEnd = Math.floor(candles.length * 0.6), validationEnd = Math.floor(candles.length * 0.8);
    const groups = {
      training: trades.filter(t => t.signalIndex < trainEnd),
      validation: trades.filter(t => t.signalIndex >= trainEnd && t.signalIndex < validationEnd),
      test: trades.filter(t => t.signalIndex >= validationEnd)
    };
    const walkForward = [];
    for (let end = Math.floor(candles.length * 0.55); end < candles.length; end += Math.max(50, Math.floor(candles.length * 0.1))) {
      const windowStart = end, windowEnd = Math.min(candles.length, end + Math.max(50, Math.floor(candles.length * 0.1)));
      walkForward.push(performanceStats(trades.filter(t => t.signalIndex >= windowStart && t.signalIndex < windowEnd)));
    }
    return { trades, training: performanceStats(groups.training), validation: performanceStats(groups.validation), test: performanceStats(groups.test), overall: performanceStats(trades), walkForward };
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
  return { VERSION, LEVERAGE_CHOICES, clamp, mean, std, ema, sma, rsi, atr, rollingVwap, features, recentStructure, classifyRegime, strategyCandidates, riskPlan, evaluateSetup, performanceStats, backtest, traderReliability, aggregateSocial };
});
