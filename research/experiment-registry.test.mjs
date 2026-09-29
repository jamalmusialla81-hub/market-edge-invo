// DATA 5: promotion-readiness.js's real evaluate() output, logged through the registry wiring.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Engine = require('../promotion-readiness.js');
const Reg = require('./experiment-registry.js');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const model = { id: 'challenger', generation: 1, datasetHash: 'hash' };
const scan = (index, { challenger = 1, incumbent = 0.5, quant = 0.7 } = {}) => ({
  timestamp: 1_800_000_000_000 + index * 86_400_000, asset: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'][index % 5], regime: ['UPTREND', 'RANGE'][index % 2],
  outcome: {
    quantOnly: { finalR: quant, netUtility: quant, tp1BeforeSl: true }, incumbent: { finalR: incumbent, netUtility: incumbent, tp1BeforeSl: true },
    challenger: { finalR: challenger, netUtility: challenger, tp1BeforeSl: true },
  },
});
const many = (opts) => Array.from({ length: 50 }, (_, i) => scan(i, opts));
const CONFIG = { research_question: 'does the challenger beat the incumbent forward?', dataset_version: 'DS-TEST', feature_set_version: 'FEATURE-SET-V1', model_type: 'logistic',
  random_seed: 1, baseline: 'INCUMBENT', source_commit: 'test' };
const fixtures = {
  INSUFFICIENT_EVIDENCE: { scans: [scan(0)] },
  PROMOTION_READY: { scans: many(), thresholds: { minForwardDays: 14 } },
  KEEP_CHALLENGER: { scans: many({ challenger: 0.5, incumbent: 0.5, quant: 0.7 }), thresholds: { minForwardDays: 14 } },
  REJECTED: { scans: many({ challenger: -1, incumbent: 0.5 }), thresholds: { minForwardDays: 14 } },
};

test('the recorded promotion status is evaluate()\'s actual output, for every decision', () => {
  for (const [decision, input] of Object.entries(fixtures)) {
    const evaluation = Engine.evaluate({ model, ...input });
    assert.equal(evaluation.decision, decision);
    const plan = Reg.planEvaluationLog({ config: CONFIG, evaluation, integrity: input.integrity });
    const last = plan.steps.at(-1);
    const { integrity, ...recorded } = last.promotion_status.evaluation;
    assert.deepEqual(recorded, evaluation, `${decision}: the registry must hold evaluate()'s output unchanged`);
    assert.equal(last.promotion_status.gate, 'PROMOTION_READINESS_V1');
    assert.equal(last.status, Reg.OUTCOME_FOR_DECISION[decision]);
    assert.deepEqual(plan.steps.map((s) => s.status).slice(0, 1), ['RUNNING']);
  }
});

test('the wiring never writes SHADOW_CANDIDATE, even for PROMOTION_READY', () => {
  const evaluation = Engine.evaluate({ model, ...fixtures.PROMOTION_READY });
  const plan = Reg.planEvaluationLog({ config: CONFIG, evaluation });
  assert.ok(!plan.steps.some((s) => s.status === 'SHADOW_CANDIDATE'));
  assert.equal(plan.steps.at(-1).status, 'PROMISING');
});

test('an unknown decision is refused, not guessed', () => {
  assert.throws(() => Reg.planEvaluationLog({ config: CONFIG, evaluation: { decision: 'LOOKS_GREAT' } }), /UNKNOWN_PROMOTION_DECISION/);
});

test('logEvaluation posts create then RUNNING then the outcome, in order', async () => {
  const calls = [];
  const post = async (path, body) => { calls.push([path, body]); return path === '/research/experiments' ? { experiment_id: 'exp-1' } : {}; };
  const id = await Reg.logEvaluation({ post, config: CONFIG, evaluation: Engine.evaluate({ model, ...fixtures.KEEP_CHALLENGER }) });
  assert.equal(id, 'exp-1');
  assert.deepEqual(calls.map((c) => c[0]), ['/research/experiments', '/research/experiments/exp-1/status', '/research/experiments/exp-1/status']);
  assert.deepEqual(calls.slice(1).map((c) => c[1].status), ['RUNNING', 'PROMISING']);
});

// End to end against the real Python registry (skipped when python3 is unavailable).
test('the real registry accepts the wiring for every decision and keeps evaluate()\'s output', () => {
  const probe = spawnSync('python3', ['-c', 'import sqlite3']);
  if (probe.status !== 0) { console.log('skip: python3 not available'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'expreg-'));
  const plans = Object.entries(fixtures).map(([decision, input]) => {
    const evaluation = Engine.evaluate({ model, ...input });   // one evaluation: it carries createdAt timestamps
    return { decision, evaluation, plan: Reg.planEvaluationLog({ config: { ...CONFIG, random_seed: decision.length }, evaluation, integrity: {} }) };
  });
  writeFileSync(join(dir, 'plans.json'), JSON.stringify(plans));
  const service = fileURLToPath(new URL('../execution-service', import.meta.url));
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(service)})
from market_edge_exec.shadow.store import ShadowStore
from market_edge_exec.experiments.registry import ExperimentRegistry
reg = ExperimentRegistry(ShadowStore(${JSON.stringify(join(dir, 's.sqlite3'))}))
out = {}
for p in json.load(open(${JSON.stringify(join(dir, 'plans.json'))})):
    exp = reg.create(**{'config': p['plan']['create']['config'], 'actor': p['plan']['create']['actor']})['experiment_id']
    for step in p['plan']['steps']:
        reg.transition(exp, step['status'], results=step.get('results'), promotion_status=step.get('promotion_status'), actor=step.get('actor', 'x'))
    h = reg.history(exp)
    out[p['decision']] = {'status': h['status'], 'recorded': h['latest_promotion_status']['evaluation']}
print(json.dumps(out))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
  for (const { decision, evaluation } of plans) {
    assert.equal(result[decision].status, Reg.OUTCOME_FOR_DECISION[decision]);
    const { integrity, ...recorded } = result[decision].recorded;
    assert.deepEqual(recorded, JSON.parse(JSON.stringify(evaluation)));
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok - ${name}`); } catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
}
if (failed) process.exit(1);
console.log(`experiment-registry: ${tests.length - failed}/${tests.length} passed`);
