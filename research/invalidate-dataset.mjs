#!/usr/bin/env node
// Appends an immutable DATASET_INVALIDATED record to the research experiment
// registry.  It does not modify, delete, or relabel any dataset row: the
// invalid generation stays in D1 exactly as written, for audit.
import Registry from './dataset-registry.js';
import Rank from './historical-rank.js';
const API = (process.env.MARKET_EDGE_API || 'https://market-edge-ai.jakob-market-edge.workers.dev').replace(/\/$/, ''), TOKEN = process.env.MARKET_EDGE_RESEARCH_TOKEN || '', ENGINE = process.env.INVALIDATE_ENGINE || 'HISTORICAL-RANK-V1';
const entry = Registry.status(ENGINE);
if (entry.trainable) throw new Error(`${ENGINE} is not marked invalid in dataset-registry.js`);
const results = {dataset_version: ENGINE, status: entry.status, reason: entry.reason, evidence: entry.evidence || null, preserved_in: entry.preservedIn || null, repair_policy: 'NO_IN_PLACE_REPAIR; superseded by HISTORICAL-RANK-V2-CLEAN', productionInfluence: 'NONE'};
const experiment = {experiment_id: `DATASET-INVALIDATION-${ENGINE}`, source: 'DATASET_REGISTRY', hypothesis: `${ENGINE} is a valid frozen historical candidate universe.`, dataset_hash: Rank.hash(ENGINE), engine_hash: Rank.hash('dataset-registry'), record_hash: Rank.hash(results), feature_set: [], parameters: {}, results, lookahead_status: 'PASS', recursive_status: 'NOT_RUN', decision: 'DATASET_INVALIDATED', rejection_reason: entry.reason.slice(0, 1000)};
if (process.argv.includes('--dry-run')) { console.log(JSON.stringify(experiment, null, 2)); process.exit(0); }
if (!TOKEN) throw new Error('MARKET_EDGE_RESEARCH_TOKEN is required');
const response = await fetch(`${API}/v1/research/ingest`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: 'experiment_commit', experiment})}), body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Invalidation record failed: ${response.status} ${body?.error?.code || ''}`);
console.log(JSON.stringify({status: 'DATASET_INVALIDATION_RECORDED', experiment_id: experiment.experiment_id, response: body}));
