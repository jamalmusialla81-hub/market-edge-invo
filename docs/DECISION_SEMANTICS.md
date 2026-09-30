# Decision semantics V1 (Task A, #80)

`decision` / `strict_verdict` (`TAKE TRADE`, `WAIT`, `NO TRADE`, `ANALYSIS UNAVAILABLE`) is one string that several unrelated things
write into. A `WAIT` can mean "15m and 5m timing oppose the setup", "the entry is extended", "the risk plan could not size this" or
"fewer than two feeds confirm". This layer reports those concepts separately, **next to** the legacy string. Nothing is removed and
nothing that a scan recommends changes. It is additive, research-only and pure.

## Fields (`DECISION-SEMANTICS-V1`)

| field | values | how it is derived |
|---|---|---|
| `ranking_verdict` | `STRONG` `VALID` `WEAK` `INVALID` | setup quality only. `INVALID` if there is no candidate, the analysis is unavailable or the geometry is broken. Otherwise `STRONG` at `quality >= minQuality`, `VALID` within 10 points below, `WEAK` under that. |
| `entry_readiness` | `IDEAL` `ACCEPTABLE` `EXTENDED` `INVALID` | the existing `rankedEntryAssessment()` status (`entryQuality`), promoted to its own field. `INVALID` if there is none. |
| `data_confirmation` | `CONFIRMED` `PARTIAL` `CONFLICTING` `STALE` `UNAVAILABLE` | the scan's own feed facts. `CONFLICTING` above the 2% price disagreement limit; `CONFIRMED` with at least two feeds and two matching feeds; `PARTIAL` otherwise; `STALE` only if the caller marks the data stale; `UNAVAILABLE` with no feed facts. |
| `risk_decision` | `null` | reserved for Task B. Not populated here. |
| `execution_feasibility` | `null` | reserved for Task C/G/I. Not populated here. |
| `final_execution_decision` | `null` | reserved for Task C. Not populated here. |

No new threshold is introduced. The bands reuse `settings.minQuality` (72 by default) and the 10-point WAIT band already in
`evaluateSetup`, and the data rules are the 2% disagreement limit and two-feed confirmation rule already in `backend/scan-core.mjs`.
Whether those bands mean anything is what Task D (#83) will research. Feed staleness aborts a market in the production scan, so
`STALE` is not reachable there today; it is supported for callers that know the data age.

Exact strings follow the issue. No deviation.

## Where it appears

- `Quant.decisionSemantics(q, context)` in `quant-engine.js`: pure, takes a Quant output plus `{sourceCount, matchingFeeds, maxPriceDisagreement, minQuality, stale}`.
- `runLiveScan({includeResearch: true})` adds `semantics` to `research.markets[].quantPick` and to every `research.markets[].candidates[]`,
  computed after the feed-confirmation overrides, so it describes the final Quant output.
- Shadow capture records `semantics` on every candidate's `decision.candidate` (null if the Quant output has none).
- **Never** in the customer response. The default scan is unchanged and `backend/scan-core.test.mjs` asserts both that it
  equals the research-enabled response minus `research`, and that it contains no `semantics`.

## Legacy mapping (`Quant.mapLegacyVerdict`)

Shadow research spans the cutover, so an old row is mapped from what it recorded. Nothing is guessed.

| historical `strict_verdict` | mapping |
|---|---|
| `TAKE TRADE` | each concept from the row's own facts. If the row has no feed facts, `data_confirmation` is `CONFIRMED`, because scan-core only lets `TAKE TRADE` stand with two confirming feeds inside the price limit. That is reported in `legacy.inferred`. |
| `WAIT` | each concept from the row's own facts, flagged `legacy.ambiguous`. It is never mapped to a single cause. A row without feed facts keeps `data_confirmation: UNAVAILABLE`. |
| `RANKED` | as `WAIT`, ambiguous. |
| `NO TRADE` | `ranking_verdict: INVALID`, `entry_readiness: INVALID` (ranking mode only emits it for no candidate or broken geometry). |
| `ANALYSIS UNAVAILABLE` | `INVALID`, `INVALID`, `UNAVAILABLE`. |
| anything else | `legacy.mapped: false` and the fields stay `INVALID` / `UNAVAILABLE`. |

`legacy` also carries the verdict, `mapped`, `ambiguous` and the list of `inferred` fields. Live and legacy paths share one
function (`semanticsFromFacts`), and a test checks they agree on the same facts.
