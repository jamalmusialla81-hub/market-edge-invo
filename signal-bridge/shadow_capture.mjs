// Universal shadow learning, capture side (RESEARCH ONLY).
//
// EXECUTION != OBSERVATION. The paper loop still submits at most the one
// production selection per scan; this module turns the SAME scan into
// decision-time observations of everything the scanner saw:
//   - every candidate the generator produced for every market (long and
//     short, every strategy, rank #1..#N, picks and non-picks), and
//   - one MARKET_STATE snapshot per evaluated market, including markets where
//     production had NO_TRADE.
// Only information known at the scan timestamp goes in. Outcomes are labelled
// later by the execution-service from same-venue (Hyperliquid 5m) candles.
// Nothing here can submit, size or block a paper trade.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FEATURE_VERSION = 'shadow-features-v1';
const FIVE_MINUTES = 5 * 60 * 1000;

function sourceHash(relative) {
  try {
    return createHash('sha256').update(readFileSync(fileURLToPath(new URL(relative, import.meta.url)))).digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}
// The generator is identified by the exact bytes of the production scan and
// Quant engine this loop imports.
export const GENERATOR_VERSION = `scan-core:${sourceHash('../backend/scan-core.mjs')}|quant-engine:${sourceHash('../quant-engine.js')}`;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, digits = 6) => (v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(digits)));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function ema(values, period) {
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i += 1) out = values[i] * k + out * (1 - k);
  return out;
}

// Point-in-time features of one timeframe: only completed candles the scan saw.
export function frameFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const closes = candles.map((c) => c.close), last = candles.at(-1), n = candles.length;
  const ret = (k) => (n > k ? last.close / candles[n - 1 - k].close - 1 : null);
  const trs = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  const atr = mean(trs.slice(-14));
  const diffs = closes.slice(1).map((v, i) => v - closes[i]).slice(-14);
  const gains = mean(diffs.map((d) => Math.max(d, 0))), losses = mean(diffs.map((d) => Math.max(-d, 0)));
  const logs = closes.slice(-21).slice(1).map((v, i, arr) => Math.log(v / (i === 0 ? closes.at(-21) : arr[i - 1])));
  const m = mean(logs);
  const window = candles.slice(-20), hi = Math.max(...window.map((c) => c.high)), lo = Math.min(...window.map((c) => c.low));
  const volumes = candles.slice(-21, -1).map((c) => c.volume).filter(Number.isFinite);
  return {
    last_close: round(last.close), last_bar_time: last.time, ret_1: round(ret(1)), ret_6: round(ret(6)), ret_24: round(ret(24)),
    atr: round(atr), atr_pct: round(atr / last.close), rsi: round(losses ? 100 - 100 / (1 + gains / losses) : 100, 5),
    vol_20: round(Math.sqrt(mean(logs.map((x) => (x - m) ** 2)))), range_pos_20: round(hi > lo ? (last.close - lo) / (hi - lo) : 0.5),
    ema20_dist: round(last.close / ema(closes.slice(-120), 20) - 1), ema50_dist: round(last.close / ema(closes.slice(-200), 50) - 1),
    rel_volume: round(volumes.length && mean(volumes) ? last.volume / mean(volumes) : null),
  };
}

export function marketFeatures(timeframes) {
  const out = {};
  for (const [key, name] of [['m5', 'm5'], ['m15', 'm15'], ['h1', 'h1'], ['h4', 'h4'], ['d1', 'd1']]) {
    const f = frameFeatures(timeframes?.[key]);
    if (f) out[name] = f;
  }
  return out;
}

export function derivatives(ctx) {
  if (!ctx) return null;
  const pick = (k) => round(num(ctx[k]));
  return { funding: pick('funding'), open_interest: pick('openInterest'), premium: pick('premium'), day_notional_volume: pick('dayNtlVlm'),
    mark_px: pick('markPx'), oracle_px: pick('oraclePx'), prev_day_px: pick('prevDayPx') };
}

// Breadth and BTC context from the same scan -- every market's features are
// point-in-time at T, so this is cross-sectional, not future, information.
export function crossMarket(featuresBySymbol) {
  const all = Object.values(featuresBySymbol);
  const frac = (fn) => { const xs = all.map(fn).filter((v) => v !== null && v !== undefined); return xs.length ? round(xs.filter(Boolean).length / xs.length, 4) : null; };
  const med = (fn) => { const xs = all.map(fn).filter(Number.isFinite).sort((a, b) => a - b); return xs.length ? round(xs[Math.floor(xs.length / 2)]) : null; };
  const btc = featuresBySymbol.BTC || null;
  return {
    markets: all.length, breadth_h1_up: frac((f) => (f.h1 ? f.h1.ret_1 > 0 : null)), breadth_h4_up: frac((f) => (f.h4 ? f.h4.ret_1 > 0 : null)),
    median_h1_ret_1: med((f) => f.h1?.ret_1), median_h4_ret_1: med((f) => f.h4?.ret_1), median_h1_vol_20: med((f) => f.h1?.vol_20),
    btc: btc ? { h1_ret_1: btc.h1?.ret_1 ?? null, h4_ret_1: btc.h4?.ret_1 ?? null, d1_ret_1: btc.d1?.ret_1 ?? null, h1_vol_20: btc.h1?.vol_20 ?? null, h4_rsi: btc.h4?.rsi ?? null } : null,
  };
}

function candidateFields(c) {
  return {
    direction: ['long', 'short'].includes(c?.direction) ? c.direction : null, strategy: c?.strategy || null,
    entry: num(c?.entry), stop: num(c?.stop), tp1: num(c?.target1 ?? c?.tp1), tp2: num(c?.target2 ?? c?.tp2),
    rr1: num(c?.rr1 ?? c?.rr), rr2: num(c?.rr2), quant_score: num(c?.setupQuality ?? c?.quant_score),
    strategy_score: num(c?.quantStrategyScore), model_score: num(c?.mlRawScore), combined_score: num(c?.combinedScore),
    verdict: c?.strictDecision || c?.decision || null, entry_status: c?.entryStatus || null, entry_quality: c?.entryQuality || null,
    regime: c?.regime || null, risk_plan_valid: Boolean(c?.risk?.valid),
  };
}
const geometryComplete = (f) => Boolean(f.direction && [f.entry, f.stop, f.tp1, f.tp2, f.rr1].every(Number.isFinite));
const same = (a, b) => a.direction === b.direction && (a.strategy || null) === (b.strategy || null);

export const SCOPE_PRODUCTION = 'PRODUCTION_SCAN';
// Research-only evaluation of approved research assets the production scan
// did not cover (research_universe.mjs). Never submitted, never ranked
// against production.
export const SCOPE_RESEARCH_SUPPLEMENT = 'RESEARCH_SUPPLEMENT';
export const OUTSIDE_PRODUCTION_UNIVERSE = 'OUTSIDE_PRODUCTION_UNIVERSE';

// execution: {decision, reason, signal_id, trade} as the paper execution-service
// answered for the one submitted selection this cycle (or NO_SIGNAL).
// scope RESEARCH_SUPPLEMENT: `result.scan` is a research-only evaluation; its
// cross-market context is taken from the production scan (crossMarketContext),
// and nothing in it is a production pick or can be submitted.
export function buildShadowPayload(result, execution, { observationIntervalMs = null, scope = SCOPE_PRODUCTION, crossMarketContext = null, assetCtxs = null } = {}) {
  const scan = result?.scan;
  const research = scan?.research;
  if (!scan || !research) return null;
  const supplement = scope === SCOPE_RESEARCH_SUPPLEMENT;
  const decisionTs = Number(scan.scannedAt);
  const scanId = supplement ? `research-${scan.scanId || `scan-unavailable-${decisionTs}`}` : scan.scanId || `scan-unavailable-${decisionTs}`;
  const ranked = new Map(supplement ? [] : (scan.rankedOpportunities || []).map((r) => [r.asset, r]));
  const best = supplement ? null : scan.bestTradeNow || null;
  const submittedId = !supplement && execution?.decision && execution.decision !== 'NO_SIGNAL' ? result.signal?.signal_id || null : null;
  const ctxs = assetCtxs || research.assetCtxs || {};

  const featuresBySymbol = {};
  for (const m of research.markets) featuresBySymbol[m.symbol] = marketFeatures(m.timeframes);
  const cross = supplement && crossMarketContext ? crossMarketContext : crossMarket(featuresBySymbol);

  // Every candidate in the scan, ranked research-only by Quant score.
  const perMarket = research.markets.map((m) => {
    const pick = candidateFields(m.quantPick || {});
    const cands = (m.candidates || []).map(candidateFields).filter((c) => c.direction);
    if (pick.direction && !cands.some((c) => same(c, pick))) cands.push(pick);   // the production pick is always recorded
    return { m, pick, cands };
  });
  const scanOrder = perMarket.flatMap(({ m, cands }) => cands.map((c) => ({ symbol: m.symbol, c })))
    .sort((a, b) => (b.c.quant_score ?? -1) - (a.c.quant_score ?? -1) || a.symbol.localeCompare(b.symbol));

  const observations = [];
  for (const { m, pick, cands } of perMarket) {
    const m5 = m.timeframes?.m5 || [];
    const lastBar = m5.at(-1);
    const market = {
      price: num(m.price), data_age_ms: lastBar ? decisionTs - (lastBar.time + FIVE_MINUTES) : null, venue: 'HYPERLIQUID',
      price_source: 'HYPERLIQUID_4H_REFERENCE_CLOSE', sources: m.sources || [], source_count: m.sourceCount ?? null,
      max_price_disagreement: round(num(m.maxPriceDisagreement)), matching_feeds: m.matchingFeeds ?? null,
    };
    const rankedRow = ranked.get(m.symbol);
    const productionState = supplement ? OUTSIDE_PRODUCTION_UNIVERSE : rankedRow?.market_geometry === 'COMPLETE' ? 'RANKED_WITH_GEOMETRY' : 'NO_TRADE';
    const common = { market, features: featuresBySymbol[m.symbol], cross_market: cross, derivatives: derivatives(ctxs[m.symbol]),
      regime: pick.regime || rankedRow?.regime || null, provenance: { generator_version: GENERATOR_VERSION, feature_version: FEATURE_VERSION, scan_id: scanId, scan_scope: scope } };
    observations.push({ kind: 'MARKET_STATE', asset: m.symbol, coin: m.symbol, production_state: productionState,
      decision: { ...common, production: { rank: rankedRow?.rank ?? null, verdict: rankedRow?.strict_verdict ?? null, entry_status: rankedRow?.entry_status ?? null, candidates: cands.length } } });
    const withinAsset = [...cands].sort((a, b) => (b.quant_score ?? -1) - (a.quant_score ?? -1));
    for (const c of cands) {
      const assetPick = Boolean(pick.direction && same(c, pick));
      const isPick = !supplement && assetPick;
      const isBest = Boolean(best && best.asset === m.symbol && same(c, { direction: best.direction, strategy: best.strategy }));
      const submitted = Boolean(submittedId && isBest);
      const notSubmitted = supplement ? OUTSIDE_PRODUCTION_UNIVERSE : !isPick ? 'NOT_ASSET_PICK' : !geometryComplete(c) ? 'INCOMPLETE_GEOMETRY'
        : submittedId ? 'RANK_BELOW_SELECTED' : 'NO_SIGNAL_THIS_SCAN';
      observations.push({
        kind: 'CANDIDATE', asset: m.symbol, coin: m.symbol, production_state: productionState, submitted,
        not_submitted_reason: submitted ? null : notSubmitted,
        decision: { ...common, candidate: { ...c, is_production_pick: isPick, is_generator_asset_pick: assetPick, is_best_trade_now: isBest,
          production_rank: isPick ? rankedRow?.rank ?? null : null, within_asset_rank: withinAsset.indexOf(c) + 1,
          scan_candidate_rank: scanOrder.findIndex((x) => x.symbol === m.symbol && x.c === c) + 1,
          geometry_complete: geometryComplete(c), model_score: isPick ? num(rankedRow?.ml_score) ?? c.model_score : c.model_score } },
      });
    }
  }
  return {
    scan: { scan_id: scanId, decision_ts: decisionTs, scan_status: scan.status || null, n_markets: research.markets.length, scan_scope: scope,
      submitted_signal_id: submittedId, execution: supplement ? { decision: 'NOT_APPLICABLE', reason: OUTSIDE_PRODUCTION_UNIVERSE } : execution || { decision: 'NO_SIGNAL' },
      observation_interval_ms: observationIntervalMs,
      generator_version: GENERATOR_VERSION, feature_version: FEATURE_VERSION,
      model_version: supplement ? 'QUANT_ONLY' : best?.ml?.model_id || 'QUANT_ONLY', failures: research.failures || [], universe: scan.universe || null, cross_market: cross,
      // Consumed (and removed) by the execution-service to compute each
      // candidate's COUNTERFACTUAL Risk Sizing V2; not stored as a feature.
      risk_inputs: Object.fromEntries(research.markets.map((m) => [m.symbol, riskInputsFor(research, m.symbol)]).filter(([, v]) => v)) },
    observations,
  };
}

// Point-in-time inputs Risk Sizing V2 needs, from the SAME scan and venue:
// the completed Hyperliquid daily candles (volatility state) and the venue's
// size precision. Never substituted from another asset or venue.
export function riskInputsFor(research, coin) {
  const m = (research?.markets || []).find((x) => x.symbol === coin);
  const d1 = m?.timeframes?.d1;
  if (!Array.isArray(d1) || !d1.length) return null;
  const decimals = research?.assetMeta?.[coin]?.szDecimals;
  return {
    vol: { venue: 'HYPERLIQUID', interval: '1d', closes: d1.map((c) => c.close), last_bar_open_ms: d1.at(-1).time },
    venue_rules: { min_notional: 10, qty_decimals: Number.isInteger(decimals) ? decimals : 8 },
  };
}

// The paper loop's outcome for this cycle -> the execution fields stored next
// to (never instead of) research validity.
export function executionFromCycle(outcome, result, posted) {
  if (!result?.signal) return { decision: 'NO_SIGNAL' };
  const signalId = result.signal.signal_id;
  if (outcome === 'EXECUTED') return { decision: 'EXECUTED', signal_id: signalId, trade: posted?.body?.trade || null };
  if (outcome === 'STALE_OPEN_POSITIONS') return { decision: 'REJECTED', reason: 'STALE_MARKET_DATA_FOR_OPEN_POSITIONS', signal_id: signalId };
  const reason = posted?.body?.detail?.reason || posted?.body?.reason || String(outcome || '').replace(/^REJECTED:/, '') || 'UNKNOWN';
  return { decision: 'REJECTED', reason, signal_id: signalId };
}

// Same-venue candles the scan already fetched (Hyperliquid 5m, completed
// only). Used to resolve due windows without extra API calls.
export function scanCandlesByCoin(result) {
  const out = {};
  for (const m of result?.scan?.research?.markets || []) {
    const m5 = m.timeframes?.m5;
    if (Array.isArray(m5) && m5.length) out[m.symbol] = m5.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
  }
  return out;
}
