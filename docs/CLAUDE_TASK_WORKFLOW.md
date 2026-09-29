# Claude / code session task workflow

Read this before making any change to this repository. It explains how multiple Claude/code sessions coordinate safely on Market Edge using GitHub Issues as the single, canonical task-tracking system — no other task list (local file, private note, another tool) is authoritative.

**Paste-ready instruction for a new session:**

> Read `docs/CLAUDE_TASK_WORKFLOW.md` and the relevant GitHub roadmap issue before making changes. Claim exactly one READY task. Do not work outside its scope.

## The two canonical parent issues

- **[MARKET EDGE — MAJOR ROADMAP](https://github.com/jamalmusialla81-hub/market-edge-invo/issues/12)** — architecture-changing, trading-engine-changing, research-changing, risk/execution-changing work. Normally handled by the main project thread.
- **[MARKET EDGE — SIDE TASK QUEUE](https://github.com/jamalmusialla81-hub/market-edge-invo/issues/13)** — isolated UI, docs, diagnostics, test improvements, non-architectural polish. Safe for side chats.

Every individual task is its own GitHub Issue, a sub-issue of one of these two parents, with a title prefix showing its current status (`[READY]`, `[IN PROGRESS]`, `[BLOCKED]`, `[REVIEW]`, `[DONE]`, `[REJECTED]`) and a fully structured body (see "Task format" below).

## MAJOR vs SIDE — how to tell which one a task is

**MAJOR**: changes execution engine behavior (`execution-service/market_edge_exec/paper/`, `.../routing/`, `.../risk/`), risk/sizing policy, candidate generation or Quant/model ranking, research pipeline semantics, the shadow-learning schema, or anything that could move real trading outcomes — even in `PAPER`/`SHADOW` mode, even if "nothing executes yet."

**SIDE**: isolated UI (display-only), documentation, diagnostics/observability that don't change behavior, test-coverage additions, export/backup UX, build/version info. If a task that started as SIDE turns out to need an execution/risk/research code change, **stop and re-file it as MAJOR** rather than quietly expanding scope.

## One task per chat

Each coding chat/session works on **exactly one** claimed task at a time. Do not start a second MAJOR task from the same session without being explicitly instructed to. A session may pick up a new task only after its current one reaches `REVIEW`, `BLOCKED` (with the blocker documented), or `DONE`.

## Task claiming — step by step

1. Read the target parent roadmap issue (MAJOR or SIDE) in full, including its "ACTIVE FILE / AREA LOCKS" table (major roadmap only) and its checklist for current statuses.
2. Read the specific task issue you intend to claim, in full.
3. Confirm it is currently `READY` and unclaimed (no `CLAIMED BY:` comment from another still-active session). If it's `BACKLOG`, `BLOCKED`, `IN PROGRESS`, or `REVIEW`, do not claim it.
4. If it's a MAJOR task: check the major roadmap's "ACTIVE FILE / AREA LOCKS" table — if the task's declared `SCOPE` overlaps a currently-locked area owned by a *different* task, do not claim it; comment why and leave it `READY` (or mark it `BLOCKED` if the overlap is total).
5. Comment on the task issue: `CLAIMED BY: <session/chat identifier>` (use whatever identifier you have — a session URL, a chat name, anything that lets someone find you again).
6. Update the task issue's title to `[IN PROGRESS] ...`.
7. Update the relevant parent's checklist line for that task to reflect `IN PROGRESS`.
8. If it's a MAJOR task, add a row to the major roadmap's "ACTIVE FILE / AREA LOCKS" table naming the specific files/directories from the task's own `SCOPE` section, with the task's issue number and `IN PROGRESS`.

## Branch naming

Create a dedicated branch from current `main`:

```
git fetch origin main
git checkout -B <branch-name> origin/main
```

Unless the task's own issue explicitly says it depends on an open branch (e.g. rebasing an existing PR — see MAJOR 2's dependency on PR #11's `feature/risk-sizing-v2` branch). Suggested naming: `major/<n>-short-slug` or `side/<n>-short-slug` (e.g. `major/14-hyperliquid-rate-limit`, `side/31-profit-giveback-ui`), but this repo's existing convention (`claude/<adjective>-<noun>-<id>`, `feature/<slug>`) is also acceptable — consistency with the task's own issue number in the branch name or first commit matters more than a specific naming scheme.

## Protected areas / conflict avoidance

While a MAJOR task is `IN PROGRESS`, its declared protected areas are listed in the major roadmap's "ACTIVE FILE / AREA LOCKS" table. **This is a coordination mechanism, not a literal filesystem lock** — nothing technically prevents editing a locked file, but doing so anyway risks silent conflicts with in-flight architectural work.

- A SIDE task must go `BLOCKED` (referencing the locking MAJOR issue) if its own scope touches a currently-locked area, and must wait until that lock clears (the MAJOR task reaches `REVIEW`/`DONE`/`BLOCKED`/`REJECTED`).
- A second MAJOR task whose scope overlaps an active lock should generally also wait, unless its own issue explicitly says otherwise (e.g. a task that says "rebase after MAJOR 1 merges" is inherently sequenced, not overlapping).
- When your MAJOR task reaches `REVIEW`, `DONE`, `BLOCKED`, or `REJECTED`, remove its row from the locks table (or update its status in that row) promptly so others aren't blocked longer than necessary.

## Opening a PR

1. Open a PR from your branch into `main`, referencing the task issue (`Closes #<n>` if the PR fully completes it, `Part of #<n>` if more work remains under the same issue).
2. In the PR body, address every item in the task issue's `MERGE CRITERIA`, `TEST REQUIREMENTS`, and `CI REQUIREMENTS` sections explicitly — don't make a reviewer cross-reference the issue to figure out what was validated.
3. Follow this repo's existing PR conventions: local test results table, explicit statement of what was and wasn't changed, safety-invariant confirmations (mirror the style of PR #10 and PR #11's own descriptions).

## Marking REVIEW

Once the PR is open and its own local validation is green:

1. Update the task issue's title to `[REVIEW] ...`.
2. Comment on the task issue with the PR link and a checklist confirming which `MERGE CRITERIA` items are satisfied.
3. Update the relevant parent's checklist line to `REVIEW`.
4. If it was a MAJOR task, update/remove its "ACTIVE FILE / AREA LOCKS" row.

## Never auto-merge

**Do not merge a PR automatically** — not even if every test passes and every merge criterion looks satisfied — unless the task's own issue explicitly authorizes it, or the repository owner explicitly authorizes it in writing on the issue or PR. Merging is a decision the human owner (or an explicitly-instructed session) makes, not a default outcome of green CI.

## Updating the roadmap

- Whenever a task's status changes, update **both** the task issue's title/body and the relevant parent issue's checklist line — they must never drift out of sync.
- When a MAJOR task's dependencies change (e.g. it was `BLOCKED BY` something that just merged), update its `STATUS`, `DEPENDENCIES`, and `BLOCKED BY` sections to reflect the new reality before claiming or re-claiming it.
- When a task is fully done and merged, mark it `[DONE]`, check its box on the parent checklist, and close the issue with `state_reason: completed`.
- When a task turns out to be wrong/obsolete/superseded, mark it `[REJECTED]`, explain why in a comment, and close it with `state_reason: not_planned` (or `duplicate` if applicable) — do not just delete or silently abandon it.

## Adding a newly discovered task

If, while working a claimed task, you notice something else that needs doing but is outside your task's `SCOPE`:

1. **Do not fix it inline** unless it is a one-line, obviously-safe correction directly required to complete your own task's stated scope.
2. File it as a new issue, sub-issue of the correct parent (MAJOR or SIDE, per the criteria above), using the full task format below — even for something that looks small, so a future session can pick it up without hidden context.
3. Reference where you discovered it (which task, which file/line) in the new issue's `WHY THIS EXISTS` section.
4. Do not start the new task yourself unless you've completed (or abandoned, with documentation) your currently-claimed task first, per "one task per chat" above.

## Avoiding duplicate work

Before filing a new task or claiming an existing one:

- Search both parent issues' checklists for anything that already covers the same ground.
- Check open PRs (`gh pr list` / the GitHub UI / `list_pull_requests`) for in-flight work that might already address it.
- If you find a near-duplicate, either claim the existing task instead of creating a new one, or, if genuinely different in scope, note the relationship explicitly in the new task's `DEPENDENCIES`/`RELATED PRS / COMMITS` sections.

## Task format

Every individual task issue must include every one of these sections (copy this structure when filing a new one):

```
## TYPE
MAJOR / SIDE (plus a rough category: INFRA, EXECUTION, RISK, DATA, RESEARCH, DESKTOP, DOCS, TESTS)

## STATUS
BACKLOG / READY / IN PROGRESS / BLOCKED / REVIEW / DONE / REJECTED

## PRIORITY
P0 / P1 / P2 / P3

## DEPENDENCIES
What this needs to exist/merge first (link issues).

## BLOCKED BY
What is currently stopping this from being READY, if anything.

## WHY THIS EXISTS
The concrete problem/observation motivating this task, with specifics (file paths, PR numbers, actual observed behavior) — not a vague aspiration.

## CURRENT BEHAVIOR
What the code actually does today, with file/function references.

## DESIRED BEHAVIOR
What it should do instead, precisely enough to implement without re-asking the requester.

## SCOPE
Exactly what files/areas/behavior this task covers.

## OUT OF SCOPE
Exactly what it must NOT touch, including adjacent things someone might be tempted to "fix while in there."

## TECHNICAL REQUIREMENTS
Implementation constraints, patterns to reuse, conventions to follow.

## DATA / RESEARCH REQUIREMENTS
What data this needs (and doesn't — e.g. "never the sealed holdout").

## SAFETY INVARIANTS
What must remain true no matter what (fail-closed behavior, caps, PAPER_ONLY, no fabricated data, etc.).

## TEST REQUIREMENTS
Specific tests to add/keep passing.

## CI REQUIREMENTS
Which CI suites/workflows must stay green.

## MANUAL VALIDATION
What a human/session should do by hand to confirm it actually works.

## EXPECTED OUTPUTS
What the deliverable looks like concretely.

## MERGE CRITERIA
The explicit bar for "this PR is mergeable."

## ROLLBACK / FAILURE BEHAVIOR
What happens if this needs to be reverted, and what's never acceptable failure behavior along the way.

## NEXT TASK AFTER COMPLETION
What naturally follows.

## OWNER / CLAIM INFO
Unclaimed, or `CLAIMED BY: <identifier>`.

## RELATED PRS / COMMITS
Links.
```

Do not create one-line vague tasks. Each task must be detailed enough for an independent Claude session to execute safely without needing hidden context from whatever thread originally identified it.

## Labels

This repository has no pre-existing custom labels or GitHub Project fields for `TYPE`/`STATUS`/`PRIORITY` (checked via `list_issue_fields` and `get_label` when this workflow was set up), and the available tooling could not create new custom labels. Status/type/priority are therefore tracked authoritatively in each issue's structured body and its title prefix (`[STATUS] Title`), with the existing default `enhancement`/`documentation` labels applied where they roughly fit, as an approximation. If custom labels (`type:major`, `status:in-progress`, `priority:p0`, etc.) become creatable later (repo settings UI, or a tool that supports it), apply them retroactively — but the body/title remain the source of truth regardless.

## If a GitHub Project board exists or is added later

GitHub Issues remain the canonical source of truth regardless. A Project board may be layered on top for visualization, but never as a replacement — nothing should exist only on a board and not as a properly-formatted issue.
