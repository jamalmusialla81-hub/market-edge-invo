# Dynamic correlation / factor clusters (Task K, candidates `CLUSTER-DYN-V1-*`)

Research candidates beside `CLUSTER-STATIC-V1`. Nothing calls them from production: Risk Sizing V2 still uses the static map and every cap
(2% open risk, 1% per cluster, 20% gross, 5% per position, 4 positions) is untouched. A candidate becomes authoritative only through MAJOR 6's
evidence-gated review, under its own `cluster_method_version`.

## Design
- **Never looser than static, by construction.** A dynamic grouping is the static grouping plus extra links found in the data (connected
  components), so assets the static map keeps together (including everything in `UNCLASSIFIED`) always stay together. `refines_static()` checks it.
- **No single universal threshold.** A candidate is a named parameter set (`windows`, `link_level`, `vol_scaled`); four are evaluated side by side.
  A link requires the correlation to clear the level in *every* window (the minimum across windows), with a stable sign, on volatility-scaled
  returns (scaled by trailing volatility using only earlier returns, so there is no lookahead), with at least 30 overlapping bars per window.
- **Missing data never loosens or invents.** An asset without enough history gets no dynamic link and keeps only its static cluster.
- **Factors reported:** beta to BTC and to an equal-weight crypto index, per window.
- **Direction-aware:** `same_bet()` treats a long and a short in the same cluster as a hedge unless the pair is stably anti-correlated, in which
  case opposite directions are the same bet. Two longs in a cluster are one bet.

## Not done here
- **Shadow counterfactual wiring.** This is the pure research module. Running a candidate as an extra counterfactual inside the paper engine
  (as Risk Sizing V2's SHADOW mode does) needs candle inputs plumbed into `open_from_signal`; it is a follow-up that should come with real candles.
- **Manual validation on real candles.** My sandbox has no exchange access and the shadow database keeps no raw candles, so the tests use
  synthetic factor-model data. The audited Coinbase archive used by the research workflows is the place to run a real-data comparison (CI only).
- **Choosing a link level.** None is recommended. The four candidates exist so a later Shadow comparison can choose from evidence.
