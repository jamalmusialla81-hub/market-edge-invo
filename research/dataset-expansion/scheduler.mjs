// DATA 13: dataset expansion scheduler (research only). Decides WHEN to
// re-screen and turns a screen report into a PROPOSAL for a human. It does not
// screen anything itself (expansion.js screenProduct does, unchanged), does not
// touch the shadow rotation (signal-bridge/research_universe.mjs), and never
// edits dataset-registry.js: an approved addition becomes a NEW version entry.
//
// Invariants, each covered by a test:
//   - the screen criteria are pinned; if X.SCREEN differs from PINNED_SCREEN the
//     scheduler refuses to run (loosening the rules to get more assets needs a
//     deliberate, reviewed change to this file, not a side effect)
//   - only assets that PASSED every screen rule can be proposed; a failed asset
//     is listed as excluded with its reasons, never force-included
//   - a proposal is never trainable and never active, and carries no history
//   - an existing dataset version is never mutated or replaced
import X from './expansion.js';
import {APPROVED_RESEARCH_ASSETS, RESEARCH_UNIVERSE_VERSION} from '../../signal-bridge/research_universe.mjs';

export const SCHEDULER_VERSION = 'EXPANSION-SCHEDULER-V1';
export const DEFAULT_INTERVAL_DAYS = 30;
export const MAX_ADDITIONS_PER_PROPOSAL = 5;   // a review-size cap, not an eligibility rule
const DAY = 86_400_000;

export const PINNED_SCREEN = Object.freeze({
  excludedBases: ['USDT', 'USDC', 'DAI', 'PYUSD', 'GUSD', 'EURC', 'PAX', 'PAXG', 'XAUT', 'TUSD', 'BUSD', 'USDS', 'RLUSD', 'FDUSD', 'USD1', 'WBTC', 'CBBTC', 'CBETH', 'WETH', 'STETH', 'WSTETH', 'LSETH', 'RETH', 'MSOL', 'JITOSOL'],
  minPriceCv: 0.05, lookbackDays: 261, minEligibleDevDays: 365, minDailyCoverage: 0.99, minMedianNotionalUsd: 5e6, lowNotionalUsd: 5e5,
  maxLowNotionalShare: 0.05, maxAbsLogReturn: Math.log(3), maxOpenGap: 0.5, fetchCap: 40,
});
export const PINNED_USABLE = Object.freeze({min5mCoverage: 0.99, min1hCoverage: 0.99});

/** Throws if the eligibility criteria were changed. */
export function assertCriteriaUnchanged(screen = X.SCREEN, usable = X.USABLE) {
  if (JSON.stringify(screen) !== JSON.stringify(PINNED_SCREEN) || JSON.stringify(usable) !== JSON.stringify(PINNED_USABLE)) {
    throw new Error('SCREEN_CRITERIA_CHANGED: the scheduler will not run with loosened or altered eligibility rules');
  }
}

/** Scheduled, not continuous: due only when the last re-screen is at least intervalDays old (or never ran). */
export function isRescreenDue(lastRunMs, nowMs, intervalDays = DEFAULT_INTERVAL_DAYS) {
  if (!Number.isFinite(lastRunMs)) return true;
  return nowMs - lastRunMs >= intervalDays * DAY;
}

/**
 * screened: screenProduct() outputs ({symbol, product, pass, failed, ...}) over the full market list.
 * approved: the currently approved research assets.
 * Proposes additions (passed every screen rule, not yet approved, ranked by the existing shortlist order and
 * capped for review size) and removals (an approved asset that now FAILS the active-market rule S1, e.g. delisted).
 * A removal is only a proposal; nothing is removed here.
 */
export function buildProposal(screened, approved = APPROVED_RESEARCH_ASSETS, {now = Date.now(), baseVersion = RESEARCH_UNIVERSE_VERSION} = {}) {
  assertCriteriaUnchanged();
  const approvedSet = new Set(approved);
  const candidates = screened.filter((s) => !approvedSet.has(s.symbol));
  const passed = X.shortlist(candidates);   // existing ranking: liquidity, and it already keeps only pass === true
  const additions = passed.slice(0, MAX_ADDITIONS_PER_PROPOSAL).map((s) => ({
    symbol: s.symbol, product: s.product, medianDailyNotionalUsd: s.medianDailyNotionalUsd, firstValidDate: s.firstValidDate,
    status: 'SCREEN_PASSED_PENDING_FETCH_AND_USABILITY',
  }));
  const deferred = passed.slice(MAX_ADDITIONS_PER_PROPOSAL).map((s) => s.symbol);
  const excluded = candidates.filter((s) => !s.pass).map((s) => ({symbol: s.symbol, product: s.product, failed: s.failed || ['UNKNOWN']}));
  const removals = screened.filter((s) => approvedSet.has(s.symbol) && (s.failed || []).includes('S1_activeSpot'))
    .map((s) => ({symbol: s.symbol, reason: 'NO_LONGER_ACTIVE_SPOT', failed: s.failed}));
  const notScreened = [...approvedSet].filter((a) => !screened.some((s) => s.symbol === a));
  return {
    scheduler_version: SCHEDULER_VERSION, generated_at_ms: now, base_version: baseVersion, criteria: 'PINNED_UNCHANGED',
    status: additions.length || removals.length ? 'PROPOSAL_FOR_HUMAN_REVIEW' : 'NO_CHANGE_PROPOSED',
    additions, deferred_over_review_cap: deferred, removals, excluded_count: excluded.length, excluded,
    approved_not_in_screen: notScreened,   // e.g. the six original assets are skipped by the screen; listed, not judged
    next_steps: additions.length ? [
      'A human reviews additions. Nothing is added automatically.',
      'Approved additions are fetched and put through usability F1-F3 and the minimum-development-candidates rule (expansion.js), unchanged.',
      'Survivors become a NEW dataset version via proposeDatasetVersion(); the existing version is never edited.',
    ] : [],
    auto_applied: false,
  };
}

/** The new-version entry an approved proposal would register. Never trainable or active until built and verified. */
export function proposeDatasetVersion(datasets, {baseVersion = RESEARCH_UNIVERSE_VERSION, approvedAssets, removedAssets = [], proposedAt}) {
  if (!datasets[baseVersion]) throw new Error(`BASE_VERSION_UNKNOWN: ${baseVersion}`);
  if (!Array.isArray(approvedAssets) || !approvedAssets.length) throw new Error('NO_APPROVED_ASSETS');
  const date = String(proposedAt).replace(/-/g, '');
  if (!/^\d{8}$/.test(date)) throw new Error('PROPOSED_AT_MUST_BE_YYYY-MM-DD');
  const version = `${baseVersion.replace(/-R\d{8}$/, '')}-R${date}`;
  if (datasets[version]) throw new Error(`DATASET_VERSION_EXISTS: ${version} is never overwritten`);
  const assets = [...new Set([...APPROVED_RESEARCH_ASSETS.filter((a) => !removedAssets.includes(a)), ...approvedAssets])].sort();
  return {
    version,
    entry: Object.freeze({
      status: 'PROPOSED', trainable: false, developmentOnly: true, derivedFrom: baseVersion, proposedAt, assets: Object.freeze(assets),
      reason: 'Proposed by the expansion scheduler after human approval. Not built, not verified, not trainable. The base version is unchanged and not mixed in.',
    }),
  };
}

/** A copy of the registry with the new entry added. The input registry object is left untouched. */
export function withProposedVersion(datasets, proposal) {
  if (datasets[proposal.version]) throw new Error(`DATASET_VERSION_EXISTS: ${proposal.version} is never overwritten`);
  return Object.freeze({...datasets, [proposal.version]: proposal.entry});
}

export function renderMarkdown(p) {
  const lines = [`# Dataset expansion proposal (${p.scheduler_version})`, '', `Status: **${p.status}**. Criteria pinned and unchanged. Nothing has been applied.`, ''];
  lines.push('## Proposed additions (screen passed only)', '', ...(p.additions.length ? p.additions.map((a) => `- ${a.symbol} (${a.product}), median daily notional $${Math.round(a.medianDailyNotionalUsd).toLocaleString('en-US')}, first valid ${a.firstValidDate}`) : ['- none']), '');
  if (p.deferred_over_review_cap.length) lines.push(`Also passed but held back for review size: ${p.deferred_over_review_cap.join(', ')}`, '');
  lines.push('## Proposed removals', '', ...(p.removals.length ? p.removals.map((r) => `- ${r.symbol}: ${r.reason}`) : ['- none']), '');
  lines.push(`## Excluded (${p.excluded_count} failed the screen, never force-included)`, '');
  return lines.join('\n') + '\n';
}
