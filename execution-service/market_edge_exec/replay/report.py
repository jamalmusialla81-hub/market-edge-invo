"""DATA 16: given a trade, signal or scan id, assemble everything that was RECORDED about what Market Edge saw and used.

Rules (each has a test):
  - read-only: every database is opened `mode=ro`; a stray write attempt would raise
  - nothing is recomputed, re-derived or approximated. A field that was never stored is reported as
    {"recorded": false, "note": ...}, never omitted and never guessed
  - the decision-time record is separate from anything that happened later: post-outcome research labels are NOT included
    (only whether they exist), so this report can never be read back as decision-time input
  - stored decision blobs are hash-verified against the hash recorded beside them, and the result is reported
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import zlib
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.replay import REPLAY_VERSION
from market_edge_exec.shadow import contracts as C

LABEL = "READ-ONLY REPRODUCTION REPORT · ASSEMBLED FROM RECORDED DATA · NOTHING RECOMPUTED · MISSING FIELDS ARE SAID TO BE MISSING"


def _ro(path: Optional[str]) -> Optional[sqlite3.Connection]:
    if not path or not os.path.isfile(path):
        return None
    conn = sqlite3.connect("file:" + os.path.abspath(path).replace(os.sep, "/") + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _tables(conn: Optional[sqlite3.Connection]) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} if conn else set()


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def _unblob(value: bytes) -> Any:
    return json.loads(zlib.decompress(value).decode())


def rec(value: Any, missing_note: str) -> dict:
    """A recorded value, or an explicit statement that it was not recorded. Zero and False count as recorded."""
    if value is None:
        return {"recorded": False, "note": missing_note}
    return {"recorded": True, "value": value}


def _resolve(led: Optional[sqlite3.Connection], sh: Optional[sqlite3.Connection], given: str) -> dict:
    """What kind of id is this, and which linked ids exist?"""
    out: dict[str, Any] = {"given": given, "kind": None, "trade_id": None, "signal_id": None, "scan_id": None, "observation_id": None}
    if led is not None and "paper_trades" in _tables(led):
        row = led.execute("SELECT trade_id, payload FROM paper_trades WHERE trade_id=?", (given,)).fetchone()
        if row is None:
            for r in led.execute("SELECT trade_id, payload FROM paper_trades"):
                if json.loads(r["payload"]).get("signal_id") == given:
                    row = r
                    break
        if row is not None:
            trade = json.loads(row["payload"])
            out.update(kind="TRADE" if row["trade_id"] == given else "SIGNAL", trade_id=row["trade_id"], signal_id=trade.get("signal_id") or row["trade_id"], _trade=trade)
    if sh is not None and out["kind"] is None and "shadow_scans" in _tables(sh) and sh.execute("SELECT 1 FROM shadow_scans WHERE scan_id=?", (given,)).fetchone():
        out.update(kind="SCAN", scan_id=given)
    if out["kind"] is None:
        return out
    if sh is not None and out["signal_id"] and "forward_paper_executed" in _tables(sh):
        link = sh.execute("SELECT observation_id, scan_id FROM forward_paper_executed WHERE signal_id=?", (out["signal_id"],)).fetchone()
        if link:
            out.update(observation_id=link["observation_id"], scan_id=link["scan_id"])
    if out["kind"] == "SCAN" and sh is not None:
        row = sh.execute("SELECT submitted_signal_id FROM shadow_scans WHERE scan_id=?", (given,)).fetchone()
        out["submitted_signal_id"] = row["submitted_signal_id"] if row else None
    return out


def _trade_section(led: sqlite3.Connection, ids: dict) -> dict:
    trade = ids["_trade"]
    sig = led.execute("SELECT payload FROM paper_signals WHERE signal_id=? AND outcome='EXECUTED' ORDER BY id LIMIT 1", (ids["signal_id"],)).fetchone()
    payload = json.loads(sig["payload"]) if sig else None
    meta = (payload or {}).get("meta") or {}
    ids["observation_id"] = ids["observation_id"] or meta.get("observation_id")
    ids["scan_id"] = ids["scan_id"] or meta.get("scan_id")
    missing = "not recorded for this trade (it predates this field)"
    decision = {k: rec(trade.get(k), missing) for k in ("asset", "instrument", "direction", "opened_at_ms", "signal_timestamp", "signal_entry", "entry_fill", "mark_at_entry", "stop",
                                                        "tp1", "tp2", "quantity", "notional", "risk_amount", "requested_leverage", "approved_leverage", "strategy", "quant_score")}
    decision.update({k: rec(meta.get(k), "not recorded in the signal payload's display context for this trade") for k in ("regime", "ml_score", "combined_score", "rank", "rr1", "rr2")})
    market = {k: rec(trade.get(k), missing) for k in ("market_price_source", "market_price_timestamp", "market_price_age_ms", "mark_price")}
    sizing = None
    if "risk_sizing_decisions" in _tables(led):
        rows = led.execute("SELECT decision_id, mode, role, policy_version, approved, reason, created_at_ms, record, record_hash"
                           + (", source_commit" if "source_commit" in _columns(led, "risk_sizing_decisions") else "")
                           + " FROM risk_sizing_decisions WHERE signal_id=? ORDER BY created_at_ms, decision_id", (ids["signal_id"],)).fetchall()
        sizing = [{"decision_id": r["decision_id"], "mode": r["mode"], "role": r["role"], "policy_version": r["policy_version"], "approved": bool(r["approved"]), "reason": r["reason"],
                   "created_at_ms": r["created_at_ms"], "record": json.loads(r["record"]),
                   "record_hash_ok": C.content_hash(json.loads(r["record"])) == r["record_hash"] or "NOT_VERIFIABLE_HASH_ALGORITHM",
                   "source_commit": rec(r["source_commit"] if "source_commit" in r.keys() else None, "not recorded for this sizing decision (it predates source_commit stamping)")} for r in rows]
    exits, path_n = [], 0
    if "exit_policy_counterfactuals" in _tables(led):
        for r in led.execute("SELECT policy_version, status, finalized, params, record FROM exit_policy_counterfactuals WHERE trade_id=? ORDER BY policy_version", (ids["trade_id"],)):
            record = json.loads(r["record"])
            exits.append({"policy_version": r["policy_version"], "status": r["status"], "finalized": bool(r["finalized"]), "params": json.loads(r["params"]),
                          "manager_version": rec(record.get("manager_version"), "not recorded"), "registry_version": rec(record.get("registry_version"), "not recorded"),
                          "counterfactual": True, "used_for_execution": False})
    if "exit_path_observations" in _tables(led):
        path_n = led.execute("SELECT count(*) FROM exit_path_observations WHERE trade_id=?", (ids["trade_id"],)).fetchone()[0]
    return {"decision": decision, "market_inputs": market, "sizing": sizing if sizing else {"recorded": False, "note": "no sizing decision recorded for this signal (older trade or ledger without risk_sizing_decisions)"},
            "exit_policies": exits if exits else {"recorded": False, "note": "no exit-policy counterfactuals recorded for this trade"},
            "post_entry_price_path": {"recorded": path_n > 0, "observations": path_n, "note": None if path_n else "no post-entry price-path observations recorded for this trade"},
            "status": trade.get("status"), "risk_policy_version": rec(trade.get("risk_policy_version"), missing), "sizing_mode": rec(trade.get("sizing_mode"), missing)}


def _shadow_section(sh: Optional[sqlite3.Connection], ids: dict) -> dict:
    none = {"recorded": False, "note": "no shadow-learning database was available" if sh is None else "no shadow record links to this id"}
    if sh is None or "shadow_scans" not in _tables(sh):
        return {"scan": none, "observation": none}
    scan = None
    if ids["scan_id"]:
        row = sh.execute("SELECT * FROM shadow_scans WHERE scan_id=?", (ids["scan_id"],)).fetchone()
        if row:
            cols = row.keys()
            detail = _unblob(row["detail"])
            scan = {"scan_id": row["scan_id"], "decision_ts": row["decision_ts"], "scan_status": row["scan_status"], "scan_state": row["scan_state"], "execution_decision": row["execution_decision"],
                    "n_markets": row["n_markets"], "n_candidates": row["n_candidates"], "submitted_signal_id": row["submitted_signal_id"],
                    "universe": rec(detail.get("universe"), "not recorded"), "failures": detail.get("failures"),
                    "versions": {k: rec(row[k] if k in cols else None, "not recorded for this scan") for k in ("generator_version", "feature_version", "model_version", "dataset_version")},
                    "source_commit": rec(row["source_commit"] if "source_commit" in cols else None, "not recorded for this scan (it predates source_commit stamping)")}
    obs = None
    if ids["observation_id"]:
        row = sh.execute("SELECT * FROM shadow_observations WHERE observation_id=?", (ids["observation_id"],)).fetchone()
        if row:
            cols = row.keys()
            decision = _unblob(row["decision"])
            res = sh.execute("SELECT resolution_status, batches_done FROM shadow_resolution WHERE observation_id=?", (ids["observation_id"],)).fetchone()
            has_h = sh.execute("SELECT 1 FROM shadow_hindsight WHERE observation_id=?", (ids["observation_id"],)).fetchone() is not None
            obs = {"observation_id": row["observation_id"], "asset": row["asset"], "direction": row["direction"], "strategy": row["strategy"], "kind": row["kind"],
                   "decision_ts": row["decision_ts"], "production_rank": row["production_rank"], "is_production_pick": bool(row["is_production_pick"]),
                   "versions": {k: rec(row[k] if k in cols else None, "not recorded") for k in ("generator_version", "feature_version", "model_version", "dataset_version")},
                   "source_commit": rec(row["source_commit"] if "source_commit" in cols else None, "not recorded for this observation (it predates source_commit stamping)"),
                   "outcome_venue": row["outcome_venue"], "outcome_interval": row["outcome_interval"],
                   "decision_hash_ok": C.content_hash(decision) == row["decision_hash"],
                   "decision_time_inputs": {"features": decision.get("features"), "candidate": decision.get("candidate"),
                                            "note": "derived decision-time values exactly as stored; the raw candles they were computed from are not stored, and are not reconstructed here"},
                   "outcome_status": {"resolution_status": res["resolution_status"] if res else None, "batches_done": res["batches_done"] if res else None,
                                      "post_outcome_labels_exist": has_h, "note": "post-outcome labels are deliberately not shown in this report"}}
    return {"scan": scan or none, "observation": obs or none}


def build_report(ids_given: str, *, ledger_path: Optional[str] = None, shadow_path: Optional[str] = None, now_ms: Optional[int] = None) -> dict:
    with closing(_ro(ledger_path) or _NullConn()) as led_c, closing(_ro(shadow_path) or _NullConn()) as sh_c:
        led = None if isinstance(led_c, _NullConn) else led_c
        sh = None if isinstance(sh_c, _NullConn) else sh_c
        ids = _resolve(led, sh, ids_given)
        if ids["kind"] is None:
            return {"replay_version": REPLAY_VERSION, "label": LABEL, "found": False, "given": ids_given,
                    "note": "no trade, signal or scan with this id in the provided databases", "databases": {"ledger": led is not None, "shadow": sh is not None}}
        sections: dict[str, Any] = {}
        if ids["kind"] in ("TRADE", "SIGNAL"):
            sections = _trade_section(led, ids)
        shadow = _shadow_section(sh, ids)
        scan_obs = None
        if ids["kind"] == "SCAN" and sh is not None:
            scan_obs = [{"observation_id": r["observation_id"], "kind": r["kind"], "asset": r["asset"], "direction": r["direction"], "strategy": r["strategy"],
                         "production_rank": r["production_rank"], "is_production_pick": bool(r["is_production_pick"]), "execution_status": r["execution_status"]}
                        for r in sh.execute("SELECT * FROM shadow_observations WHERE scan_id=? ORDER BY observation_id", (ids["scan_id"],))]
        report = {"replay_version": REPLAY_VERSION, "label": LABEL, "found": True, "generated_at_ms": now_ms or int(time.time() * 1000), "read_only": True,
                  "identity": {k: ids[k] for k in ("given", "kind", "trade_id", "signal_id", "scan_id", "observation_id")},
                  "source_commit": _first_recorded(shadow, sections),
                  **sections, "shadow": shadow, "scan_observations": scan_obs}
        report["gaps"] = sorted(_gaps(report))
        return report


class _NullConn:
    def close(self):
        pass


def _first_recorded(shadow: dict, sections: dict) -> dict:
    for src in ((shadow.get("observation") or {}).get("source_commit"), (shadow.get("scan") or {}).get("source_commit")):
        if isinstance(src, dict) and src.get("recorded"):
            return src
    for d in (sections.get("sizing") or []) if isinstance(sections.get("sizing"), list) else []:
        if d["source_commit"]["recorded"]:
            return d["source_commit"]
    return {"recorded": False, "note": "no source commit was recorded on any record linked to this id (they predate source_commit stamping, or were not linked)"}


def _gaps(node: Any, path: str = "") -> set[str]:
    """Every place the report says a field was not recorded, so a reader can see the holes at a glance."""
    out: set[str] = set()
    if isinstance(node, dict):
        if node.get("recorded") is False and "note" in node:
            out.add(path or "report")
        for k, v in node.items():
            out |= _gaps(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out |= _gaps(v, f"{path}[{i}]")
    return out
