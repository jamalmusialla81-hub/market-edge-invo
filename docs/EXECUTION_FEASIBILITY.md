# Liquidity / depth feasibility stage (Task I, `EXECUTION-FEASIBILITY-V1`)

`execution-service/market_edge_exec/risk/liquidity.py` is the order-book walk that Risk Sizing V2's liquidity cap
already used, moved out unchanged and given a richer output. It has two consumers and does no I/O (the single `l2Book`
read the cycle already makes is passed in, so there is no second network call).

1. `sizing_v2.liquidity_state()` keeps its signature, keys and numbers (`N_liquidity`, `liquidity_status`, `NO_LIQUIDITY_STATE`,
   `EXCESS_EXPECTED_SLIPPAGE`, the 25 bps bound, 30 s freshness, same venue). `tests/test_liquidity.py` proves this against a frozen copy of
   the pre-refactor function on 80 randomised books, and the existing sizing tests pass unmodified.
2. `liquidity.assess()` is the `execution_feasibility` stage (`PASS` / `REDUCE` / `REJECT`) reserved by Task A's decision semantics
   (`docs/DECISION_SEMANTICS.md`). Nothing calls it from production yet; wiring it into a decision is Task C.

## Richer walk output (additive)
Spread (bps), expected VWAP and slippage for a given notional, market impact against the touch, depth within 5 / 10 / 25 / 50 bps of mid,
and the visible notional. Units: `level_notional = price x quantity`; a quantity is never compared with a notional.

## Decision rules
- No / stale / wrong-venue / crossed / malformed book: `REJECT` with `NO_LIQUIDITY_STATE` and `max_notional` 0. Depth is never faked or reused.
- The first unit already exceeds the slippage bound: `REJECT` with `EXCESS_EXPECTED_SLIPPAGE`.
- Requested notional above the walk's cap: `REDUCE` to the cap. At or below it: `PASS`.
- `max_notional` is never larger than the request: liquidity only shrinks an order, and strong depth never raises size.
