# Position lifecycle variants (Task O, exit registry `EXIT-POLICIES-V2`)

Shadow-first. The production lifecycle (50/50 TP split, stop to breakeven after TP1, 120h timeout) is unchanged and no
promotion is proposed. Four fixed-structure variants join the **existing** exit-policy registry (study `3O`) and replay through
the same `lifecycle.advance` / `evaluate_tick`, the same append-only store and the same `EXIT-EVIDENCE-BAR-V1` gate as MAJOR 3.

| policy | differs from CURRENT_POLICY by |
|---|---|
| `TP1_SPLIT_V1_25_75` | 25% at TP1, 75% at TP2 |
| `TP1_SPLIT_V1_75_25` | 75% at TP1, 25% at TP2 |
| `TIMEOUT_V1_H48` | timeout after 48h |
| `TIMEOUT_V1_H72` | timeout after 72h (the shadow research horizon) |

Each differs by exactly one named number, so a result can be attributed. Registry version moved V1 to V2 because policies were added; no V1 policy changed
and old records keep their V1 label. Mechanism: policy params `tp1_fraction` / `max_hold_h` are passed by the replay to the lifecycle
functions through a new optional `tp1_fraction` keyword (default = production value, so real behaviour is byte-identical).

## What was deliberately not done
- **Longer timeouts.** A real trade's recorded path ends when the real trade exits (at most 120h). A 240h variant could not be replayed
  without inventing prices, so it would only ever show PATH_ENDED_OPEN. Only shorter timeouts are listed.
- **Delayed / looser breakeven.** The replay package's invariant is that policies only tighten stops or exit earlier (tested for every policy).
  A "breakeven later than after TP1" variant would loosen protection and break that invariant. Tighter breakeven timing is already covered by MAJOR 3A
  (`BREAKEVEN_V1_R*`). If you want the invariant relaxed for research, that is a decision for you.
- **Partial-exit timing beyond the split** and **per-strategy structures**: per-strategy evaluation needs per-strategy forward data (Task F / DATA 19); the
  evaluation gate can group these same records by strategy once it exists.

## Expected result today
`INSUFFICIENT_EVIDENCE` for all four, like every other MAJOR 3 policy (the bar needs 30 trades in 30 independent episodes).
Note the gate pairs only trades where a variant exited: a shorter timeout is compared on the trades that reached it.
