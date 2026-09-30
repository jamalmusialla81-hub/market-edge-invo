"""TASK L: the drawdown recovery state machine (shadow only): no single-step recovery, every transition audited, manual override logged."""
import inspect
import json

import pytest

from market_edge_exec.control.settings import ControlStore
from market_edge_exec.risk import drawdown_recovery as R
from market_edge_exec.risk import sizing_v2 as S

T0 = 1_800_000_000_000
H = 3_600_000
POLICY = R.DEFAULT_RECOVERY


@pytest.fixture
def machine(tmp_path):
    store = ControlStore(str(tmp_path / "c.sqlite3"))
    return R.RecoveryMachine(store), store


def transitions(store):
    return [r for r in reversed(store.audit_log(500)) if r["action"].startswith("DD_RECOVERY")]


def take_trades(m, n, episodes, start_id=0, opened_from=None):
    st = m.state()
    for i in range(n):
        m.record_trade(f"t{start_id + i}", (opened_from or st["entered_at_ms"]) + 1 + i, f"ep{i % episodes}", True)
    return m.state()


def to_recovery_1(m, t=T0):
    m.observe(0.16, t)
    assert m.observe(0.10, t + H)["state"] == R.DIAGNOSTIC_REVIEW
    return m.acknowledge_review("jakob", "reviewed the losing streak", t + 2 * H)


# ---- existing throttle tiers are read, not redefined -----------------------------------------------------------------
@pytest.mark.parametrize("dd,tier", [(0.0, R.NORMAL), (0.049, R.NORMAL), (0.05, R.REDUCED), (0.099, R.REDUCED), (0.10, R.SEVERELY_REDUCED),
                                     (0.149, R.SEVERELY_REDUCED), (0.15, R.PAUSED), (0.4, R.PAUSED)])
def test_live_tiers_match_the_existing_throttle_boundaries(dd, tier):
    assert R.live_tier(dd) == tier
    mult = S.drawdown_multiplier(dd, S.DEFAULT_POLICY)
    assert (mult is None) == (tier == R.PAUSED)
    assert {R.NORMAL: 1.0, R.REDUCED: 0.75, R.SEVERELY_REDUCED: 0.5}.get(tier) == mult


def test_ordinary_tier_changes_follow_the_throttle_and_are_logged(machine):
    m, store = machine
    assert m.observe(0.02, T0)["state"] == R.NORMAL
    assert m.observe(0.06, T0 + H)["state"] == R.REDUCED
    assert m.observe(0.12, T0 + 2 * H)["state"] == R.SEVERELY_REDUCED
    assert m.observe(0.03, T0 + 3 * H)["state"] == R.NORMAL
    assert [(t["payload"]["from"], t["payload"]["to"]) for t in transitions(store)] == [
        (R.NORMAL, R.REDUCED), (R.REDUCED, R.SEVERELY_REDUCED), (R.SEVERELY_REDUCED, R.NORMAL)]


# ---- the structural guarantee ----------------------------------------------------------------------------------------
def test_recovering_from_a_severe_drawdown_cannot_reach_normal_in_a_single_step(machine):
    m, _ = machine
    assert m.observe(0.20, T0)["state"] == R.PAUSED
    # equity snaps all the way back: drawdown 0
    assert m.observe(0.0, T0 + H)["state"] == R.DIAGNOSTIC_REVIEW
    for i in range(50):                                            # however many times it is observed, and whatever the drawdown
        assert m.observe(0.0, T0 + (2 + i) * H)["state"] == R.DIAGNOSTIC_REVIEW
    assert m.state()["state"] != R.NORMAL


def test_every_automatic_step_is_along_the_ladder_one_at_a_time(machine):
    m, store = machine
    to_recovery_1(m)
    seen = [m.state()["state"]]
    for k in range(3):
        take_trades(m, POLICY.min_clean_trades, POLICY.min_distinct_episodes, start_id=100 * k)
        # even a huge number of extra observations moves at most one tier
        after = m.observe(0.0, T0 + (10 + k) * H)["state"]
        seen.append(after)
        assert m.observe(0.0, T0 + (10 + k) * H + 1)["state"] == after     # no evidence at the new tier yet: it holds
    assert seen == [R.RECOVERY[0], R.RECOVERY[1], R.RECOVERY[2], R.NORMAL]
    ladder = [(t["payload"]["from"], t["payload"]["to"]) for t in transitions(store) if t["action"] == "DD_RECOVERY_TRANSITION"]
    assert ladder == [(R.NORMAL, R.PAUSED), (R.PAUSED, R.DIAGNOSTIC_REVIEW), (R.RECOVERY[0], R.RECOVERY[1]), (R.RECOVERY[1], R.RECOVERY[2]), (R.RECOVERY[2], R.NORMAL)]


def test_no_code_path_leaves_paused_or_review_except_via_review_and_human_ack():
    src = inspect.getsource(R.RecoveryMachine)
    # the only place DIAGNOSTIC_REVIEW is left is acknowledge_review (and the always-available override / pause-level rule)
    assert src.count("RECOVERY[0], now_ms, \"DD_RECOVERY_MANUAL_ACK\"") == 1


def test_advancement_needs_forward_evidence_not_time_or_equity(machine, tmp_path):
    m, _ = machine
    to_recovery_1(m)
    for hours in (1, 24, 24 * 30, 24 * 365):
        assert m.observe(0.0, T0 + hours * H)["state"] == "RECOVERY_1"          # time alone never advances
    take_trades(m, POLICY.min_clean_trades - 1, POLICY.min_distinct_episodes)
    assert m.observe(0.0, T0 + 999 * H)["state"] == "RECOVERY_1"               # one clean trade short
    # plenty of trades, but all from one episode, is not enough independent evidence
    other = R.RecoveryMachine(ControlStore(str(tmp_path / "other.sqlite3")))
    to_recovery_1(other)
    take_trades(other, 40, 1)
    assert other.observe(0.0, T0 + 999 * H)["state"] == "RECOVERY_1"
    take_trades(other, 40, POLICY.min_distinct_episodes, start_id=1000)
    assert other.observe(0.0, T0 + 1000 * H)["state"] == "RECOVERY_2"


def test_trades_opened_before_the_tier_or_not_clean_or_repeated_do_not_count(machine):
    m, _ = machine
    st = to_recovery_1(m)
    entered = st["entered_at_ms"]
    m.record_trade("old", entered - 1, "e1", True)
    m.record_trade("dirty", entered + 5, "e2", False)
    m.record_trade("good", entered + 6, "e3", True)
    m.record_trade("good", entered + 6, "e3", True)                             # duplicate delivery
    assert [t["trade_id"] for t in m.state()["clean_trades"]] == ["good"]


def test_returning_to_the_pause_level_always_resets_to_paused(machine):
    m, _ = machine
    to_recovery_1(m)
    take_trades(m, 20, 10)
    assert m.observe(0.0, T0 + 20 * H)["state"] == "RECOVERY_2"
    assert m.observe(0.155, T0 + 21 * H)["state"] == R.PAUSED
    assert m.state()["clean_trades"] == []


def test_recovery_tier_exits_to_the_live_tier_not_to_normal_when_drawdown_is_still_high(machine):
    m, _ = machine
    to_recovery_1(m)
    for k in range(3):
        take_trades(m, 10, 5, start_id=100 * k)
        m.observe(0.12, T0 + (10 + k) * H)
    assert m.state()["state"] == R.SEVERELY_REDUCED                            # 12% drawdown: the existing 0.50 tier


# ---- audit ----------------------------------------------------------------------------------------------------------
def test_every_transition_is_audit_logged_with_from_to_and_reason(machine):
    m, store = machine
    m.observe(0.2, T0)
    m.observe(0.1, T0 + H)
    m.acknowledge_review("jakob", "checked", T0 + 2 * H)
    log = transitions(store)
    assert [l["action"] for l in log] == ["DD_RECOVERY_TRANSITION", "DD_RECOVERY_TRANSITION", "DD_RECOVERY_MANUAL_ACK"]
    assert log[0]["payload"] == {"from": "NORMAL", "to": "PAUSED", "version": R.RECOVERY_VERSION, "reason": "DRAWDOWN_AT_OR_ABOVE_PAUSE_LEVEL", "drawdown": 0.2}
    assert log[1]["payload"]["reason"] == "DRAWDOWN_BACK_UNDER_PAUSE_LEVEL"
    assert log[2]["payload"]["operator"] == "jakob" and log[2]["payload"]["note"] == "checked"
    assert m.state()["state"] == "RECOVERY_1"


def test_state_and_audit_row_are_one_transaction_so_a_change_cannot_be_silent(machine, monkeypatch):
    m, store = machine
    m.observe(0.2, T0)
    calls = []
    real = store.put_json_audited
    monkeypatch.setattr(store, "put_json_audited", lambda *a, **k: (calls.append(a), real(*a, **k))[1])
    m.observe(0.05, T0 + H)
    assert len(calls) == 1 and calls[0][2] == "DD_RECOVERY_TRANSITION"
    # a failing write leaves neither the state nor the audit row behind
    before_state, before_log = store.get_json(R.STATE_KEY), len(store.audit_log(500))
    import sqlite3
    monkeypatch.setattr(store, "_set", lambda *a, **k: (_ for _ in ()).throw(sqlite3.OperationalError("boom")))
    with pytest.raises(sqlite3.OperationalError):
        store.put_json_audited(R.STATE_KEY, {"state": "NORMAL"}, "X", {})
    assert store.get_json(R.STATE_KEY) == before_state and len(store.audit_log(500)) == before_log


def test_trade_evidence_is_audited_so_an_advance_is_reconstructable(machine):
    m, store = machine
    st = to_recovery_1(m)
    m.record_trade("a", st["entered_at_ms"] + 1, "e1", True)
    m.record_trade("b", st["entered_at_ms"] + 2, "e2", False)
    log = [l for l in transitions(store) if l["action"] == "DD_RECOVERY_TRADE"]
    assert [(l["payload"]["trade_id"], l["payload"]["clean"], l["payload"]["counted"]) for l in log] == [("a", True, True), ("b", False, False)]


# ---- manual controls --------------------------------------------------------------------------------------------------
def test_manual_override_works_from_any_state_and_is_itself_logged(machine):
    m, store = machine
    m.observe(0.2, T0)
    st = m.override(R.NORMAL, "jakob", "clean restart after infrastructure incident, not a strategy loss", T0 + H)
    assert st["state"] == R.NORMAL
    st = m.override(R.PAUSED, "jakob", "pausing for the weekend", T0 + 2 * H)
    assert st["state"] == R.PAUSED
    log = [l for l in transitions(store) if l["action"] == "DD_RECOVERY_MANUAL_OVERRIDE"]
    assert [(l["payload"]["from"], l["payload"]["to"], l["payload"]["operator"]) for l in log] == [("PAUSED", "NORMAL", "jakob"), ("NORMAL", "PAUSED", "jakob")]
    assert "infrastructure incident" in log[0]["payload"]["reason"]


@pytest.mark.parametrize("operator,note", [("", "reason"), ("jakob", ""), ("  ", "x"), (None, "x")])
def test_manual_transitions_must_name_who_and_why(machine, operator, note):
    m, store = machine
    m.observe(0.2, T0)
    with pytest.raises(ValueError, match="OPERATOR_AND_NOTE_REQUIRED"):
        m.override(R.NORMAL, operator, note)
    m.observe(0.1, T0 + H)
    with pytest.raises(ValueError, match="OPERATOR_AND_NOTE_REQUIRED"):
        m.acknowledge_review(operator, note)
    assert m.state()["state"] == R.DIAGNOSTIC_REVIEW


def test_acknowledge_only_works_in_review_and_goes_to_recovery_1(machine):
    m, _ = machine
    with pytest.raises(ValueError, match="NOT_IN_REVIEW"):
        m.acknowledge_review("jakob", "x")
    with pytest.raises(ValueError, match="UNKNOWN_STATE"):
        m.override("FULL_SEND", "jakob", "x")
    assert to_recovery_1(m)["state"] == "RECOVERY_1"


# ---- shadow-only ------------------------------------------------------------------------------------------------------
def test_would_be_reports_a_comparison_and_is_never_authoritative(machine):
    m, _ = machine
    to_recovery_1(m)
    w = m.would_be(0.08)
    assert w["state"] == "RECOVERY_1" and w["entries_allowed"] and w["risk_pct_cap"] == 0.0010 and w["authoritative"] is False
    assert w["live_multiplier"] == 0.75                                        # what the live throttle does at 8%, unchanged
    m.observe(0.2, T0 + 5 * H)
    assert m.would_be(0.2) == {"state": "PAUSED", "entries_allowed": False, "risk_pct_cap": 0.0, "live_multiplier": None, "authoritative": False}


def test_the_existing_throttle_and_sizing_are_untouched():
    p = S.DEFAULT_POLICY
    assert p.dd_steps == ((0.05, 1.00), (0.10, 0.75), (0.15, 0.50)) and p.dd_pause_pct == 0.15
    assert S.drawdown_multiplier(0.149, p) == 0.5 and S.drawdown_multiplier(0.15, p) is None
    src = inspect.getsource(S)
    assert "drawdown_recovery" not in src                                       # sizing does not import or call the machine


def test_the_policy_is_versioned_and_labelled_unvalidated():
    assert R.RECOVERY_VERSION.endswith("UNVALIDATED") and POLICY.version == R.RECOVERY_VERSION
    assert "not research results" in R.__doc__


def test_bad_drawdown_input_is_refused(machine):
    m, _ = machine
    for bad in (-0.1, 1.0, float("nan")):
        with pytest.raises(ValueError):
            m.observe(bad, T0)
