"""Adaptive Exit Manager V1 (MAJOR 3): RESEARCH / SHADOW ONLY.

Nothing in this package can change what a real paper trade does. It has
  * a pure Position State Engine (state.py),
  * candidate exit policies as pure functions (policies.py, 3A-3F),
  * a deterministic counterfactual replay engine (replay.py, 3G), and
  * a statistical evidence gate (evaluation.py, 3H).
Counterfactual results live in their own tables (store.py) and are never read
back into a trade record, an order, the router, the portfolio or Nautilus.
"""
EXIT_MANAGER_VERSION = "EXIT-MANAGER-V1"
