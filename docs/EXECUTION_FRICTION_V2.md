# Execution Friction Model V2 (Task G, `FRICTION-V2`)

Measurement only. `paper/lifecycle.py` still applies its fixed 0.05% fee and 0.03% slippage per side; nothing here
changes a fill, fee, size, decision or Risk Sizing V2 constant. Changing the fixed model is a separate, evidence-gated task.

## What is recorded
- `trade.friction_entry` (entry leg) and `exit.friction` on every exit (exit legs), plus `trade.friction`, a running roll-up in quote currency.
- `expected`: the fixed assumption (`LIFECYCLE_FIXED_MODEL`). `actual`: what could be observed. `difference_pct` = actual minus expected.
- Entry, from the order-book read Risk Sizing V2 already does (no second call): spread (bps), a real book walk for the filled notional (VWAP, market impact vs the touch, slippage vs mid), depth age/venue/levels, proposed notional, signal-to-entry and mark-age latency.
- Exit: trigger (`WS_TRADE` / `POLL_HEARTBEAT` / `CANDLE_5M`), real observed price, stop overshoot past the level (stops and timeouts only; resting limits fill at their level), observation lag and the gap since the previous observation.

## measured vs default_used
- `measured`: real book walk (entry) or a real observed price (tick exit).
- `default_used`: no validated live input (no/stale/wrong-venue/invalid depth, order larger than the book, candle-path exit). `actual` then repeats the assumption (never a more favourable number) and `difference_pct` is `null`.
- The fee is always `default_used` (`TAKER_ASSUMED`): the paper venue's real fee tier is not observed.
- The summary's `difference` sums measured legs only and lists `default_used_legs` separately.

## Not covered (by design)
- Exit slippage beyond the overshoot is still the fixed assumption; only the observed price's overshoot is measured. A candle-path exit has no live price at all.
- Execution latency to a venue does not exist in paper (`submit_to_fill_ms` is `null`).
- Stop overshoot modelling belongs to Task H; this only records the field.
