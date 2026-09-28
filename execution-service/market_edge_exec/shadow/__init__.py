"""Universal shadow learning (research only).

EXECUTION != OBSERVATION. Paper execution stays selective and risk
controlled; this package observes every candidate and market state the
scanner produced, whether or not paper execution accepted it, and later
labels what the market actually did.

Isolation guarantees (enforced by tests/test_shadow_isolation.py):
  - its own SQLite file, never the paper ledger's database;
  - no imports from routing, risk, paper.engine, paper.ledger, nautilus,
    hummingbot or persistence -- only the pure paper.lifecycle exit rules;
  - consumes no capital, changes no exposure, cannot place any order.
"""
