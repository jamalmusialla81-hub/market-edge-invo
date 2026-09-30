"""TASK L (#90): drawdown recovery state machine, SHADOW ONLY.

Today a drawdown that climbs back under the pause level resumes at the 0.50 tier immediately (`sizing_v2.drawdown_multiplier`, recomputed
live). This module models the controlled restart the roadmap asks for:

    NORMAL / REDUCED / SEVERELY_REDUCED  (the existing <5% / 5-10% / 10-15% tiers, read from the SizingPolicy, not redefined)
    -> PAUSED (>= the pause level)
    -> DIAGNOSTIC_REVIEW (drawdown back under the pause level; entries stay blocked until a human acknowledges)
    -> RECOVERY_1 -> RECOVERY_2 -> RECOVERY_3 -> the live tier

It is NOT authoritative. Nothing here changes `drawdown_multiplier`, sizing or any entry decision, and no production path calls it yet. It exists so the
lifecycle can be tested, audited and (later, by the owner's decision) enforced. The tier risk caps and the advancement rule are versioned
`DD-RECOVERY-V1-UNVALIDATED` engineering defaults, not research results: the roadmap says not to adopt thresholds without validation, and no forward
data exists yet to validate them. Advancement is by forward evidence (clean trades in distinct episodes taken AT the tier), never by elapsed time
or an equity number alone.

Structural guarantees (tested):
  * the only way out of PAUSED is DIAGNOSTIC_REVIEW; the only way out of DIAGNOSTIC_REVIEW is a logged human acknowledgement
  * recovery advances exactly one tier per call and only along RECOVERY_1 -> 2 -> 3 -> live tier: NORMAL cannot be reached from PAUSED in one step
  * any return of the drawdown to the pause level sends the machine back to PAUSED, whatever tier it was in
  * every transition, including manual ones, is written with its audit row in one transaction (control_audit); there is no silent state change
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from market_edge_exec.risk.sizing_v2 import DEFAULT_POLICY, SizingPolicy, drawdown_multiplier

RECOVERY_VERSION = "DD-RECOVERY-V1-UNVALIDATED"
STATE_KEY = "drawdown_recovery"
NORMAL, REDUCED, SEVERELY_REDUCED = "NORMAL", "REDUCED", "SEVERELY_REDUCED"
PAUSED, DIAGNOSTIC_REVIEW = "PAUSED", "DIAGNOSTIC_REVIEW"
RECOVERY = ("RECOVERY_1", "RECOVERY_2", "RECOVERY_3")
LIVE_TIERS = (NORMAL, REDUCED, SEVERELY_REDUCED)
ALL_STATES = LIVE_TIERS + (PAUSED, DIAGNOSTIC_REVIEW) + RECOVERY


@dataclass(frozen=True)
class RecoveryPolicy:
    """Unvalidated engineering defaults (illustrative, per the issue): risk per trade allowed at each recovery tier, and the forward evidence
    needed to advance from one."""
    version: str = RECOVERY_VERSION
    tier_risk_pct: tuple = (0.0010, 0.0020, 0.0030)   # 0.10% / 0.20% / 0.30% of equity per trade at RECOVERY_1/2/3
    min_clean_trades: int = 10
    min_distinct_episodes: int = 5


DEFAULT_RECOVERY = RecoveryPolicy()


def live_tier(dd: float, policy: SizingPolicy = DEFAULT_POLICY) -> str:
    """The existing throttle's tier for this drawdown, read from the SizingPolicy (same boundaries as `drawdown_multiplier`)."""
    if dd >= policy.dd_pause_pct:
        return PAUSED
    for i, (below, _) in enumerate(policy.dd_steps):
        if dd < below:
            return (NORMAL, REDUCED, SEVERELY_REDUCED)[min(i, 2)]
    return PAUSED


def initial_state(now_ms: int) -> dict:
    return {"version": RECOVERY_VERSION, "state": NORMAL, "entered_at_ms": now_ms, "clean_trades": [], "seen_trades": [], "last_drawdown": None}


def _evidence_ok(state: dict, policy: RecoveryPolicy) -> bool:
    trades = state["clean_trades"]
    return len(trades) >= policy.min_clean_trades and len({t["episode"] for t in trades}) >= policy.min_distinct_episodes


class RecoveryMachine:
    """Persists in the control store (state row + control_audit, atomically). Pure decisions live in `_decide`."""

    def __init__(self, store, sizing: SizingPolicy = DEFAULT_POLICY, policy: RecoveryPolicy = DEFAULT_RECOVERY):
        self.store, self.sizing, self.policy = store, sizing, policy

    # ---- state ---------------------------------------------------------------------------------------------------
    def state(self, now_ms: Optional[int] = None) -> dict:
        return self.store.get_json(STATE_KEY) or initial_state(now_ms or int(time.time() * 1000))

    def _commit(self, old: dict, new: dict, action: str, detail: dict) -> None:
        self.store.put_json_audited(STATE_KEY, new, action, {"from": old["state"], "to": new["state"], "version": RECOVERY_VERSION, **detail})

    def _move(self, old: dict, to: str, now_ms: int, action: str, detail: dict) -> dict:
        new = {**old, "state": to, "entered_at_ms": now_ms, "clean_trades": [], "seen_trades": old["seen_trades"]}
        self._commit(old, new, action, detail)
        return new

    # ---- observations ----------------------------------------------------------------------------------------------
    def observe(self, drawdown: float, now_ms: Optional[int] = None) -> dict:
        """Feed the current drawdown (fraction of peak equity). Moves at most one step and logs it. Returns the resulting state."""
        now_ms = now_ms or int(time.time() * 1000)
        old = self.state(now_ms)
        if not 0.0 <= drawdown < 1.0 or drawdown != drawdown:
            raise ValueError("drawdown must be a fraction in [0, 1)")
        cur, tier = old["state"], live_tier(drawdown, self.sizing)
        old = {**old, "last_drawdown": drawdown}
        if tier == PAUSED and cur != PAUSED:                                      # the pause level always wins, from any state
            return self._move(old, PAUSED, now_ms, "DD_RECOVERY_TRANSITION", {"reason": "DRAWDOWN_AT_OR_ABOVE_PAUSE_LEVEL", "drawdown": drawdown})
        if cur == PAUSED and tier != PAUSED:                                      # cannot resume: a human must review first
            return self._move(old, DIAGNOSTIC_REVIEW, now_ms, "DD_RECOVERY_TRANSITION", {"reason": "DRAWDOWN_BACK_UNDER_PAUSE_LEVEL", "drawdown": drawdown})
        if cur in LIVE_TIERS and cur != tier:                                     # ordinary tier changes track the existing throttle
            return self._move(old, tier, now_ms, "DD_RECOVERY_TRANSITION", {"reason": "LIVE_TIER_CHANGE", "drawdown": drawdown})
        if cur in RECOVERY:
            return self._advance(old, drawdown, now_ms)
        return old

    def _advance(self, old: dict, drawdown: float, now_ms: int) -> dict:
        i = RECOVERY.index(old["state"])
        if not _evidence_ok(old, self.policy):
            return old
        to = RECOVERY[i + 1] if i + 1 < len(RECOVERY) else live_tier(drawdown, self.sizing)
        return self._move(old, to, now_ms, "DD_RECOVERY_TRANSITION",
                          {"reason": "FORWARD_EVIDENCE_MET", "clean_trades": len(old["clean_trades"]),
                           "distinct_episodes": len({t["episode"] for t in old["clean_trades"]}), "drawdown": drawdown})

    def record_trade(self, trade_id: str, opened_at_ms: int, episode_id: str, clean: bool, now_ms: Optional[int] = None) -> dict:
        """A closed trade. Counts toward advancement only if it was opened while in the current recovery tier, was clean, and is new.
        Persisted with an audit row so the evidence behind an advance is reconstructable."""
        now_ms = now_ms or int(time.time() * 1000)
        old = self.state(now_ms)
        if trade_id in old["seen_trades"] or old["state"] not in RECOVERY:
            return old
        new = {**old, "seen_trades": old["seen_trades"] + [trade_id]}
        counted = bool(clean) and opened_at_ms >= old["entered_at_ms"]
        if counted:
            new["clean_trades"] = old["clean_trades"] + [{"trade_id": trade_id, "episode": str(episode_id), "opened_at_ms": opened_at_ms}]
        self._commit(old, new, "DD_RECOVERY_TRADE", {"trade_id": trade_id, "episode": str(episode_id), "clean": bool(clean), "counted": counted})
        return new

    # ---- manual controls (always available, always logged) ---------------------------------------------------------------
    def acknowledge_review(self, operator: str, note: str, now_ms: Optional[int] = None) -> dict:
        """The only way out of DIAGNOSTIC_REVIEW: a named human confirms the review. Moves to RECOVERY_1, never further."""
        now_ms = now_ms or int(time.time() * 1000)
        _require_human(operator, note)
        old = self.state(now_ms)
        if old["state"] != DIAGNOSTIC_REVIEW:
            raise ValueError(f"NOT_IN_REVIEW: state is {old['state']}")
        return self._move(old, RECOVERY[0], now_ms, "DD_RECOVERY_MANUAL_ACK", {"operator": operator, "note": note})

    def override(self, target: str, operator: str, reason: str, now_ms: Optional[int] = None) -> dict:
        """Manual override to any state. The human is the authority here, so it is unrestricted and never silent."""
        now_ms = now_ms or int(time.time() * 1000)
        _require_human(operator, reason)
        if target not in ALL_STATES:
            raise ValueError(f"UNKNOWN_STATE: {target}")
        return self._move(self.state(now_ms), target, now_ms, "DD_RECOVERY_MANUAL_OVERRIDE", {"operator": operator, "reason": reason})

    # ---- read-side, for a shadow comparison only ------------------------------------------------------------------------
    def would_be(self, drawdown: float) -> dict:
        """What the machine would allow, beside what the live throttle allows. Informational; nothing enforces it."""
        st = self.state()["state"]
        live = drawdown_multiplier(drawdown, self.sizing)
        if st in (PAUSED, DIAGNOSTIC_REVIEW):
            return {"state": st, "entries_allowed": False, "risk_pct_cap": 0.0, "live_multiplier": live, "authoritative": False}
        if st in RECOVERY:
            return {"state": st, "entries_allowed": True, "risk_pct_cap": self.policy.tier_risk_pct[RECOVERY.index(st)], "live_multiplier": live, "authoritative": False}
        return {"state": st, "entries_allowed": live is not None, "risk_pct_cap": None, "live_multiplier": live, "authoritative": False}


def _require_human(operator: str, note: str) -> None:
    if not str(operator or "").strip() or not str(note or "").strip():
        raise ValueError("OPERATOR_AND_NOTE_REQUIRED: a manual transition must name who did it and why")
