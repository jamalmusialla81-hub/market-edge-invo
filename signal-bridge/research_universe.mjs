// Approved clean research universe for SHADOW / forward observation only.
//
// The 16 assets of HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED (the original
// six plus the ten added by dataset-expansion v1; see
// research/dataset-expansion/reports/dataset-manifest.json, which a test
// keeps this list equal to). Approval for research does NOT add anything to
// the production trading universe: the production scan, its ranking and the
// one paper selection per scan are untouched.
//
// Most of these assets are already evaluated by the normal production scan
// (its universe is the top Hyperliquid perps plus a core list), and shadow
// capture observes them for free. For the ones the production scan did not
// evaluate this cycle, the forward loop runs a small, research-only
// supplementary evaluation with the SAME frozen generator, on a deterministic
// rotation so the public API budget stays bounded:
//   - at most SHADOW_SUPPLEMENT_PER_CYCLE assets per discovery cycle (default 1, max 3)
//   - only assets the venue actually lists (same-venue labels only)
//   - skipped entirely when the production scan itself saw data failures
//     (usually HTTP 429): research never competes with trading data.
// Supplementary observations are stamped OUTSIDE_PRODUCTION_UNIVERSE and can
// never be submitted.

export const RESEARCH_UNIVERSE_VERSION = 'HISTORICAL-RANK-V2-CLEAN-NATIVE-HTF-EXPANDED';
export const APPROVED_RESEARCH_ASSETS = Object.freeze([
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC',
  'ADA', 'AERO', 'AVAX', 'BCH', 'DOT', 'HBAR', 'LINK', 'ONDO', 'UNI', 'XLM',
]);
export const DEFAULT_SUPPLEMENT_PER_CYCLE = 1;
export const MAX_SUPPLEMENT_PER_CYCLE = 3;

export function supplementPerCycle(raw) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return DEFAULT_SUPPLEMENT_PER_CYCLE;
  return Math.min(MAX_SUPPLEMENT_PER_CYCLE, Math.max(0, Math.floor(n)));
}

/**
 * Which approved research assets the production scan did not observe, and
 * which of them to evaluate (research only) this cycle. Deterministic in
 * (scan, cycle, perCycle).
 */
export function supplementPlan(scan, cycle, perCycle = DEFAULT_SUPPLEMENT_PER_CYCLE) {
  const research = scan?.research;
  const observed = new Set((research?.markets || []).map((m) => m.symbol));
  const listed = new Set(Object.keys(research?.assetCtxs || {}));
  const missing = APPROVED_RESEARCH_ASSETS.filter((a) => !observed.has(a));
  const notOnVenue = listed.size ? missing.filter((a) => !listed.has(a)) : [];
  const eligible = listed.size ? missing.filter((a) => listed.has(a)) : [];
  const base = { observed: APPROVED_RESEARCH_ASSETS.filter((a) => observed.has(a)), missing, notOnVenue, selected: [] };
  if (!research) return { ...base, skipped: 'NO_RESEARCH_SCAN' };
  if (perCycle <= 0) return { ...base, skipped: 'DISABLED' };
  if (!listed.size) return { ...base, skipped: 'VENUE_LISTING_UNKNOWN' };
  if ((research.failures || []).length) return { ...base, skipped: 'PRODUCTION_SCAN_HAD_DATA_FAILURES' };
  if (!eligible.length) return { ...base, skipped: missing.length ? 'NONE_LISTED_ON_VENUE' : 'ALL_OBSERVED_BY_PRODUCTION_SCAN' };
  const start = (Math.max(0, cycle) * perCycle) % eligible.length;
  const selected = Array.from({ length: Math.min(perCycle, eligible.length) }, (_, i) => eligible[(start + i) % eligible.length]);
  return { ...base, selected, skipped: null };
}

/** Market descriptors for scan-core's injected-markets path. */
export function supplementMarkets(assets) {
  return assets.map((asset) => ({ invoInstrument: asset, dataSymbol: asset }));
}
