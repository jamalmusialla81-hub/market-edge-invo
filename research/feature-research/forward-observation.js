'use strict';

// Phase 17 — forward observation record (schema + validator, research only).
// Genuine forward scans are already appended daily by phase5-v2-clean.yml
// (stage `forward`, runs from main).  This module fixes WHAT each future
// decision must preserve so periodic challenger training can reproduce it.
// It is not wired into any production or execution path, and nothing here
// trains a model: observations feed future, pre-registered retraining only.

const crypto = require('node:crypto');
const VERSION = 'forward-observation-v1';
const REQUIRED = Object.freeze(['observation_id', 'model_version', 'feature_version', 'feature_values', 'decision_timestamp', 'decision_price', 'asset', 'direction', 'actual_path', 'actual_execution_cost', 'final_outcome']);

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A decision is recorded when made; path and outcome are attached later.
function recordDecision({observation_id, model_version, feature_version, feature_values, decision_timestamp, decision_price, asset, direction, provenance = {}}) {
  const record = {version: VERSION, observation_id, model_version, feature_version, feature_values, decision_timestamp, decision_price, asset, direction, provenance, actual_path: null, actual_execution_cost: null, final_outcome: null, status: 'AWAITING_OUTCOME'};
  record.decision_hash = hash({model_version, feature_version, feature_values, decision_timestamp, decision_price, asset, direction});
  return record;
}
// actual_execution_cost is null when no real fill exists (paper / research);
// it is never estimated and stored as if observed.
function attachOutcome(record, {path, executionCost = null, outcome, resolvedAt}) {
  if (record.status !== 'AWAITING_OUTCOME') throw new Error('OUTCOME_ALREADY_ATTACHED');
  if (!Array.isArray(path) || !path.length || path[0].time < record.decision_timestamp) throw new Error('PATH_STARTS_BEFORE_DECISION');
  if (!(resolvedAt >= path.at(-1).time)) throw new Error('OUTCOME_BEFORE_PATH_COMPLETE');
  return {...record, actual_path: path, actual_execution_cost: executionCost, final_outcome: outcome, resolved_at: resolvedAt, status: 'RESOLVED'};
}
function validate(record) {
  const errors = [];
  for (const key of REQUIRED) if (!(key in record)) errors.push(`MISSING_${key.toUpperCase()}`);
  if (!Number.isFinite(record.decision_timestamp)) errors.push('BAD_DECISION_TIMESTAMP');
  if (!(record.decision_price > 0)) errors.push('BAD_DECISION_PRICE');
  if (!record.model_version || !record.feature_version) errors.push('UNVERSIONED');
  if (!record.feature_values || typeof record.feature_values !== 'object') errors.push('NO_FEATURE_VALUES');
  if (record.decision_hash !== hash({model_version: record.model_version, feature_version: record.feature_version, feature_values: record.feature_values, decision_timestamp: record.decision_timestamp, decision_price: record.decision_price, asset: record.asset, direction: record.direction})) errors.push('DECISION_MUTATED_AFTER_RECORDING');
  return {valid: !errors.length, errors};
}

module.exports = {VERSION, REQUIRED, recordDecision, attachOutcome, validate};
