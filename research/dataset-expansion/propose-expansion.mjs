#!/usr/bin/env node
// Turns a screen report (screen-universe.mjs) into a human-review proposal. Writes two files, changes nothing else.
import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {buildProposal, renderMarkdown} from './scheduler.mjs';

const SCREEN = process.env.EXPANSION_SCREEN_REPORT || 'screen-report.json';
const OUT = process.env.EXPANSION_PROPOSAL || 'expansion-proposal.json';
const report = JSON.parse(readFileSync(SCREEN, 'utf8'));
const proposal = buildProposal(report.products || []);
writeFileSync(OUT, JSON.stringify(proposal, null, 1) + '\n');
writeFileSync(OUT.replace(/\.json$/, '.md'), renderMarkdown(proposal));
console.log(JSON.stringify({status: proposal.status, additions: proposal.additions.map((a) => a.symbol), removals: proposal.removals.map((r) => r.symbol), excluded: proposal.excluded_count}));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(proposal));
