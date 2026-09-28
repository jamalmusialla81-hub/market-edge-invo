'use strict';

// JS mirror of execution-service/market_edge_exec/shadow/contracts.py's
// hindsight guard. Any research/model code that reads shadow-learning data
// must pass its feature column names through assertDecisionFeatures(): a
// post-outcome field (MFE/MAE, optimal/hindsight labels, policy outcome,
// classification, anything "future") used as a feature fails loudly.
const HINDSIGHT_PATTERN = /(optimal|hindsight|best_achievable|best_direction|best_holding|mfe|mae|future|outcome|realis|realiz|classification|efficiency|excursion|time_to_|policy_|_hit$|hit_at|first_touch|label|resolved|missed|opportunity|window_end)/i;
const FUTURE_SECTIONS = ['FUTURE_LABEL_DATA', 'POST_OUTCOME_RESEARCH_ONLY'];

function isHindsightName(name) {
  const text = String(name);
  if (FUTURE_SECTIONS.some((section) => text.includes(section))) return true;
  return HINDSIGHT_PATTERN.test(text.split('.').pop());
}
function assertDecisionFeatures(names) {
  const bad = [...new Set([...names].filter(isHindsightName))].sort();
  if (bad.length) throw new Error(`HINDSIGHT_FIELD_AS_FEATURE: ${bad.join(', ')}`);
}
function hindsightPaths(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [...(isHindsightName(path) ? [path] : []), ...hindsightPaths(inner, path)];
  });
}
module.exports = {HINDSIGHT_PATTERN, isHindsightName, assertDecisionFeatures, hindsightPaths};
