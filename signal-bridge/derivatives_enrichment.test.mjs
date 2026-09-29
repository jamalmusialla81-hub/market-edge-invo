// DATA 14: basis and provenance for derivatives context. Missing data is null/UNAVAILABLE, never estimated.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivatives, derivativesProvenance, FEATURE_VERSION } from './shadow_capture.mjs';

const ctx = { funding: '0.0000125', openInterest: '1000', premium: '0.0004', dayNtlVlm: '5000000', markPx: '100.3', oraclePx: '100', midPx: '100.2', prevDayPx: '99' };

test('basis is computed from the venue oracle in the same snapshot', () => {
  const d = derivatives(ctx);
  assert.equal(d.basis_mark_oracle, 0.003);
  assert.ok(Math.abs(d.basis_mid_oracle - 0.002) < 1e-9);
  assert.equal(d.funding, 0.0000125, 'existing fields are unchanged');
});

test('a market without derivatives data records null, never a fabricated value', () => {
  assert.equal(derivatives(null), null);
  for (const missing of [{ ...ctx, oraclePx: undefined }, { ...ctx, oraclePx: '' }, { ...ctx, oraclePx: null }, { ...ctx, oraclePx: '0' }, { ...ctx, oraclePx: 'abc' }]) {
    const d = derivatives(missing);
    assert.equal(d.basis_mark_oracle, null, JSON.stringify(missing.oraclePx));
    assert.equal(d.basis_mid_oracle, null);
  }
  // A missing mid price must not be read as 0 (which would look like a -100% basis).
  for (const noMid of [{ ...ctx, midPx: undefined }, { ...ctx, midPx: null }, { ...ctx, midPx: '' }]) {
    assert.equal(derivatives(noMid).basis_mid_oracle, null);
    assert.equal(derivatives(noMid).basis_mark_oracle, 0.003, 'the other basis is still real');
  }
});

test('provenance is present for every populated value and explains every missing one', () => {
  const p = derivativesProvenance(ctx);
  for (const k of ['basis_mark_oracle', 'basis_mid_oracle']) {
    assert.equal(p[k].status, 'OK');
    assert.equal(p[k].source, 'HYPERLIQUID_metaAndAssetCtxs');
    assert.ok(p[k].formula && p[k].inputs.length === 2);
  }
  const partial = derivativesProvenance({ ...ctx, midPx: undefined });
  assert.equal(partial.basis_mid_oracle.status, 'UNAVAILABLE');
  assert.equal(partial.basis_mid_oracle.reason, 'INPUT_MISSING_OR_NON_POSITIVE_REFERENCE');
  assert.equal(partial.basis_mark_oracle.status, 'OK');
  assert.equal(derivativesProvenance(null).basis_mark_oracle.reason, 'NO_VENUE_CONTEXT_FOR_ASSET');
});

test('every non-null derived value has an OK provenance entry and every null one does not', () => {
  for (const c of [ctx, { ...ctx, midPx: undefined }, { ...ctx, oraclePx: undefined }, null]) {
    const d = derivatives(c), p = derivativesProvenance(c);
    for (const k of ['basis_mark_oracle', 'basis_mid_oracle']) {
      const populated = d !== null && d[k] !== null;
      assert.equal(p[k].status === 'OK', populated, `${k} for ${JSON.stringify(c)}`);
    }
  }
});

test('the gaps are declared, not filled: no spot feed means no separate divergence, no verified liquidation source', () => {
  const p = derivativesProvenance(ctx);
  assert.equal(p.perp_spot_divergence.status, 'NOT_CAPTURED');
  assert.equal(p.liquidation_context.status, 'UNAVAILABLE');
  const d = derivatives(ctx);
  assert.ok(!Object.keys(d).some((k) => /liquidat|spot_div/.test(k)));
});

test('the feature version moved to v2 because fields were added', () => {
  assert.equal(FEATURE_VERSION, 'shadow-features-v2');
});
