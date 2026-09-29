import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import X from './expansion.js';
import * as S from './scheduler.mjs';
import {APPROVED_RESEARCH_ASSETS} from '../../signal-bridge/research_universe.mjs';
const require = createRequire(import.meta.url);
const Registry = require('../dataset-registry.js');

const DAY = 86_400_000;
const product = (base, over = {}) => ({id: `${base}-USD`, base_currency: base, quote_currency: 'USD', status: 'online', ...over});
// A long, liquid, non-pegged native daily history from `days` before the dev cutoff.
function daily(days, {volume = 1e6, price = (i) => 10 + Math.sin(i / 20) * 4 + i * 0.01} = {}) {
  const end = Date.UTC(2026, 8, 27), start = end - days * DAY;
  return Array.from({length: days}, (_, i) => { const p = price(i); return {time: start + i * DAY, open: p, high: p * 1.01, low: p * 0.99, close: p, volume}; });
}
const good = X.screenProduct(product('NEWA'), daily(1500));
const short = X.screenProduct(product('NEWB'), daily(200));
const thin = X.screenProduct(product('NEWC'), daily(1500, {volume: 1}));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('the fixtures behave: a long liquid asset passes, short history and thin liquidity fail', () => {
  assert.equal(good.pass, true, JSON.stringify(good.failed));
  assert.ok(short.failed.includes('S3_history'));
  assert.ok(thin.failed.includes('S5_liquidity'));
});

t('a proposed asset lacking listing history is excluded, not force-included', () => {
  const p = S.buildProposal([good, short, thin]);
  assert.deepEqual(p.additions.map((a) => a.symbol), ['NEWA']);
  assert.ok(p.excluded.some((e) => e.symbol === 'NEWB' && e.failed.includes('S3_history')));
  assert.ok(p.excluded.some((e) => e.symbol === 'NEWC'));
  assert.ok(!p.additions.some((a) => a.symbol === 'NEWB'));
});

t('additions require pass: an entry with failed rules and pass false is never proposed', () => {
  const forged = {...short, pass: false};
  assert.deepEqual(S.buildProposal([forged]).additions, []);
});

t('assets already approved are never proposed again, and are never judged if they were not screened', () => {
  const again = X.screenProduct(product('ADA'), daily(1500));
  const p = S.buildProposal([again, good]);
  assert.deepEqual(p.additions.map((a) => a.symbol), ['NEWA']);
  assert.ok(p.approved_not_in_screen.includes('BTC'));
});

t('an approved asset that is no longer an active spot market is proposed for removal, not removed', () => {
  const delisted = X.screenProduct(product('ADA', {status: 'delisted'}), daily(1500));
  const p = S.buildProposal([delisted]);
  assert.deepEqual(p.removals.map((r) => r.symbol), ['ADA']);
  assert.ok(APPROVED_RESEARCH_ASSETS.includes('ADA'));   // the approved list itself is untouched
  assert.equal(p.auto_applied, false);
});

t('loosened criteria stop the scheduler', () => {
  assert.throws(() => S.assertCriteriaUnchanged({...X.SCREEN, minMedianNotionalUsd: 1}), /SCREEN_CRITERIA_CHANGED/);
  assert.throws(() => S.assertCriteriaUnchanged(X.SCREEN, {...X.USABLE, min5mCoverage: 0.5}), /SCREEN_CRITERIA_CHANGED/);
  S.assertCriteriaUnchanged();   // the live criteria equal the pinned ones
});

t('additions are capped for review size, ranked by liquidity, and the rest are listed as deferred', () => {
  const many = Array.from({length: 8}, (_, i) => X.screenProduct(product(`N${i}`), daily(1500, {volume: 1e6 * (i + 1)})));
  const p = S.buildProposal(many);
  assert.equal(p.additions.length, S.MAX_ADDITIONS_PER_PROPOSAL);
  assert.equal(p.deferred_over_review_cap.length, 3);
  assert.equal(p.additions[0].symbol, 'N7');
});

t('the schedule is periodic, not continuous', () => {
  const now = Date.UTC(2026, 9, 1);
  assert.equal(S.isRescreenDue(undefined, now), true);
  assert.equal(S.isRescreenDue(now - 5 * DAY, now), false);
  assert.equal(S.isRescreenDue(now - 30 * DAY, now), true);
});

t('an approved addition creates a NEW registry entry and mutates nothing that exists', () => {
  const before = JSON.stringify(Registry.DATASETS);
  const proposal = S.proposeDatasetVersion(Registry.DATASETS, {approvedAssets: ['NEWA'], proposedAt: '2026-10-01'});
  const next = S.withProposedVersion(Registry.DATASETS, proposal);
  assert.equal(JSON.stringify(Registry.DATASETS), before);
  assert.equal(proposal.version, 'HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED-R20261001');
  assert.ok(!(proposal.version in Registry.DATASETS) && proposal.version in next);
  assert.deepEqual(next['HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED'], Registry.DATASETS['HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED']);
  assert.equal(next[proposal.version].trainable, false);
  assert.equal(next[proposal.version].status, 'PROPOSED');
  assert.ok(next[proposal.version].assets.includes('NEWA') && next[proposal.version].assets.includes('BTC'));
  assert.throws(() => S.withProposedVersion(next, proposal), /DATASET_VERSION_EXISTS/);
  assert.throws(() => Registry.assertTrainable(proposal.version), /DATASET_NOT_TRAINABLE/);
});

t('an unregistered or proposed version cannot be trained on', () => {
  assert.throws(() => Registry.assertTrainable('HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED-R20261001'), /DATASET_NOT_TRAINABLE/);
});

t('removals leave the version list intact and drop the asset only from the new entry', () => {
  const proposal = S.proposeDatasetVersion(Registry.DATASETS, {approvedAssets: ['NEWA'], removedAssets: ['ADA'], proposedAt: '2026-10-02'});
  assert.ok(!proposal.entry.assets.includes('ADA'));
  assert.ok(APPROVED_RESEARCH_ASSETS.includes('ADA'));
});

t('the proposal output offers no auto-apply path', () => {
  const p = S.buildProposal([good]);
  assert.equal(p.auto_applied, false);
  assert.equal(p.status, 'PROPOSAL_FOR_HUMAN_REVIEW');
  assert.equal(S.buildProposal([]).status, 'NO_CHANGE_PROPOSED');
  assert.match(S.renderMarkdown(p), /Nothing has been applied/);
});

console.log(`${n} scheduler tests passed`);
