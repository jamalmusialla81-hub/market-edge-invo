# Drawdown recovery state machine (Task L, `DD-RECOVERY-V1-UNVALIDATED`)

**Shadow only.** Nothing in this change alters `drawdown_multiplier`, sizing or any entry decision, and no production path calls the machine.
The existing tiers (<5% x1.00, 5-10% x0.75, 10-15% x0.50, >=15% pause) are read from the `SizingPolicy` and are unchanged. What is new is a modelled
controlled restart after a pause, with persistence, an audit trail and a manual override, ready to be enforced if and when you decide to.

## Lifecycle
`NORMAL / REDUCED / SEVERELY_REDUCED` (the existing tiers) -> `PAUSED` (drawdown at or above the pause level, from any state) ->
`DIAGNOSTIC_REVIEW` (drawdown back under the pause level; entries stay blocked) -> a named human's `acknowledge_review` -> `RECOVERY_1` -> `RECOVERY_2` -> `RECOVERY_3` -> the live tier.

Structural guarantees, tested: a paused account cannot reach NORMAL in one step (or in any number of observations without a human and forward evidence); recovery
moves exactly one tier per call; a return to the pause level always resets to PAUSED; every transition writes its state and its `control_audit` row in one
transaction (`ControlStore.put_json_audited`), so there is no silent change; every manual action requires an operator and a reason and is logged.

## What is a guess (and labelled so)
The recovery risk caps (0.10% / 0.20% / 0.30% of equity per trade) and the advancement rule (10 clean trades from at least 5 distinct episodes taken AT the tier)
are illustrative engineering defaults from the issue, not research results, and they carry the `UNVALIDATED` version tag. Advancement is by forward evidence,
never by elapsed time or an equity number. Nothing should enforce them until forward data supports specific numbers, under a new version.

## Manual controls
`acknowledge_review(operator, note)` is the only way out of `DIAGNOSTIC_REVIEW`. `override(target, operator, reason)` moves to any state; the human is the authority,
so it is unrestricted but never silent.

## Not done
- **Wiring.** No caller feeds it drawdown or closed trades yet, and there is no API or UI for the acknowledgement/override. Enforcing it in sizing changes real
  paper risk behaviour, so I left that decision to you. The wiring is small: call `observe(dd)` where sizing computes drawdown and `record_trade()` on close.
- **Research on advancement thresholds** needs forward trades taken at recovery tiers, which cannot exist until it is enforced.
