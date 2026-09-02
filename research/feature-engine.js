(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MarketEdgeObjectiveFeatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This module is deliberately research-only.  No production scanner imports
  // it, and no field in this file can add to a live score or alter a trade.
  const VERSION = 'objective-feature-v1';
  const INTERVALS = Object.freeze({m5: 300000, m15: 900000, h1: 3600000, h4: 14400000, d1: 86400000});
  const SESSION_WINDOWS = Object.freeze([
    {name: 'ASIA', startHour: 0, endHour: 8},
    {name: 'LONDON', startHour: 8, endHour: 13},
    {name: 'NEW_YORK', startHour: 13, endHour: 21},
    {name: 'LATE_UTC', startHour: 21, endHour: 24}
  ]);

  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const median = values => { const clean = values.filter(Number.isFinite).sort((a, b) => a - b); if (!clean.length) return null; const middle = Math.floor(clean.length / 2); return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2; };
  const percent = (from, to) => Number.isFinite(from) && from !== 0 && Number.isFinite(to) ? (to / from - 1) * 100 : null;
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
  const hash = value => { const text = stable(value); let state = 0x811c9dc5; for (let index = 0; index < text.length; index++) { state ^= text.charCodeAt(index); state = Math.imul(state, 0x01000193); } return (state >>> 0).toString(16).padStart(8, '0'); };

  function candle(value) {
    return {time: finite(value?.time), open: finite(value?.open), high: finite(value?.high), low: finite(value?.low), close: finite(value?.close), volume: finite(value?.volume)};
  }
  function closedCandles(input, interval, signalTime) {
    const period = Number(interval);
    if (!Number.isFinite(period) || period <= 0 || !Number.isFinite(signalTime)) throw new Error('FEATURE_TIMESTAMP_INVALID');
    const out = [];
    for (const raw of Array.isArray(input) ? input : []) {
      const row = candle(raw);
      if (![row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)) continue;
      if (row.open <= 0 || row.low <= 0 || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) continue;
      if (row.time + period > signalTime) throw new Error('LOOKAHEAD_REJECTED: incomplete or future source candle');
      out.push(row);
    }
    return out.sort((left, right) => left.time - right.time);
  }
  function trueRanges(rows) { return rows.slice(1).map((row, index) => Math.max(row.high - row.low, Math.abs(row.high - rows[index].close), Math.abs(row.low - rows[index].close))); }
  function atr(rows, period = 14) { return mean(trueRanges(rows).slice(-period)); }
  function rollingReturn(rows, bars) { return rows.length > bars ? percent(rows.at(-(bars + 1)).close, rows.at(-1).close) : null; }
  function sampleDeviation(values) { const centre = mean(values); if (!Number.isFinite(centre) || values.length < 2) return null; return Math.sqrt(mean(values.map(value => (value - centre) ** 2))); }
  function sourceMeta(rows, interval) { const latest = rows.at(-1); return {latestCandleOpen: latest?.time || null, latestCandleClose: latest ? latest.time + interval : null, candleCount: rows.length}; }

  // A pivot is only available after rightBars following candles have closed.
  // It is never painted back into the past using later data.
  function confirmedPivots(rows, interval, signalTime, {leftBars = 2, rightBars = 2} = {}) {
    const highs = [], lows = [];
    for (let index = leftBars; index + rightBars < rows.length; index++) {
      const centre = rows[index], confirmedAt = rows[index + rightBars].time + interval;
      if (confirmedAt > signalTime) continue;
      const left = rows.slice(index - leftBars, index), right = rows.slice(index + 1, index + rightBars + 1);
      if (left.every(row => centre.high > row.high) && right.every(row => centre.high >= row.high)) highs.push({time: centre.time, price: centre.high, confirmedAt});
      if (left.every(row => centre.low < row.low) && right.every(row => centre.low <= row.low)) lows.push({time: centre.time, price: centre.low, confirmedAt});
    }
    return {highs, lows, definition: {leftBars, rightBars, confirmation: 'right-bars-close'} };
  }
  function structure(rows, interval, signalTime) {
    const pivots = confirmedPivots(rows, interval, signalTime), lastHigh = pivots.highs.at(-1) || null, priorHigh = pivots.highs.at(-2) || null, lastLow = pivots.lows.at(-1) || null, priorLow = pivots.lows.at(-2) || null, latest = rows.at(-1), currentAtr = atr(rows);
    if (!latest) return {trend: 'UNAVAILABLE', highRelation: null, lowRelation: null, lastSwingHigh: null, lastSwingLow: null, lastSwingHighTimestamp: null, lastSwingLowTimestamp: null, bos: null, choch: null, displacement: false, displacementAtr: null, pivotDefinition: pivots.definition};
    const highRelation = lastHigh && priorHigh ? lastHigh.price > priorHigh.price ? 'HH' : lastHigh.price < priorHigh.price ? 'LH' : 'EH' : null;
    const lowRelation = lastLow && priorLow ? lastLow.price > priorLow.price ? 'HL' : lastLow.price < priorLow.price ? 'LL' : 'EL' : null;
    const trend = highRelation === 'HH' && lowRelation === 'HL' ? 'UP' : highRelation === 'LH' && lowRelation === 'LL' ? 'DOWN' : 'RANGE';
    const bosUp = Boolean(lastHigh && latest.close > lastHigh.price), bosDown = Boolean(lastLow && latest.close < lastLow.price);
    const choch = trend === 'UP' && bosDown ? 'DOWN' : trend === 'DOWN' && bosUp ? 'UP' : null;
    const range = latest.high - latest.low, body = Math.abs(latest.close - latest.open), displacement = Number.isFinite(currentAtr) && currentAtr > 0 && range / currentAtr >= 1.5 && body / Math.max(range, Number.EPSILON) >= .6;
    return {trend, highRelation, lowRelation, lastSwingHigh: lastHigh?.price || null, lastSwingLow: lastLow?.price || null, lastSwingHighTimestamp: lastHigh?.time || null, lastSwingLowTimestamp: lastLow?.time || null, bos: bosUp ? 'UP' : bosDown ? 'DOWN' : null, choch, displacement, displacementAtr: Number.isFinite(currentAtr) && currentAtr ? range / currentAtr : null, pivotDefinition: pivots.definition};
  }
  function equalLevels(values, tolerance) {
    const pairs = [];
    for (let left = 0; left < values.length; left++) for (let right = left + 1; right < values.length; right++) if (Math.abs(values[left].price - values[right].price) <= tolerance) pairs.push({first: values[left], second: values[right], level: (values[left].price + values[right].price) / 2});
    return pairs;
  }
  function activeSession(signalTime) { const hour = new Date(signalTime).getUTCHours(); return SESSION_WINDOWS.find(session => hour >= session.startHour && hour < session.endHour) || SESSION_WINDOWS.at(-1); }
  function sessionLevels(rows, interval, signalTime) {
    const dayStart = Math.floor(signalTime / 86400000) * 86400000, session = activeSession(signalTime), sessionStart = dayStart + session.startHour * 3600000, sessionEnd = dayStart + session.endHour * 3600000;
    const current = rows.filter(row => row.time >= sessionStart && row.time + interval <= Math.min(signalTime, sessionEnd));
    const prior = rows.filter(row => row.time >= sessionStart - 86400000 && row.time + interval <= sessionStart);
    return {name: session.name, sessionStart, sessionEnd, high: current.length ? Math.max(...current.map(row => row.high)) : null, low: current.length ? Math.min(...current.map(row => row.low)) : null, completedPriorSessionHigh: prior.length ? Math.max(...prior.map(row => row.high)) : null, completedPriorSessionLow: prior.length ? Math.min(...prior.map(row => row.low)) : null};
  }
  function liquidity(rows, interval, signalTime, daily = []) {
    const pivots = confirmedPivots(rows, interval, signalTime), latest = rows.at(-1), currentAtr = atr(rows);
    if (!latest) return {priorSwingHigh: null, priorSwingLow: null, equalHighCount: 0, equalLowCount: 0, previousDayHigh: null, previousDayLow: null, session: sessionLevels(rows, interval, signalTime), sweep: null, distanceToKnownLiquidity: null, liquidityTolerance: null, targetLevels: []};
    const tolerance = Math.max((currentAtr || 0) * .15, latest.close * .001), equalHighs = equalLevels(pivots.highs.slice(-12), tolerance), equalLows = equalLevels(pivots.lows.slice(-12), tolerance), high = pivots.highs.at(-1), low = pivots.lows.at(-1), sweepUp = Boolean(high && latest.high >= high.price + tolerance && latest.close < high.price), sweepDown = Boolean(low && latest.low <= low.price - tolerance && latest.close > low.price);
    const previousDay = daily.at(-2) || null, session = sessionLevels(rows, interval, signalTime);
    const knownLevels = [high?.price, low?.price, ...equalHighs.map(pair => pair.level), ...equalLows.map(pair => pair.level), previousDay?.high, previousDay?.low, session.completedPriorSessionHigh, session.completedPriorSessionLow].filter(Number.isFinite);
    const distance = knownLevels.length ? Math.min(...knownLevels.map(level => Math.abs(latest.close - level))) : null;
    return {priorSwingHigh: high?.price || null, priorSwingLow: low?.price || null, equalHighCount: equalHighs.length, equalLowCount: equalLows.length, previousDayHigh: previousDay?.high || null, previousDayLow: previousDay?.low || null, session, sweep: sweepUp ? 'UP_SWEEP_RECLAIM' : sweepDown ? 'DOWN_SWEEP_RECLAIM' : null, distanceToKnownLiquidity: distance, liquidityTolerance: tolerance, targetLevels: knownLevels};
  }
  function fairValueGaps(rows) {
    const all = [];
    for (let index = 2; index < rows.length; index++) {
      const first = rows[index - 2], last = rows[index], middle = rows[index - 1];
      if (last.low > first.high) all.push({direction: 'BULLISH', low: first.high, high: last.low, width: last.low - first.high, createdAt: last.time, displacementBody: Math.abs(middle.close - middle.open)});
      if (last.high < first.low) all.push({direction: 'BEARISH', low: last.high, high: first.low, width: first.low - last.high, createdAt: last.time, displacementBody: Math.abs(middle.close - middle.open)});
    }
    return all;
  }
  function fvg(rows, interval) {
    const gaps = fairValueGaps(rows), latest = rows.at(-1), currentAtr = atr(rows), active = gaps.at(-1) || null;
    if (!latest) return {status: 'UNAVAILABLE', active: null, count: 0};
    if (!active) return {status: 'NONE', active: null, count: 0};
    const ageBars = Math.max(0, Math.round((latest.time - active.createdAt) / interval));
    const fill = active.direction === 'BULLISH' ? clamp((active.high - latest.close) / active.width, 0, 1) : clamp((latest.close - active.low) / active.width, 0, 1);
    return {status: active.direction, active: {...active, ageBars, widthAtr: Number.isFinite(currentAtr) && currentAtr ? active.width / currentAtr : null, fillPercent: fill * 100, distanceFromPrice: active.direction === 'BULLISH' ? Math.max(0, latest.close - active.high) : Math.max(0, active.low - latest.close)}, count: gaps.length};
  }
  function equilibrium(rows) { const sample = rows.slice(-20), high = sample.length ? Math.max(...sample.map(row => row.high)) : null, low = sample.length ? Math.min(...sample.map(row => row.low)) : null, price = rows.at(-1)?.close || null, position = Number.isFinite(high) && Number.isFinite(low) && high > low ? (price - low) / (high - low) : null; return {rangeHigh: high, rangeLow: low, rangePosition: position, zone: position == null ? 'UNAVAILABLE' : position < .45 ? 'DISCOUNT' : position > .55 ? 'PREMIUM' : 'EQUILIBRIUM'}; }
  function momentumVolumeVolatility(rows) {
    const latest = rows.at(-1), currentAtr = atr(rows), priorAtr = atr(rows.slice(0, -14)), volumes = rows.slice(-21, -1).map(row => row.volume).filter(value => value > 0), returns = rows.slice(-21).slice(1).map((row, index) => Math.log(row.close / rows.slice(-21)[index].close));
    if (!latest) return {roc5: null, roc20: null, bodyAtr: null, relativeVolume: null, atr: null, atrPct: null, volatilityExpansion: null, realizedVolatility: null};
    return {roc5: rollingReturn(rows, 5), roc20: rollingReturn(rows, 20), bodyAtr: Number.isFinite(currentAtr) && currentAtr ? Math.abs(latest.close - latest.open) / currentAtr : null, relativeVolume: volumes.length ? latest.volume / mean(volumes) : null, atr: currentAtr, atrPct: Number.isFinite(currentAtr) ? currentAtr / latest.close * 100 : null, volatilityExpansion: Number.isFinite(currentAtr) && Number.isFinite(priorAtr) && priorAtr ? currentAtr / priorAtr : null, realizedVolatility: sampleDeviation(returns)};
  }
  function correlation(left, right) { if (left.length !== right.length || left.length < 5) return null; const leftMean = mean(left), rightMean = mean(right), numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0), denominator = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0)); return denominator ? numerator / denominator : null; }
  function relativeStrength(rows, context = {}) {
    const own = rollingReturn(rows, 20), btc = Array.isArray(context.btc) ? rollingReturn(context.btc, 20) : null, eth = Array.isArray(context.eth) ? rollingReturn(context.eth, 20) : null;
    const ownReturns = rows.slice(-21).slice(1).map((row, index) => Math.log(row.close / rows.slice(-21)[index].close));
    const contextReturns = source => Array.isArray(source) && source.length >= 21 ? source.slice(-21).slice(1).map((row, index) => Math.log(row.close / source.slice(-21)[index].close)) : [];
    return {status: Number.isFinite(btc) || Number.isFinite(eth) ? 'AVAILABLE' : 'UNAVAILABLE', assetReturn20: own, vsBtc20: Number.isFinite(own) && Number.isFinite(btc) ? own - btc : null, vsEth20: Number.isFinite(own) && Number.isFinite(eth) ? own - eth : null, correlationBtc20: correlation(ownReturns, contextReturns(context.btc)), correlationEth20: correlation(ownReturns, contextReturns(context.eth))};
  }
  // Order-block / breaker labels are not emitted: a reproducible definition
  // would require a discretionary choice among overlapping candles. Keeping an
  // explicit unavailable value is safer than inventing a chart-reading rule.
  function orderBlockResearchStatus() { return {status: 'RESEARCH_ONLY_NOT_IMPLEMENTED', reason: 'No objectively stable formation/invalidation rule is available across overlapping candidate candles.'}; }
  function ltfConfirmation(frames) {
    const m5 = frames.m5, m15 = frames.m15;
    if (!m5 || !m15) return {status: 'UNAVAILABLE'};
    const momentum = [m5.momentum.roc5, m15.momentum.roc5].filter(Number.isFinite);
    const volume = [m5.momentum.relativeVolume, m15.momentum.relativeVolume].filter(Number.isFinite);
    const reclaim = [m5.liquidity.sweep, m15.liquidity.sweep].filter(Boolean);
    return {status: momentum.length ? 'AVAILABLE' : 'UNAVAILABLE', lowerTfBos: m5.structure.bos, lowerTfChoch: m5.structure.choch, inverseFvg: 'RESEARCH_ONLY_NOT_IMPLEMENTED', momentumExpansion: momentum.length === 2 ? momentum[0] * momentum[1] > 0 : null, volumeExpansion: volume.length === 2 ? volume[0] > 1 && volume[1] > 1 : null, volatilityExpansion: m5.momentum.volatilityExpansion, reclaimConfirmation: reclaim.length ? reclaim : null};
  }
  function crossMarketContext(context = {}) {
    const universe = Array.isArray(context.universe) ? context.universe : [];
    const returns = universe.map(rows => Array.isArray(rows) ? rollingReturn(rows, 20) : null).filter(Number.isFinite);
    if (!returns.length) return {status: 'UNAVAILABLE', breadth: null, dispersion: null, label: 'UNAVAILABLE'};
    const rising = returns.filter(value => value > 0).length / returns.length, dispersion = sampleDeviation(returns);
    return {status: 'AVAILABLE', breadth: rising, breadthLabel: rising >= .6 ? 'RISK_ON' : rising <= .4 ? 'RISK_OFF' : 'MIXED', dispersion, dispersionLabel: dispersion == null ? 'UNAVAILABLE' : dispersion > median(returns.map(value => Math.abs(value))) ? 'HIGH' : 'LOW', universeCount: returns.length};
  }
  function regime(structureValue, momentum) { const trend = structureValue.trend === 'UP' ? 'UP' : structureValue.trend === 'DOWN' ? 'DOWN' : 'RANGE', volatility = momentum.volatilityExpansion == null ? 'UNAVAILABLE' : momentum.volatilityExpansion < .8 ? 'LOW' : momentum.volatilityExpansion > 1.4 ? 'HIGH' : 'NORMAL'; return {trend, volatility, label: `${trend}_${volatility}`}; }
  function targetQuality({trade, liquidityValue, structureValue}) {
    if (!trade || !Number.isFinite(trade.entry) || !Number.isFinite(trade.tp1)) return {status: 'UNAVAILABLE'};
    const direction = trade.direction, target = trade.tp1, levels = liquidityValue.targetLevels || [], opposing = levels.filter(level => direction === 'long' ? level >= trade.entry : level <= trade.entry), between = opposing.filter(level => direction === 'long' ? level > trade.entry && level < target : level < trade.entry && level > target);
    const nearest = opposing.length ? opposing.sort((left, right) => Math.abs(left - target) - Math.abs(right - target))[0] : null;
    return {status: 'AVAILABLE', targetDistance: Math.abs(target - trade.entry), nearestKnownLiquidity: nearest, distanceToTargetLiquidity: nearest == null ? null : Math.abs(target - nearest), targetCongestion: between.length, opposingStructuralLevel: direction === 'long' ? structureValue.lastSwingHigh : structureValue.lastSwingLow};
  }
  function assertPreEntry(snapshot, signalTime) {
    const times = [];
    const walk = value => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) return value.forEach(walk); for (const [key, item] of Object.entries(value)) { if (/timestamp$|At$|Start$|End$/i.test(key) && Number.isFinite(item)) times.push(item); else walk(item); } };
    walk(snapshot?.sources); if (times.some(value => value > signalTime)) throw new Error('LOOKAHEAD_REJECTED: feature source timestamp exceeds signal timestamp');
    return true;
  }
  function snapshot({timeframes = {}, signalTime, context = {}, trade = null} = {}) {
    if (!Number.isFinite(signalTime)) throw new Error('FEATURE_TIMESTAMP_INVALID');
    const frames = {};
    for (const [name, interval] of Object.entries(INTERVALS)) {
      const rows = closedCandles(timeframes[name], interval, signalTime);
      const daily = name === 'd1' ? rows : closedCandles(timeframes.d1, INTERVALS.d1, signalTime);
      const structural = structure(rows, interval, signalTime), liquidityValue = liquidity(rows, interval, signalTime, daily), momentum = momentumVolumeVolatility(rows), fvgValue = fvg(rows, interval);
      frames[name] = {source: sourceMeta(rows, interval), structure: structural, liquidity: liquidityValue, fvg: fvgValue, equilibrium: equilibrium(rows), momentum, relativeStrength: relativeStrength(rows, context[name] || context), regime: regime(structural, momentum)};
    }
    const primary = frames.h1 || frames.h4, ltf = ltfConfirmation(frames), crossMarket = crossMarketContext(context), result = {featureDefinitionVersion: VERSION, signalTimestamp: signalTime, sources: Object.fromEntries(Object.entries(frames).map(([name, value]) => [name, value.source])), frames, orderBlock: orderBlockResearchStatus(), ltfConfirmation: ltf, crossMarket, targetQuality: targetQuality({trade, liquidityValue: primary.liquidity, structureValue: primary.structure}), featureHash: hash({version: VERSION, signalTime, frames, ltf, crossMarket})};
    assertPreEntry(result, signalTime);
    return result;
  }

  return {VERSION, INTERVALS, SESSION_WINDOWS, finite, hash, closedCandles, confirmedPivots, structure, liquidity, fvg, equilibrium, momentumVolumeVolatility, relativeStrength, orderBlockResearchStatus, ltfConfirmation, crossMarketContext, regime, targetQuality, assertPreEntry, snapshot};
});
