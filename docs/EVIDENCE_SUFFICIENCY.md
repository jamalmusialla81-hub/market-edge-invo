# Forward evidence sufficiency (Task Y, `EVIDENCE-SUFFICIENCY-V1`)

`evidence-sufficiency.js` measures how much *independent* forward evidence a set of outcomes represents. It is
measurement only: no decision, score, threshold or gate consumes it yet (Tasks X, Z, D, E, V will).

## What it reports
Raw observations, resolved outcomes, independent market episodes, unique scans, independent clusters, assets,
strategies, directions, regimes and forward-day span, plus `status` = `INSUFFICIENT | EARLY | DIRECTIONAL | DECISION_USEFUL`,
the dimensions holding back the next tier (`shortfalls`, worst first) and warnings such as
"8333 resolved outcomes come from only 40 independent episodes".

## How a tier is decided
Every dimension must clear its floor at once; no single number (count or days) can lift a tier.
- `DECISION_USEFUL` floors are the forward-diagnostic floors: 100 resolved, 30 clusters, 30 episodes, 14 days, 4 assets, 2 strategies.
- `DIRECTIONAL` and `EARLY` are 30% and 10% of those floors, rounded up: the same 30/100 and 10/100 ratios the legacy raw-count tier used, applied to independent evidence.
- Episode and cluster ids come from Shadow Learning (`market_episode_id`, `observation_cluster_id`). Rows without them add no episodes or clusters and are counted as `unlinked`; linkage is never invented.
- Direction and regime diversity are reported but have no floor yet (no research supports one).

## Legacy `sampleTier`
`performanceStats().sampleTier` (quant-engine.js) and the forward-engine tier stay as documented legacy aliases so nothing
changes silently. They only count trades. New consumers should use `evidenceSufficiency(rows)`; the two can be shown side by side during a transition.

## Replay on real Shadow history (Jakob's 2026-09-29 backup)
8,333 observations, none resolved yet (7,388 PARTIAL, 897 PENDING, 48 invalid snapshots) -> `INSUFFICIENT`.
Even if every observation were counted as resolved: 40 episodes, 511 clusters, 40 assets, 5 strategies, 0.81 days
-> still `INSUFFICIENT` (days), with the warning that 8,333 outcomes are 40 independent episodes.
