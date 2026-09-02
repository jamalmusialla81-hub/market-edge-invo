'use strict';

// Research-only analytics.  It never calls the production evaluator, changes a
// score, or promotes a model.  Every experiment result, including rejection,
// is serialisable for an immutable registry row.
const COST_SCENARIOS = Object.freeze([0.0008, 0.0016, 0.0025, 0.004]);
const FEATURE_FAMILIES = Object.freeze(['BASELINE', 'STRUCTURE', 'LIQUIDITY', 'FVG', 'SESSION', 'LTF_CONFIRMATION', 'VOLUME', 'VOLATILITY', 'RELATIVE_STRENGTH', 'CROSS_MARKET', 'REGIME', 'TARGET_QUALITY']);

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const countBy = (items, key) => items.reduce((out, item) => { const value = typeof key === 'function' ? key(item) : item[key]; const label = value == null ? 'UNCLASSIFIED' : String(value); out[label] = (out[label] || 0) + 1; return out; }, {});
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
function hash(value) { let state = 0x811c9dc5, text = stable(value); for (let index = 0; index < text.length; index++) { state ^= text.charCodeAt(index); state = Math.imul(state, 0x01000193); } return (state >>> 0).toString(16).padStart(8, '0'); }

function costR(record, totalCost) {
  const entry = finite(record.entry ?? record.preferred_entry ?? record.signal_price), stop = finite(record.stop);
  if (!entry || !stop || entry === stop) return null;
  return totalCost / (Math.abs(entry - stop) / entry);
}
function afterCostR(record, totalCost = .0016) {
  const finalR = finite(record?.target?.FINAL_R ?? record?.targets?.FINAL_R ?? record?.FINAL_R);
  if (!Number.isFinite(finalR)) return null;
  const current = costR(record, .0016), desired = costR(record, totalCost);
  if (!Number.isFinite(current) || !Number.isFinite(desired)) return null;
  return finalR + current - desired;
}
function maxDrawdown(values) { let peak = 0, equity = 0, worst = 0; for (const value of values) { equity += value; peak = Math.max(peak, equity); worst = Math.min(worst, equity - peak); } return worst; }
function profitFactor(values) { const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0), losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0)); return losses ? gains / losses : gains ? null : 0; }
function targets(record) { return record?.target || record?.targets || record || {}; }
function metrics(records, {totalCost = .0016} = {}) {
  const usable = records.filter(record => Number.isFinite(afterCostR(record, totalCost)));
  const r = usable.map(record => afterCostR(record, totalCost));
  const raw = usable.map(record => finite(targets(record).FINAL_R)).filter(Number.isFinite);
  const tp1 = usable.filter(record => targets(record).TP1_BEFORE_SL === true).length;
  const stop = usable.filter(record => finite(targets(record).FINAL_R) < 0 && targets(record).TP1_BEFORE_SL !== true).length;
  const mfe = usable.map(record => finite(targets(record).MFE)).filter(Number.isFinite), mae = usable.map(record => finite(targets(record).MAE)).filter(Number.isFinite), duration = usable.map(record => finite(targets(record).bars_held ?? targets(record).duration_bars)).filter(Number.isFinite);
  return {n: usable.length, win_rate: usable.length ? r.filter(value => value > 0).length / usable.length : null, mean_r: mean(raw), median_r: median(raw), expectancy: mean(r), after_cost_expectancy: mean(r), profit_factor: profitFactor(r), max_drawdown: maxDrawdown(r), tp1_before_stop_rate: usable.length ? tp1 / usable.length : null, stop_rate: usable.length ? stop / usable.length : null, mean_mfe: mean(mfe), mean_mae: mean(mae), median_duration: median(duration), long_n: usable.filter(record => record.direction === 'long').length, short_n: usable.filter(record => record.direction === 'short').length, strategy_distribution: countBy(usable, 'strategy'), asset_distribution: countBy(usable, 'asset'), regime_distribution: countBy(usable, 'regime'), cost_total: totalCost};
}
function costSensitivity(records) { const cases = Object.fromEntries(COST_SCENARIOS.map(cost => [(cost * 100).toFixed(2) + '%', metrics(records, {totalCost: cost})])); const base = cases['0.16%']?.after_cost_expectancy; const higher = cases['0.40%']?.after_cost_expectancy; return {cases, cost_fragile: Number.isFinite(base) && base > 0 && (!Number.isFinite(higher) || higher <= 0)}; }
function chronologicalSplits(records, {development = .6, validation = .2} = {}) { const ordered = [...records].sort((left, right) => Number(left.timestamp) - Number(right.timestamp)); const developmentEnd = Math.floor(ordered.length * development), validationEnd = Math.floor(ordered.length * (development + validation)); return {development: ordered.slice(0, developmentEnd), validation: ordered.slice(developmentEnd, validationEnd), test: ordered.slice(validationEnd), boundaries: {development_end: ordered[developmentEnd - 1]?.timestamp || null, validation_end: ordered[validationEnd - 1]?.timestamp || null}}; }
function rankBucket(rank) { const numeric = finite(rank); return numeric === 1 ? '#1' : numeric >= 2 && numeric <= 5 ? '#2-5' : numeric >= 6 && numeric <= 10 ? '#6-10' : numeric >= 11 ? '#11+' : 'UNRANKED'; }
function rankAnalysis(records) { const buckets = {}; for (const label of ['#1', '#2-5', '#6-10', '#11+', 'UNRANKED']) buckets[label] = metrics(records.filter(record => rankBucket(record.rank) === label)); const ranked = ['#1', '#2-5', '#6-10', '#11+'].map(label => buckets[label]); const enough = ranked.every(value => value.n >= 20); const values = ranked.map(value => value.after_cost_expectancy); const monotonic = enough && values.every(Number.isFinite) ? values.every((value, index) => index === 0 || values[index - 1] >= value) ? 'YES' : 'NO' : 'INSUFFICIENT EVIDENCE'; return {buckets, ranking_monotonicity: monotonic}; }
function ablationPlan() { return FEATURE_FAMILIES.map((family, index) => ({experiment_id: `ablation-${String(index + 1).padStart(2, '0')}-${family.toLowerCase()}`, hypothesis: family === 'BASELINE' ? 'Freeze current engine outcome baseline.' : `Test ${family} as a research-only family against the frozen baseline.`, feature_set: family === 'BASELINE' ? [] : [family], decision: 'PENDING', source: 'RESEARCH_FACTORY'})); }
function experimentRecord(input = {}) {
  const required = ['experiment_id', 'hypothesis', 'dataset_hash', 'engine_hash'];
  for (const field of required) if (!input[field]) throw new Error(`EXPERIMENT_${field.toUpperCase()}_REQUIRED`);
  const record = {experiment_id: String(input.experiment_id), created_at: Number(input.created_at || Date.now()), hypothesis: String(input.hypothesis), source: String(input.source || 'RESEARCH_FACTORY'), strategy: input.strategy || null, direction: input.direction || null, feature_set: Array.isArray(input.feature_set) ? input.feature_set : [], parameters: input.parameters || {}, dataset_hash: String(input.dataset_hash), engine_hash: String(input.engine_hash), train_range: input.train_range || null, validation_range: input.validation_range || null, test_range: input.test_range || null, fees: input.fees || {total: .0016}, results: input.results || null, lookahead_status: input.lookahead_status || 'NOT_RUN', recursive_status: input.recursive_status || 'NOT_RUN', decision: input.decision || 'PENDING', rejection_reason: input.rejection_reason || null};
  return {...record, record_hash: hash(record)};
}
function strategyHealth(records) { const metric = metrics(records); return {state: 'INSUFFICIENT', rolling_n: metric.n, rolling_win_rate: metric.win_rate, rolling_mean_r: metric.mean_r, rolling_median_r: metric.median_r, rolling_expectancy: metric.after_cost_expectancy, rolling_profit_factor: metric.profit_factor, rolling_drawdown: metric.max_drawdown, mean_mfe: metric.mean_mfe, mean_mae: metric.mean_mae, note: 'No production strategy state change is implied by research health data.'}; }

module.exports = {COST_SCENARIOS, FEATURE_FAMILIES, hash, costR, afterCostR, metrics, costSensitivity, chronologicalSplits, rankBucket, rankAnalysis, ablationPlan, experimentRecord, strategyHealth};
