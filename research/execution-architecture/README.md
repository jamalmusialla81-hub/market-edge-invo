# Market Edge — Nautilus/Hummingbot Execution Architecture (Paper, v0)

Status: paper-only design + in-repo domain/router/reconciliation scaffold.
No exchange execution. No change to production Market Edge (quant-engine.js,
replay-engine.js, the scanner, journal, or customer UI).

## Why this lives here first

Market Edge's production stack is plain Node.js (Cloudflare Worker + D1) and
a static/React frontend. NautilusTrader and Hummingbot are both Python
systems. This prototype cannot embed them in the current repo — it defines
the **contracts** (domain objects, router, reconciliation) that a future
separate Python service (the actual Nautilus process + Hummingbot bridge)
will implement, and proves those contracts with paper-only Node tests today.
The real Nautilus portfolio/risk wrapper and Hummingbot execution client are
the next, separate piece of work once that Python service exists; this
directory is not that service.

## NAUTILUS OWNERSHIP

Nautilus (once the Python service exists) is the sole system of record for
strategy/portfolio state, positions, balances, risk, sizing, order intent,
PnL, reconciliation, and kill switches. In this prototype, `paper-backend.js`
plays that role for a single instrument's position ledger so the router and
reconciliation logic can be tested without a live Nautilus process.

## HUMMINGBOT ROLE

Execution transport only. It never independently decides a trade: it only
ever receives an already-risk-approved `ExecutionIntent` from the router and
returns an `ExecutionFill`. `paper-backend.js` stands in for both the
Nautilus-native paper route and the Hummingbot paper route today — they are
functionally identical paper ledgers, deliberately, so the comparison work in
"first prototype" (fill semantics, latency, fees, slippage) has a neutral
baseline before either real backend is wired in.

## EXECUTION ROUTER

`execution-router.js` implements `ExecutionRouter({riskGate, routingTable,
backends})`:
- Validates the intent shape (`domain-objects.js: ExecutionIntent`).
- Calls the risk gate (or accepts a pre-computed `RiskDecision`) and refuses
  to route anything not `approved`, or whose `leverage` exceeds
  `approved_leverage` — risk runs strictly before routing, never inside a
  backend.
- Refuses to route the same `signal_id` twice (`EXECUTION_ROUTER_DUPLICATE_SIGNAL`),
  which is the concrete form of "one signal -> one order."
- Resolves a backend by `venue_preference`, then a per-instrument
  `routingTable`, then `NAUTILUS_NATIVE` as default — deterministic and
  configurable, per the venue-routing requirement.

## RECONCILIATION DESIGN

`reconciliation.js: reconcile(canonicalPositions, backendPositions)` is a
pure, read-only comparison: it reports `orphanOrders` (backend has a position
canonical state doesn't), `unknownPositions` (the reverse), and `mismatched`
(quantity disagreement), and only ever sets `reconciled: true` when none of
the three are present. It fixes nothing automatically — "fail safe if state
cannot be reconciled" means surfacing the divergence, not silently choosing a
side. The real service will run this on startup and reconnect against actual
Hummingbot/exchange queries; here it runs against the paper ledger.

## VENUE ROUTING PLAN

`routingTable` maps instrument -> backend name so, e.g., Hyperliquid can be
pointed at whichever of the native Nautilus adapter or the Hummingbot bridge
proves more stable, and a future DEX instrument can be routed to
`HUMMINGBOT` (Gateway) without touching alpha or router code — only the
table entry changes.

## PAPER PROTOTYPE (current scope)

Implemented now, paper-only, BTC/ETH-shaped:
1. `domain-objects.js` — `AlphaSignal, RiskDecision, PortfolioDecision,
   ExecutionIntent, ExecutionFill, PositionSnapshot`.
2. `execution-router.js` — the router described above.
3. `paper-backend.js` — one reusable paper ledger, instantiated twice
   (`NAUTILUS_NATIVE`, `HUMMINGBOT`) to stand in for "one Nautilus-native
   paper route" and "one Hummingbot paper route" until the real backends
   exist.
4. `reconciliation.js` — the reconciliation comparison.

Not yet implemented (needs the separate Python service): the actual
NautilusTrader `Strategy`/`Portfolio` wrapper, the real `HummingbotExecutionClient`
bridge (submit/amend/cancel/fill/partial-fill/rejection/reduce-only/leverage
translation), a live Market Edge -> Nautilus signal transport, and the
side-by-side latency/fee/slippage comparison run (needs two real backends to
compare, not two identical paper ledgers).

## STATE CONSISTENCY TESTS (`execution-architecture.test.js`)

Covers, against the paper scaffold: one signal -> one order (duplicate
`signal_id` rejected), risk rejection blocks submission entirely, leverage
above the approved ceiling is rejected before routing, `venue_preference`
correctly routes to a non-default backend, reconciliation flags an orphan
order, an unknown position, and a quantity mismatch, and a partial-size fill
still reconciles once the backend position reflects it. Restart-recovery and
real orphan-order detection against a live exchange are not testable until
the real backend exists; the reconciliation function itself is written to
support them unchanged (it only reads two position lists).

## PRODUCTION IMPACT

NONE. This is a new, isolated directory under `research/`; it imports
nothing from and is imported by nothing in `quant-engine.js`,
`replay-engine.js`, `backend/`, or `customer-beta/`.
