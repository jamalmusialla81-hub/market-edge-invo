# Risk Sizing V2 — planned-loss position sizing (paper only)

**Risk engineering, not alpha.** V2 changes how much each trade risks and how
exposure is bounded. It does not change Quant ranking, candidates, thresholds,
features, research models, labels or the sealed holdout, and it does not
create predictive edge.

Code:
- `execution-service/market_edge_exec/risk/sizing_v2.py`: pure functions
- `risk/clusters.py`
- `risk/sizing_runtime.py`: glue to the ledger

Tests:
- `tests/test_risk_sizing_v2.py`: the invariants
- `tests/test_risk_sizing_v2_paper.py`: engine, API, restart, backup and shadow

## From "5% of wallet" to a planned-loss budget

Each trade gets a **planned-loss budget**. Notional follows from stop distance
plus execution costs, and every hard cap can only cut it:

```
E_s     = E x (1 - 5% x (fee + 25 bps))          sizing equity: net of this trade's worst-case entry cost
d_stop  = |entry - stop| / entry
r_eff   = BASE_RISK_PCT x m_vol x m_DD           (m_vol <= 1, m_DD <= 1: they can only reduce)
B       = E_s x r_eff                            risk budget, $
L       = d_stop + max(EXECUTION_BUFFER_FLOOR_PCT, fees + entry slippage + stress exit slippage)
N_risk  = B / L
N_final = MIN(N_risk, 5% E_s, N_liquidity, cluster room / L, planned-risk room / L, 20% E_s - open notional, margin room)
qty     = floor(N_final / entry, venue size step)      rounded DOWN, never up
reject if qty x entry < venue minimum ($10) or qty = 0 -> MIN_ORDER_EXCEEDS_SAFE_SIZE
```

Why `E_s` rather than `E`: the new trade's own fee and slippage lower equity the
moment it opens. The caps have to hold after that, not only before.

## Parameters (initial engineering policy, `RISK-SIZING-V2.0`)

| Parameter | Value |
|---|---|
| BASE_RISK_PCT | 0.50% of equity (maximum normal planned loss per trade) |
| MAX_POSITION_NOTIONAL_PCT | 5% (hard ceiling) |
| MAX_PORTFOLIO_GROSS_PCT | 20% |
| MAX_OPEN_PLANNED_RISK_PCT | 2% |
| MAX_CLUSTER_PLANNED_RISK_PCT | 1% |
| MAX_POSITIONS | 4 |
| MAX_LEVERAGE | 1x |
| RV_LOOKBACK_DAYS / VOL_REFERENCE_LOOKBACK_DAYS | 20 / 180 |
| VOL_MULT_MIN / MAX | 0.50 / 1.00 |
| EXECUTION_BUFFER_FLOOR_PCT | 0.25% of notional |
| MAX_EXPECTED_ENTRY_SLIPPAGE_BPS | 25 |
| Drawdown throttle | <5%: 1.00 · 5–10%: 0.75 · 10–15%: 0.50 · ≥15%: pause new entries |
| KELLY_ENABLED | false |

**0.50%, 1%, 2%, 5%, 20%, the drawdown steps and 25 bps are initial engineering
policy parameters.** They are not claimed to be universal empirical optima, and
they were not tuned against any research dataset. Any change ships under a new
`sizing_rule_version`.

## Why 5% is a ceiling, not a target

With $10,000 equity the budget is $50. A 1% stop would imply about $3,600 of
notional, so the 5% ceiling caps it at about $500 and the planned loss drops to
about 0.06%. **That $500 is kept.** Notional is never raised above 5% to "use"
the 0.50% budget.

A wide stop naturally gives a small position. At 20% the position is about $247,
far below $500, and that is correct: no position is enlarged to reach 5%.

Hard limits always win, and V2 willingly under-risks when any constraint binds.

## Planned risk versus notional

`planned_loss_dollars` = notional × `L`: the price move to the stop, plus the
execution allowance.

- **Portfolio:** Σ current planned loss of open positions + the new trade ≤ 2% of
  equity.
- **Clusters:** Σ within one cluster ≤ 1%.
- **Gross exposure:** open notional ÷ equity, shown as a multiple, e.g. `0.05x`.
  It is **not** leverage. Position leverage is shown separately.

## Volatility scaler (defensive only)

The current volatility is the annualised standard deviation of daily log returns
over 20 days, from the same scan's **Hyperliquid** completed daily candles. The
reference is the median of that 20-day volatility over the trailing 180 days.

```
m_vol = clip(reference / current, 0.50, 1.00)
```

High volatility reduces risk. **Low volatility can never raise risk above 0.50%**:
`m_vol ≤ 1` is enforced by the policy constructor.

The volatility input fails closed with `NO_VOLATILITY_STATE` when:
- it is missing
- it comes from a different venue or interval (it is never substituted)
- there are fewer than 201 valid closes
- the last daily bar is stale (more than 2 days old)
- volatility is zero.

## Drawdown throttle

Drawdown is measured on the authoritative paper ledger, from peak equity.

At ≥15% drawdown, new entries are rejected with `DRAWDOWN_RISK_PAUSE` in **both**
rollout modes. Existing positions stay fully managed: the fast monitor, stops,
TPs, timeouts, reconciliation and shadow observation all continue. Nothing is
force-closed because of the threshold.

## Clusters (`CLUSTER-STATIC-V1`)

The cluster assignment is a static, auditable map:
- MAJORS: BTC, ETH
- L1_PLATFORMS
- L2_SCALING
- DEFI
- MEMES
- AI_DATA

**Conservative fallback:** any unmapped symbol goes to one shared `UNCLASSIFIED`
cluster, so unknown assets can never stack as if they were independent.

Each decision records:
- `cluster_id`
- `cluster_method_version`
- `existing_cluster_planned_risk`
- `remaining_cluster_risk`
- whether the cluster cap bound the size.

A data-driven method (rolling correlation) must ship as a new version.

## Liquidity cap

The cap uses the real Hyperliquid `l2Book`, read **once per cycle, only for the
one submitted signal**. It is never read for research, and never competes with the
open-position monitor.

`N_liquidity` is the largest order whose average fill stays within 25 bps of the
mid, found by walking the real levels.

The entry-slippage estimate is taken at the 5% ceiling. When the book can't fill
that within the bound, the bound itself is used. Either way a thinner book can
only lower the size.

When V2 is authoritative, the book must be:
- fresh (≤30 s)
- from the same venue
- valid.

A missing or invalid book gives `NO_LIQUIDITY_STATE`. When even the best level is
beyond 25 bps, the result is `EXCESS_EXPECTED_SLIPPAGE`. No depth is ever faked or
reused.

The shadow counterfactual has no book, so it records
`liquidity_status: UNAVAILABLE` and applies no liquidity cap. It is labelled as
such.

## Leverage

Risk and notional are decided first, leverage second. The planned loss depends
only on notional and the stop distance; leverage changes margin, never the loss.

`MAX_LEVERAGE = 1x` in this version: the policy refuses a higher value and
requests are clamped.

**Future derivatives invariant:** the liquidation distance must exceed the stop
distance plus a stress buffer, established from the venue's rules. If that can't
be established, reject rather than guess.

## Kelly

Kelly is disabled. `kelly_fraction()` is an inert interface, and
`SizingPolicy(kelly_enabled=True)` raises an error. Even if Kelly is researched
later, it could never bypass any cap.

## Rollout: SHADOW, then PAPER

The mode is set by `RISK_SIZING_V2_MODE=SHADOW|PAPER`; anything other than
`PAPER` means SHADOW. The default is **SHADOW**.

**SHADOW mode:**
- The existing sizing stays authoritative.
- V2 is computed for every signal that reaches sizing, including rejected ones.
- V2 is stored as an immutable **COUNTERFACTUAL** record next to the
  **AUTHORITATIVE** legacy record (`RISK-V1-LEGACY`), in the same record shape.

**PAPER mode:**
- V2 is authoritative, and every existing gate still applies on top: kill switch,
  4 positions, daily loss, 5%/20% caps, leverage versus liquidation, fresh price,
  and the atomic entry lock.
- The executed quantity is `min(V2, legacy)`. If the legacy gate is smaller, the
  record says `LEGACY_V1_GATE`.
- The legacy "dust" floor is switched off, because V2 deliberately under-risks and
  has its own venue-minimum rule.

LIVE is not a sizing mode, and it stays disabled.

## Records

- **Immutable decision record.** Table `risk_sizing_decisions`, migration 0003.
  UPDATE and DELETE are refused, and each record is hashed.
  - It holds every decision-time field: equity, base and effective risk,
    drawdown and its multiplier, volatility, reference and multiplier, entry,
    stop and stop distance, fees, slippage, execution buffer, budget, raw
    notional, and every cap.
  - It also holds the final notional and quantity, planned loss in $ and %,
    leverage, margin, cluster, rule versions, binding constraint and reduction
    reason, timestamp and market-data provenance.
- **After-trade outcomes.** Table `risk_sizing_outcomes`, written once when a
  trade closes, also immutable.
  - It holds realised fees, entry/exit/stop slippage, realised maximum loss,
    realised R, MFE/MAE, and loss versus planned.
  - These never enter a decision record, and the leakage guard treats
    `realised_*` outcome fields as targets. `realised_vol` is a decision-time
    input and is allowed.
- **Current risk** is recomputed from the persisted trade state:
  - the remaining quantity against the active stop (entry after TP1, per the
    breakeven rule)
  - plus the original execution allowance.

  It is kept separate from the original, which is never rewritten. After a
  restart, the open and cluster planned risk are exactly what they were.
- **Shadow counterfactual sizing.** Every shadow candidate carries
  `counterfactual_sizing`: what V2 would have assigned at decision time.
  - It is sized alone against the open paper positions at that moment.
  - It is computed on a read-only snapshot: no reservation, no exposure or cluster
    budget consumed, no position, no order, no Nautilus or Hummingbot call.
- **Backup.** Both tables are in the paper database, which the desktop backup
  copies online, with row counts and policy versions in the validation. Shadow
  counterfactuals are in the shadow database, which is also backed up. No secrets
  are included.

## Failure modes (machine-readable reasons)

- `INVALID_STOP`
- `NO_EQUITY`
- `STALE_MARKET_DATA`
- `NO_VOLATILITY_STATE`
- `NO_LIQUIDITY_STATE`
- `DRAWDOWN_RISK_PAUSE`
- `MAX_POSITIONS`
- `POSITION_NOTIONAL_CAP`
- `PORTFOLIO_GROSS_CAP`
- `PORTFOLIO_PLANNED_RISK_CAP`
- `CLUSTER_PLANNED_RISK_CAP`
- `LIQUIDITY_CAP`
- `EXCESS_EXPECTED_SLIPPAGE`
- `MARGIN_CAP`
- `MIN_ORDER_EXCEEDS_SAFE_SIZE`
- `INVALID_RISK_CALCULATION`: a post-check that re-verifies every cap before
  approving.

## Invariants tested

- Size never increases when any of these gets worse:
  - a wider stop
  - higher costs
  - higher volatility
  - a larger drawdown
  - less cluster, portfolio or gross room
  - thinner liquidity
- Leverage never changes the planned loss.
- None of these is ever exceeded, checked across a grid of about 1,600
  combinations:
  - 5% position notional
  - 20% gross exposure
  - 2% open planned risk
  - 1% cluster planned risk
  - 4 positions
- Low volatility never raises risk above 0.50%.
- Rounding never exceeds the safe amount.
- A venue minimum above the safe size is rejected.
- Every missing or invalid safety input fails closed.
- Restart keeps budgets. TP1 lowers current risk without touching the original.
  Records are immutable. Racing signals cannot share the last cluster budget.
  Shadow counterfactuals consume no capital.

## Forward review (MAJOR 6, #27; harness from #70)

`execution-service/market_edge_exec/evaluation/sizing_review.py` is the
comparison MAJOR 6 runs once enough SHADOW trades have closed:

```
cd execution-service
python -m market_edge_exec.evaluation.sizing_review /path/to/market_edge_paper.sqlite3 [--json]
```

It opens the ledger read-only and pairs, per closed SHADOW trade, the legacy
AUTHORITATIVE record with V2's COUNTERFACTUAL record. V2's P&L is the realised
P&L times `v2_qty / legacy_qty`. That is exact for the paper engine (a test runs
the same path with V2 authoritative and gets the same number); a trade V2 would
have rejected counts as 0. Records whose hash does not match are excluded and
counted. Open trades and PAPER-mode trades (no counterfactual) are excluded.

Evidence bar `SIZING-EVIDENCE-BAR-V1`: at least 30 closed trades in 30
independent 24h episodes (the same floor and cluster bootstrap as MAJOR 3H),
then all of: V2's stop overshoot rate at most 10% of its losing trades and no
worse than legacy's; the cluster-CI lower bound of the per-trade return
difference no worse than -0.10% of equity; V2's max drawdown and 5th-percentile
trade no worse than legacy's. The output is `INSUFFICIENT_EVIDENCE`, `FAIL` or
`PASS`. A PASS is a recommendation: switching to PAPER stays a separate,
owner-authorised action, and nothing reads the verdict.
