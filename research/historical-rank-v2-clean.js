'use strict';

// HISTORICAL-RANK-V2-CLEAN: clean, fully provenanced rebuild of the Phase 5
// historical candidate universe.  Research only; nothing here is reachable
// from the live scanner, Quant weights, Best Trade Now, or execution.
//
// Invariants (each fails closed for the affected asset or candidate):
// - candles come from one archive (Coinbase spot 5m); no fill, no substitution
// - the latest completed 5m candle must close EXACTLY at the scan timestamp
// - zero missing 5m candles in the trailing 256h (sequence/feature lookback)
// - >= 99.5% coverage over the full fixed 61-day history window
// - timestamps strictly monotonic on the 5m grid, no duplicates, no future rows
// - outcome labels from the actual post-entry path of the same venue; STOP
//   FIRST on ambiguous candles; any missing candle before exit => UNRESOLVED
const crypto = require('node:crypto');
const Quant = require('../quant-engine.js');
const Replay = require('../replay-engine.js');
const Rank = require('./historical-rank.js');
const Sequences = require('./candle-sequence.js');
const Archive = require('./candle-archive.js');

const VERSION = 'HISTORICAL-RANK-V2-CLEAN';
const LABEL_VERSION = 'outcome-strict-v1';
const SEQUENCE_COMPACT_VERSION = 'candle-sequence-compact-v1';
const B = Archive.BASE_MS, HOUR = 3_600_000, DAY = 86_400_000;
const HISTORY_BARS = 17568;                    // fixed 61-day window, identical for every scan
const HISTORY_MS = HISTORY_BARS * B;
const STRICT_LOOKBACK_MS = 256 * HOUR;         // longest frozen sequence lookback (h1 x 256)
const MIN_WINDOW_COVERAGE = .995;
const OUTCOME_BARS = Rank.OUTCOME_BARS;        // 24h
const COMPACT_ROWS = 64;
const COMPACT_FIELDS = Object.freeze(['close_to_close', 'open_close', 'high_low', 'upper_wick', 'lower_wick', 'relative_volume', 'atr_normalized_move', 'rolling_volatility', 'distance_recent_high', 'distance_recent_low']);
const ENTRY = Object.freeze({source: 'COINBASE_SPOT_5M_ARCHIVE', venue: 'COINBASE', instrument_type: 'SPOT'});
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const candleText = rows => rows.map(row => [row.time, row.open, row.high, row.low, row.close, row.volume].join(',')).join('\n');
const precise = value => Number.isFinite(value) ? Number(value.toPrecision(5)) : null;

// ------------------------------------------------------------- archive ----
function prepareAsset(asset, rawRows, {now = Date.now()} = {}) {
  const validated = Archive.validateSeries(rawRows, {now});
  const fatal = validated.issues.conflictingDuplicates;
  if (fatal) throw new Error(`ARCHIVE_REJECTED: ${asset} has ${fatal} conflicting duplicate candles`);
  const rows = validated.rows, index = Archive.presenceIndex(rows), dayHash = new Map();
  let cursor = 0;
  while (cursor < rows.length) { const day = Math.floor(rows[cursor].time / DAY) * DAY; let end = cursor; while (end < rows.length && rows[end].time < day + DAY) end++; dayHash.set(day, sha(candleText(rows.slice(cursor, end)))); cursor = end; }
  return {asset, product: Archive.PRODUCTS[asset], rows, index, dayHash, issues: validated.issues, gaps: validated.gaps.length};
}
function lowerBound(rows, time) { let low = 0, high = rows.length; while (low < high) { const middle = (low + high) >> 1; if (rows[middle].time < time) low = middle + 1; else high = middle; } return low; }
function windowRows(prepared, from, to) { return prepared.rows.slice(lowerBound(prepared.rows, from), lowerBound(prepared.rows, to)); }
function windowHash(prepared, from, to) { const days = []; for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) days.push(prepared.dayHash.get(day) || 'MISSING_DAY'); return sha(`${prepared.asset}|${from}|${to}|${days.join('|')}`); }

// Pre-generation integrity gate for one asset at one scan timestamp.
function historyCheck(prepared, timestamp) {
  const latest = prepared.index.byTime.get(timestamp - B), missingStrict = prepared.index.missing(timestamp - STRICT_LOOKBACK_MS, timestamp), missingWindow = prepared.index.missing(timestamp - HISTORY_MS, timestamp), coverage = 1 - missingWindow / HISTORY_BARS;
  const base = {latest_feature_candle_timestamp: latest ? latest.time : null, latest_feature_candle_close: latest ? latest.time + B : null, missing_last_256h: missingStrict, missing_history_window: missingWindow, history_window_coverage: coverage};
  if (!latest) return {...base, ok: false, freshness_status: 'STALE_OR_MISSING_LATEST_CANDLE', reason: 'LATEST_5M_CANDLE_MISSING'};
  if (missingStrict > 0) return {...base, ok: false, freshness_status: 'FRESH_EXACT', reason: 'GAP_IN_STRICT_LOOKBACK'};
  if (coverage < MIN_WINDOW_COVERAGE) return {...base, ok: false, freshness_status: 'FRESH_EXACT', reason: 'HISTORY_WINDOW_COVERAGE_BELOW_99_5'};
  return {...base, ok: true, freshness_status: 'FRESH_EXACT', reason: null};
}
// Independent re-check of the exact rows handed to the evaluator.
function assertWindowIntegrity(rows, timestamp) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.time % B !== 0) throw new Error('INTEGRITY_REJECTED: off-grid candle');
    if (row.time + B > timestamp) throw new Error('INTEGRITY_REJECTED: future or incomplete candle');
    if (i && !(row.time > rows[i - 1].time)) throw new Error('INTEGRITY_REJECTED: non-monotonic or duplicate candle');
  }
  if (!rows.length || rows.at(-1).time + B !== timestamp) throw new Error('STALE_SNAPSHOT_REJECTED: latest candle does not close at the scan timestamp');
  return true;
}

// ------------------------------------------------------------ diversity ----
// Records which shared-engine strategy gates pass for this asset, so a narrow
// candidate universe can be attributed to market state vs filters.
function gateDiagnostics(tf) {
  const f = tf?.h1; if (!f?.available) return {available: false};
  const vr = f.volumeAvailable ? f.relativeVolume : .75, up = f.price > f.ema20 && f.ema20 > f.ema50 && f.ema20Slope > 0 && f.structure.trend !== 'short', down = f.price < f.ema20 && f.ema20 < f.ema50 && f.ema20Slope < 0 && f.structure.trend !== 'long', extended = Math.abs(f.price - f.ema20) > f.atr * 2.2, regime = Quant.classifyRegime(f);
  const inRange = ['RANGE', 'HIGH-VOLATILITY RANGE'].includes(regime);
  return {available: true, regime, volumeAvailable: Boolean(f.volumeAvailable), relativeVolume: precise(vr), rsi: precise(f.rsi), upTrend: up, downTrend: down, extended, exhaustion: Boolean(f.structure.exhaustion), retest: f.structure.retest || null, liquiditySweep: f.structure.liquiditySweep || null,
    gates: {
      TREND_LONG: {trend: up, notExtended: !extended, noExhaustion: !f.structure.exhaustion, rsiBand: f.rsi >= 48 && f.rsi <= 68, volume: vr >= .8},
      TREND_SHORT: {trend: down, notExtended: !extended, noExhaustion: !f.structure.exhaustion, rsiBand: f.rsi >= 32 && f.rsi <= 52, volume: vr >= .8},
      BREAKOUT_LONG: {retest: f.structure.retest === 'long', volume: vr >= 1}, BREAKOUT_SHORT: {retest: f.structure.retest === 'short', volume: vr >= 1},
      MOMENTUM_LONG: {trend: up, roc: f.roc5 > 2, accel: f.acceleration > 0, rsiBand: f.rsi >= 55 && f.rsi <= 70, macd: f.macd > f.macdSignal, volume: vr >= 1.1, notExtended: !extended},
      MOMENTUM_SHORT: {trend: down, roc: f.roc5 < -2, accel: f.acceleration < 0, rsiBand: f.rsi >= 30 && f.rsi <= 45, macd: f.macd < f.macdSignal, volume: vr >= 1.1, notExtended: !extended},
      MEAN_REV_LONG: {rangeRegime: inRange, oversold: f.rsi < 30, rejection: ['long', null, undefined].includes(f.structure.rejection), nearSupport: f.price <= f.structure.support + f.atr},
      MEAN_REV_SHORT: {rangeRegime: inRange, overbought: f.rsi > 70, rejection: ['short', null, undefined].includes(f.structure.rejection), nearResistance: f.price >= f.structure.resistance - f.atr},
      SWEEP_LONG: {sweep: f.structure.liquiditySweep === 'long', confirm: f.structure.choch === 'long' || f.structure.rejection === 'long'},
      SWEEP_SHORT: {sweep: f.structure.liquiditySweep === 'short', confirm: f.structure.choch === 'short' || f.structure.rejection === 'short'}
    }};
}

// ----------------------------------------------------------- candidates ----
function compactSequence(sequence) {
  const frames = {};
  for (const [name, frame] of Object.entries(sequence.timeframes)) frames[name] = {interval_ms: frame.interval_ms, window_end: frame.window_end, source_count: frame.source_count, rows: (frame.rows || []).slice(-COMPACT_ROWS).map(row => COMPACT_FIELDS.map(key => precise(Number(row[key]))))};
  return {version: SEQUENCE_COMPACT_VERSION, derived_from: Sequences.VERSION, rows_per_frame: COMPACT_ROWS, fields: COMPACT_FIELDS, signal_timestamp: sequence.signal_timestamp, timeframes: frames};
}
// Expand the compact block back into the named-row shape research code reads.
function expandSequence(compact) {
  if (!compact || compact.version !== SEQUENCE_COMPACT_VERSION) return null;
  return {version: compact.version, signal_timestamp: compact.signal_timestamp, timeframes: Object.fromEntries(Object.entries(compact.timeframes).map(([name, frame]) => [name, {interval_ms: frame.interval_ms, window_end: frame.window_end, available: frame.rows.length === compact.rows_per_frame, rows: frame.rows.map(values => Object.fromEntries(compact.fields.map((key, i) => [key, values[i]])))}]))};
}
function assetCandidates({scanId, timestamp, prepared, check}) {
  const rows = windowRows(prepared, timestamp - HISTORY_MS, timestamp);
  assertWindowIntegrity(rows, timestamp);
  const snapshot = Replay.cachedSnapshot(Replay.derived(rows.map(({time, open, high, low, close, volume}) => ({time, open, high, low, close, volume}))), timestamp);
  const ready = Replay.readiness(snapshot);
  if (!ready.ready) return {candidates: [], excluded: {asset: prepared.asset, reason: 'REPLAY_READINESS_FAILED', detail: ready.missing}, diagnostics: null};
  const timeframes = snapshot.timeframes, sequence = Sequences.build(timeframes, timestamp);
  Sequences.assertNoFuture(sequence, timestamp); Rank.assertFresh(sequence, timestamp);
  const evaluated = Quant.evaluateSetupCandidates({timeframes, settings: Rank.SETTINGS}), diagnostics = gateDiagnostics(Quant.evaluateSetup({timeframes, settings: Rank.SETTINGS}).timeframes);
  const historySha = windowHash(prepared, timestamp - HISTORY_MS, timestamp), compact = compactSequence(sequence);
  const candidates = evaluated.map((candidate, index) => {
    const divider = String(candidate.candidateKey || '').lastIndexOf(':'), strategy = candidate.strategy || (divider > 0 ? candidate.candidateKey.slice(0, divider) : null), direction = candidate.direction || (divider > 0 ? candidate.candidateKey.slice(divider + 1) : null), identified = {...candidate, strategy, direction};
    const plan = Rank.geometry(identified), quant = Number.isFinite(Number(candidate.setupQuality ?? candidate.quality)) ? Number(candidate.setupQuality ?? candidate.quality) : null;
    const provenance = {dataset_version: VERSION, label_version: LABEL_VERSION, scan_id: scanId, scan_timestamp: timestamp, asset: prepared.asset, product: prepared.product, entry_source: ENTRY.source, entry_venue: ENTRY.venue, entry_instrument_type: ENTRY.instrument_type, decision_price_definition: 'close of the latest completed 5m candle at the scan timestamp', latest_feature_candle_timestamp: check.latest_feature_candle_timestamp, latest_feature_candle_close: check.latest_feature_candle_close, freshness_status: check.freshness_status, history_window: {bars: HISTORY_BARS, from: timestamp - HISTORY_MS, to: timestamp, missing: check.missing_history_window, coverage: check.history_window_coverage, missing_last_256h: check.missing_last_256h, sha256: historySha}, archive_version: Archive.ARCHIVE_VERSION};
    const features = {...Rank.preEntryFeatures(timeframes, timestamp, identified), provenance, sequence_compact: compact};
    return {candidate_id: `v2c-${Rank.hash([scanId, prepared.asset, index, strategy, direction, plan.entry, plan.stop])}`, timestamp, asset: prepared.asset, invo_instrument: prepared.product, direction: direction || null, strategy: strategy || null, reference_price: Number.isFinite(Number(candidate.entry)) ? Number(candidate.entry) : null, entry: plan.entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2, rr: plan.rr, setup_quality: quant, entry_quality: candidate.entryQuality || null, quant_score: quant, ml_applicability: 'ML_NOT_AVAILABLE_FOR_HISTORICAL_TIMESTAMP', ml_raw_score: null, combined_score: quant, regime: candidate.regime || 'UNCLASSIFIED', feature_json: features, feature_hash: Rank.hash(features), valid_current_geometry: plan.valid, invalidation_reason: plan.valid ? null : (candidate.reason || 'Candidate did not supply valid current geometry'), candidate_rank: null, candidate_count: 0, targets: {status: 'PENDING_OUTCOME'}, candidate_hash: null};
  });
  return {candidates, excluded: null, diagnostics, historySha};
}
function snapshotRecord({scanId, timestamp, universe, sourceHash, candidates}) {
  const value = {scan_id: scanId, scan_timestamp: timestamp, data_timestamp: timestamp, universe_mode: 'HISTORICAL_DATA_UNIVERSE_PROXY', eligible_universe: universe, engine_version: VERSION, strategy_version: 'quant-engine-shared', quant_version: 'quant-engine-shared', ml_version: 'ML_NOT_AVAILABLE_FOR_HISTORICAL_TIMESTAMP', feature_version: `objective-feature-v1+${SEQUENCE_COMPACT_VERSION}`, source_dataset_hash: sourceHash, scan_cadence_ms: DAY, candidate_count: candidates.length};
  return {...value, snapshot_hash: Rank.hash(value)};
}
function buildScan({timestamp, assets}) {
  const scanId = `hrp-${VERSION}-${DAY}-${timestamp}`, universe = [], excluded = [], diagnostics = {}, all = [], hashes = [];
  for (const prepared of assets) {
    const check = historyCheck(prepared, timestamp);
    if (!check.ok) { excluded.push({asset: prepared.asset, reason: check.reason, freshness_status: check.freshness_status, missing_last_256h: check.missing_last_256h, history_window_coverage: check.history_window_coverage}); continue; }
    const result = assetCandidates({scanId, timestamp, prepared, check});
    if (result.excluded) { excluded.push(result.excluded); continue; }
    universe.push(prepared.asset); diagnostics[prepared.asset] = result.diagnostics; hashes.push([prepared.asset, result.historySha]); all.push(...result.candidates);
  }
  if (!universe.length) return {scanId, timestamp, skipped: true, excluded};
  const candidates = Rank.finalizeCandidates(all), snapshot = snapshotRecord({scanId, timestamp, universe, sourceHash: Rank.hash(hashes), candidates});
  return {scanId, timestamp, snapshot, candidates, excluded, diagnostics};
}

// -------------------------------------------------------------- outcomes ----
// Strict label: entry at the open of the 5m candle starting at the scan
// timestamp (+0.03% adverse slippage), 50% at TP1 / 50% at TP2, breakeven after
// TP1, 24h timeout.  Stop is tested first on every candle, and on the candle
// that first reaches TP1 a touch of the breakeven level is assumed to happen
// after TP1 (exit the rest at breakeven).  Any missing candle before the exit
// makes the label UNRESOLVED; nothing is inferred across a gap.
function resolveStrict(candidate, prepared) {
  const timestamp = Number(candidate.timestamp), unresolved = (reason, extra = {}) => ({status: 'UNRESOLVED_DATA_GAP', reason, next_valid_candle_gap_ms: null, ...extra, outcome_source: ENTRY.source, outcome_venue: ENTRY.venue, outcome_instrument_type: ENTRY.instrument_type, label_version: LABEL_VERSION, dataset_version: VERSION, execution: 'No outcome inferred across missing same-venue candles'});
  if (!candidate?.valid_current_geometry) return null;
  const first = prepared.index.byTime.get(timestamp);
  if (!first) return unresolved('ENTRY_CANDLE_MISSING');
  const rawEntry = first.open, plannedStop = Number(candidate.stop), direction = candidate.direction, distance = Math.abs(rawEntry - plannedStop), rr = Number(candidate.rr);
  if (!(distance > 0) || !(rr > 0)) return unresolved('INVALID_EXECUTION_GEOMETRY');
  if ((direction === 'long' && rawEntry <= plannedStop) || (direction === 'short' && rawEntry >= plannedStop)) return unresolved('ENTRY_BEYOND_STOP', {entry_price: rawEntry});
  const s = direction === 'long' ? 1 : -1, entry = rawEntry * (1 + s * .0003), stop = entry - s * distance, tp1 = entry + s * distance * rr, tp2Mult = Math.max(rr + 1, 3), tp2 = entry + s * distance * tp2Mult;
  let tp1Hit = false, tp2Hit = false, stopHit = false, mfe = 0, mae = 0, finalR = 0, bars = 0, exit = 'TIMEOUT'; const used = [];
  for (let k = 0; k < OUTCOME_BARS; k++) {
    const candle = prepared.index.byTime.get(timestamp + k * B);
    if (!candle) return unresolved('OUTCOME_CANDLE_MISSING', {missing_candle_time: timestamp + k * B, bars_observed: k, entry_price: rawEntry});
    used.push(candle); bars++;
    const favourable = s * ((s > 0 ? candle.high : candle.low) - entry) / distance, adverse = s * ((s > 0 ? candle.low : candle.high) - entry) / distance;
    mfe = Math.max(mfe, favourable); mae = Math.min(mae, adverse);
    const touches = level => s > 0 ? candle.low <= level : candle.high >= level, reaches = level => s > 0 ? candle.high >= level : candle.low <= level;
    if (touches(tp1Hit ? entry : stop)) { stopHit = true; finalR = tp1Hit ? rr * .5 : -1; exit = tp1Hit ? 'BREAKEVEN_AFTER_TP1' : 'STOP'; break; }
    if (!tp1Hit && reaches(tp1)) { tp1Hit = true; if (touches(entry)) { stopHit = true; finalR = rr * .5; exit = 'BREAKEVEN_SAME_CANDLE_AS_TP1'; break; } }
    if (tp1Hit && reaches(tp2)) { tp2Hit = true; finalR = rr * .5 + tp2Mult * .5; exit = 'TP2'; break; }
    finalR = tp1Hit ? rr * .5 + .5 * s * (candle.close - entry) / distance : s * (candle.close - entry) / distance;
  }
  const costR = .0016 / (distance / entry);
  return {status: 'RESOLVED', TP1_BEFORE_SL: tp1Hit, FINAL_R: finalR - costR, MFE: mfe, MAE: mae, STOP_HIT: stopHit, TP2_HIT: tp2Hit, duration_bars: bars, exit_reason: exit, entry_timestamp: timestamp, entry_price: rawEntry, fill_price: entry, entry_source: ENTRY.source, entry_venue: ENTRY.venue, entry_instrument_type: ENTRY.instrument_type, outcome_source: ENTRY.source, outcome_venue: ENTRY.venue, outcome_instrument_type: ENTRY.instrument_type, outcome_window_sha256: sha(candleText(used)), same_candle_policy: 'STOP_FIRST; breakeven assumed after TP1 on the TP1 candle', cost_round_trip: .0016, label_version: LABEL_VERSION, dataset_version: VERSION};
}

module.exports = {VERSION, LABEL_VERSION, SEQUENCE_COMPACT_VERSION, HISTORY_BARS, HISTORY_MS, STRICT_LOOKBACK_MS, MIN_WINDOW_COVERAGE, ENTRY, prepareAsset, historyCheck, assertWindowIntegrity, windowRows, windowHash, gateDiagnostics, compactSequence, expandSequence, assetCandidates, buildScan, snapshotRecord, resolveStrict};
