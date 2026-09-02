// Values are copied exactly from the normalized Worker snapshot. This helper
// deliberately performs no entry, sizing, or score calculation in the UI.
export function formatInvoSetup(trade) {
  return [`Invo instrument: ${trade.instrument || trade.asset}`, `Direction: ${trade.direction?.toUpperCase() || '—'}`, `Strategy: ${trade.strategy || '—'}`, `Entry: ${trade.entry}`, `Stop: ${trade.stop}`, `TP1: ${trade.tp1}`, `TP2: ${trade.tp2}`, `R:R: ${trade.rr1}`].join('\n');
}
