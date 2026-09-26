'use strict';

// State reconciliation: compares canonical (Nautilus-side, here the paper
// ledger) positions against what a backend reports and flags divergence
// instead of silently trusting either side. Read-only comparison; it fixes
// nothing automatically, per "fail safe if state cannot be reconciled."
function reconcile(canonicalPositions, backendPositions) {
  const canonicalByInstrument = new Map(canonicalPositions.map(position => [position.instrument, position]));
  const backendByInstrument = new Map(backendPositions.map(position => [position.instrument, position]));
  const orphanOrders = [...backendByInstrument.keys()].filter(instrument => !canonicalByInstrument.has(instrument));
  const unknownPositions = [...canonicalByInstrument.keys()].filter(instrument => !backendByInstrument.has(instrument));
  const mismatched = [...canonicalByInstrument.entries()]
    .filter(([instrument]) => backendByInstrument.has(instrument))
    .filter(([instrument, position]) => Math.abs(position.quantity - backendByInstrument.get(instrument).quantity) > 1e-9)
    .map(([instrument, canonical]) => ({instrument, canonicalQuantity: canonical.quantity, backendQuantity: backendByInstrument.get(instrument).quantity}));
  const reconciled = orphanOrders.length === 0 && unknownPositions.length === 0 && mismatched.length === 0;
  return {reconciled, orphanOrders, unknownPositions, mismatched};
}

module.exports = {reconcile};
