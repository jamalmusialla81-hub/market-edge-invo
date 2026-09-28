'use strict';

// A paper execution backend shared by both stub adapters below. It simulates
// fills, tracks positions per instrument, and never calls a real exchange,
// NautilusTrader, or Hummingbot API. This lets the router/reconciliation
// contracts be tested today; the real NautilusTrader portfolio/risk wrapper
// and the real Hummingbot bridge are a separate, later integration (see
// research/execution-architecture/README.md) once those Python services
// exist alongside this Node/Cloudflare stack.
const {ExecutionFill, PositionSnapshot} = require('./domain-objects.js');

function PaperBackend(name) {
  const positions = new Map(); // instrument -> {quantity, avg_entry}
  const fills = [];
  let fillCounter = 0;

  async function submit(intent) {
    const price = intent.limit_price ?? intent.stop ?? 0;
    const signedQty = intent.side === 'buy' ? intent.quantity : -intent.quantity;
    const existing = positions.get(intent.instrument) || {quantity: 0, avg_entry: price};
    const newQuantity = existing.quantity + signedQty;
    const avgEntry = existing.quantity === 0 || Math.sign(existing.quantity) !== Math.sign(newQuantity)
      ? price
      : (existing.avg_entry * Math.abs(existing.quantity) + price * intent.quantity) / (Math.abs(existing.quantity) + intent.quantity);
    positions.set(intent.instrument, {quantity: newQuantity, avg_entry: avgEntry});
    const fill = ExecutionFill({
      signal_id: intent.signal_id, fill_id: `${name}-${++fillCounter}`, status: 'FILLED',
      quantity_filled: intent.quantity, avg_price: price, fee: 0, backend: name, timestamp: Date.now()
    });
    fills.push(fill);
    return fill;
  }

  function openPositions() {
    return [...positions.entries()]
      .filter(([, position]) => position.quantity !== 0)
      .map(([instrument, position]) => PositionSnapshot({instrument, quantity: position.quantity, avg_entry: position.avg_entry, backend: name}));
  }

  return {name, submit, openPositions, fills: () => fills.slice()};
}

module.exports = {PaperBackend};
