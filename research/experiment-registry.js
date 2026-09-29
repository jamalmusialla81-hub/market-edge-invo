'use strict';

// Client-side helpers for the experiment registry (execution-service
// /research/experiments; DATA 5). promotion-readiness.js is the first writer:
// its evaluate() output is recorded WHOLE as the experiment's promotion
// status, and nothing here changes what evaluate() computes.
//
// The lifecycle status is the registry's own vocabulary (PLANNED, RUNNING,
// FAILED, NO_EVIDENCE, PROMISING, SHADOW_CANDIDATE, REJECTED, SUPERSEDED).
// This helper writes only the outcome an evaluation supports; it never writes
// SHADOW_CANDIDATE. That step is an explicit human or script action, and the
// registry refuses it unless the recorded gate output passed.

const GATE = 'PROMOTION_READINESS_V1';

// evaluate().decision -> the lifecycle outcome that evaluation supports.
const OUTCOME_FOR_DECISION = Object.freeze({
  INSUFFICIENT_EVIDENCE: 'NO_EVIDENCE',
  REJECTED: 'REJECTED',
  KEEP_CHALLENGER: 'PROMISING',
  PROMOTION_READY: 'PROMISING',
});

function promotionStatus(evaluation, integrity) {
  // `integrity` is the input evaluate() was given; it is recorded next to the output so the registry can re-check hard gates.
  return { gate: GATE, evaluation: { ...evaluation, integrity: { ...(integrity || {}) } } };
}

// The sequence of registry writes for one promotion-readiness evaluation.
function planEvaluationLog({ config, evaluation, integrity, actor = 'promotion-readiness' }) {
  const decision = evaluation.decision || evaluation.status;
  const outcome = OUTCOME_FOR_DECISION[decision];
  if (!outcome) throw new Error(`UNKNOWN_PROMOTION_DECISION: ${decision}`);
  return {
    create: { config, actor },
    steps: [
      { status: 'RUNNING' },
      { status: outcome, results: { promotion_readiness: summarize(evaluation) }, promotion_status: promotionStatus(evaluation, integrity), actor },
    ],
  };
}

function summarize(evaluation) {
  const keep = ['modelId', 'generation', 'datasetHash', 'decision', 'status', 'forwardResolvedN', 'forwardDays', 'distinctAssets', 'distinctRegimes', 'reasons'];
  return Object.fromEntries(keep.filter((k) => evaluation[k] !== undefined).map((k) => [k, evaluation[k]]));
}

// post(path, body) -> Promise<json>. Writes the plan in order; returns the experiment id.
async function logEvaluation({ post, config, evaluation, integrity, actor }) {
  const plan = planEvaluationLog({ config, evaluation, integrity, actor });
  const created = await post('/research/experiments', plan.create);
  for (const step of plan.steps) await post(`/research/experiments/${encodeURIComponent(created.experiment_id)}/status`, { actor: plan.create.actor, ...step });
  return created.experiment_id;
}

module.exports = { GATE, OUTCOME_FOR_DECISION, promotionStatus, planEvaluationLog, logEvaluation };
