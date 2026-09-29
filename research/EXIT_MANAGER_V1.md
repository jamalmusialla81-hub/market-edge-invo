# Adaptive Exit Manager V1 (MAJOR 3, shadow only)

**Status: built and tested; no evidence yet.** Nothing here is authoritative. No adaptive exit can change what a real paper trade does. Promotion is MAJOR 4 and needs the evidence gate (3H) to pass first.

## The problem

Open positions are monitored every ~10s, but exits are fixed at entry (stop, TP1 50% + breakeven, TP2, timeout). A trade can run well into profit (large MFE), miss the next fixed target, reverse, and give the gain back. The missing layer is adaptive position management, not monitoring frequency.

`profit_giveback_R = MFE_R - final_realised_R`

## What was built (`execution-service/market_edge_exec/exits/`)

| Part | File | What it is |
|---|---|---|
| Position State Engine | `state.py` | Pure function: current price, unrealized R, MFE/MAE, time since entry, time since MFE, distance from peak, active stop and distance, TP distances, volatility, adverse-close count, momentum. |
| Policies 3A-3F | `policies.py` | 17 candidate policies + `CURRENT_POLICY`, each `(PositionState, params) -> Action`. Versioned by name; params are frozen. |
| Replay engine 3G | `replay.py`, `shadow.py`, `store.py` | Deterministic replay of what a real trade actually observed, once per policy, into `exit_policy_counterfactuals`. |
| Evidence gate 3H | `evaluation.py` | Cluster bootstrap, predeclared bar, per-policy verdicts. |

Actions: `HOLD`, `TIGHTEN_STOP`, `MOVE_TO_BREAKEVEN`, `TRAIL_STOP`, `PARTIAL_EXIT` (at most once per trade), `FULL_EXIT`.

### The candidate policies

| Study | Versions | Rule |
|---|---|---|
| 3A breakeven | `BREAKEVEN_V1_R0.5/0.75/1.0` and `_COSTS` | Stop to entry (or entry + round-trip fees + slippage, 0.13%) once MFE reaches the threshold, independent of TP1. |
| 3B MFE giveback trail | `MFE_TRAIL_25/33/50` | After +0.5R MFE, stop locks all but 25/33/50% of the peak favourable move. |
| 3C volatility trail | `VOL_TRAIL_V1_K2/K3` | After +0.5R MFE, stop trails the peak by k x mean 5m candle range of the last 12 candles. No trail until 3 candles are seen (never a guessed volatility). |
| 3D post-TP1 protection | `POST_TP1_PROTECT_V1_L25/L50` | After TP1, stop locks 25/50% of the entry-to-TP1 distance. |
| 3E momentum decay | `MOMENTUM_DECAY_V1_N2/N3` | Winner (MFE >= 0.75R, still in profit) exits after N consecutive adverse 5m closes and a 0.4R retrace from peak. Deterministic and interpretable; no learned model. |
| 3F time + profit decay | `TIME_DECAY_V1_H12/H24` | Winner (MFE >= 0.5R) with no new peak for H hours: stop to half the MFE; at 2H exit if it faded below 75% of the peak. |

## Replay rules (what makes the comparison fair)

- **Same observations, same lifecycle.** The engine records every price it evaluated (`TICK`) and every 5m candle it swept (`CANDLE`) into an append-only log. `CURRENT_POLICY` replays them through the very same `lifecycle.advance` / `evaluate_tick` the real engine uses, so it reproduces the real trade's exits exactly (kinds, quantities, fills, times, fees, R). This is asserted in tests for TP1/TP2, stop with a gap fill, short, candle sweep with breakeven, timeout and mixed tick/candle paths.
- **No lookahead.** An observation is judged against the stop the policy had set *before* it; only then does it enter the state the policy reads. A candle is only known at its close.
- **The hard stop is a floor.** Stops only ratchet tighter; the original stop (and breakeven after TP1) is never loosened. A policy can only exit earlier. A stop proposed through the market is an exit now.
- **Gaps are conservative.** A candle that opens through a policy stop fills at the open, not at the better stop level.
- **Incremental = full.** A replay is a pure state machine; an open trade resumes from its persisted state and reaches exactly the result of a full replay (tested at several cut points, through a JSON round trip).
- **Units.** 1R = `|entry - stop| x quantity` (initial stop risk); R is after fees, and slippage is included in the fills. `MFE_R` is on the same basis. These are not the planned-loss R of Risk Sizing V2.
- **Time since MFE** for a peak inside a candle is measured from the candle open (at most 5 min pessimistic).

## Safety

- The shadow reads the trade dict; it never writes a trade, order, router, portfolio, capital, Nautilus or Hummingbot state. Tests run the shadow under a SQLite authorizer that denies every write outside `exit_*` tables, and compare the trade rows, events, equity and order tables byte for byte before and after.
- Every engine hook is isolated: an exception in research code is logged and swallowed, and a test proves a broken research store cannot affect a real exit. `MARKET_EDGE_EXIT_SHADOW=0` turns it off.
- `exit_path_observations` is append-only and finalized `exit_policy_counterfactuals` rows are frozen, both by triggers (migration `0004_exit_shadow`).
- The only production-file change is an optional `active_stop_override` argument on `lifecycle.advance` / `evaluate_tick`; real callers never pass it and all existing lifecycle tests are unchanged.
- API (read only, labelled *RESEARCH ONLY · COUNTERFACTUAL · NOT AN ACTUAL FILL*): `GET /research/exit-policies`, `/research/exit-policies/trade?trade_id=`, `/research/exit-policies/evaluation`.

## The evidence bar (`EXIT-EVIDENCE-BAR-V1`, declared before any data)

Primary metric: mean per-trade paired difference in after-cost R (policy minus `CURRENT_POLICY` on the same trades). Giveback reduction is reported but cannot be the gate, because it can be bought with premature exits.

A policy passes only if **all** hold, with trades resampled as whole 24h episodes (cluster bootstrap, 4000 resamples, 95%):

1. at least 30 trades and 30 independent episodes (otherwise `INSUFFICIENT_EVIDENCE`, never a verdict);
2. the CI lower bound of the primary metric is above 0;
3. 5th-percentile R no more than 0.10R worse than the baseline;
4. max drawdown of cumulative R no more than 0.5R worse;
5. premature-exit rate at most 40% (a policy exit where the real trade then finished at least 0.10R better);
6. no bucket (asset, direction, volatility regime, before/after TP1) with at least 10 trades averaging more than 0.20R worse.

Nothing is ranked on one scalar, and nothing is promoted by code.

## Evidence so far

**None.** There is no forward paper trade history in the repository or CI (shadow data lives only in the owner's desktop app), so 0 real trades have been replayed and no policy has a result. The harness is validated on synthetic data only: it recovers a known +0.30R effect, reports no significant effect on null data (false-positive rate at the stated level), fails a harmful policy, fails a mean gain bought with tail risk or a harmed bucket, and refuses a verdict on thin or over-clustered data. Those tests prove the machinery, not any policy.

Every one of the 17 policies is currently `INSUFFICIENT_EVIDENCE`, and the honest state of 3A-3F is "implemented, tested, not yet evaluated". A rejection is a valid outcome for any of them once data exists.

## Next

1. Let the desktop app accumulate real paper trades; the shadow records observations and counterfactuals for every trade from now on (trades opened before this build have no path and are not replayed).
2. Read `GET /research/exit-policies/evaluation` (or the desktop app's exported database) once there are at least 30 independent episodes.
3. Only then decide anything about MAJOR 4. Also unbuilt: a UI for the counterfactuals (SIDE 3), and recording `best_price_at_ms` on trades (#41) would sharpen time-since-MFE.
