# Stop overshoot / gap model (Task H, `STOP-OVERSHOOT-V1`)

Measurement only. A stop still fills exactly as `paper/lifecycle.py` fills it (at the observed price when already
through the level, plus the fixed slippage). `risk/sizing_v2.py` and its buffer constants are untouched.

## Fields, on every STOP and BREAKEVEN_STOP exit (`exit.stop_overshoot`)
`intended_stop`, `first_observed_post_stop_price`, `fill_price`, `overshoot_bps`, `overshoot_R`, `fill_overshoot_bps`,
`fill_overshoot_R`, `detection_source`, `time_since_last_observation_ms`, `observed`, `unavailable_reason`.

- `overshoot_*` is how far the first real observed price was past the stop (what the monitor actually saw). `R` is that distance over the trade's initial stop distance.
- `fill_overshoot_*` is the simulated fill against the level, which also contains the fixed slippage assumption. The two are separate on purpose.
- `detection_source` uses the monitor's own vocabulary (`WS_TRADE`, `POLL_HEARTBEAT`, `CANDLE_5M`). The issue's `websocket_or_poll` field is merged into it because it would say the same thing.
- A candle-path exit has no observed price: `first_observed_post_stop_price`, `overshoot_bps`, `overshoot_R` are `null` with a reason, never a guess. The first observation after entry has a `null` gap.
- Target and timeout exits get no record. Stop exits from before this change stay without one (the report counts them, never back-fills).

## Distribution report
`python -m market_edge_exec.analysis.stop_overshoot <paper.sqlite3>` (read-only) groups exits by asset, detection source and gap since the last observation. It states no expected-overshoot number until at least 30 observed exits exist, and it feeds nothing. Dependence on volatility, liquidity and stop distance is not analysed yet: it needs far more exits than exist. On Jakob's 2026-09-29 backup there are 4 stop exits, all from before this record, so the report is empty.

## Relationship to the sizing evidence bar (#70 / PR #71)
`SIZING-EVIDENCE-BAR-V1`'s overshoot rate (`evaluation/sizing_review.py`) is the share of losing trades whose realised net loss exceeded that sizing's own planned loss. It is computed from ledger P&L and needs none of these fields, so it is unchanged and compatible. These fields are complementary: they let a later, separately authorised change attribute a breach to gap versus fixed slippage.
