# Market Edge technical audit

Audit date: 2026-08-28

## Current architecture

Market Edge is a static GitHub Pages app. `market-edge.html` owns the UI, public-feed collection and local persistence. `quant-engine.js` contains deterministic indicators, regime classification, strategy candidates, risk sizing and historical simulation. `sw.js` provides an offline shell; `quant-engine.test.js` covers the pure calculation layer.

## Material weaknesses found

1. The original 0–8 consensus score used hand-picked thresholds and had no empirical calibration. The newer 0–100 quality score is still a ranking score, not a probability.
2. Multi-timeframe alignment was initially a small score adjustment. That could allow a short-term bullish bounce to create a LONG against bearish 1d/4h structure.
3. The first structure detector compared broad recent ranges. It did not identify confirmed swing pivots, CHoCH, retests, sweeps or trend exhaustion robustly enough.
4. Multiple strategies were ranked together, but contradictory strategy candidates were not explicitly rejected.
5. Entry and target logic used a single current price and fixed R multiple. It lacked an entry zone, TP1/TP2, chase protection and a trailing rule.
6. The risk engine correctly sizes before leverage, but the liquidation value is only an estimate and cannot replace Invo's displayed liquidation price.
7. The initial browser backtest used only 4h history. It reused deterministic strategy rules and next-bar execution, but it was not an exact replica of the live multi-timeframe scan.
8. The first walk-forward output merely grouped later trades into windows. It did not select parameters on past training/validation data before testing each unseen window.
9. Fees/slippage were modeled conservatively as a fixed 0.16% round trip. Actual user fees, builder fees, spread, slippage and funding vary.
10. Social/trader information is authorised manual input only. It has not been shown out-of-sample to add predictive edge and must remain zero-weighted without adequate data.
11. Public API failures can prevent any live recommendation. Missing data is handled safely, but availability is not guaranteed on restricted networks.
12. Recent losing LONG trades are direct evidence that the current system has not demonstrated a reliable live edge. The deployment verdict must remain PAPER TRADE ONLY or NOT READY until unseen evidence is sufficient.

## Required corrective direction

- Make 1d/4h direction a gate, not a cosmetic bonus.
- Give 5m, 15m, 1h, 4h and 1d distinct roles.
- Reject contradictory strategies, chop, stale/incomplete feeds, price spikes, weak volume, exchange disagreement and chased entries.
- Use confirmed structure for entry zones and invalidation; provide TP1, TP2 and a trailing rule.
- Add true rolling walk-forward parameter selection, stability checks, direction/strategy/regime breakdowns and empirical quality buckets.
- Keep forward signals immutable and separate from historical tests.
- Never increase risk to satisfy the minimum notional.

This audit does not establish profitability. It explains why the prior recommendations should not be trusted as evidence of edge.
