"""TASK M (#91): paper <-> shadow <-> execution linkage audit.

Walks every paper trade and reports, per required identifier and per linked record, whether the provenance chain
scan -> observation -> decision snapshot -> risk-sizing decision -> execution -> fills -> exit-policy counterfactuals
-> resolved shadow labels actually resolves. It only reads: both databases are opened with SQLite's read-only URI mode,
nothing is written and no link is ever guessed or fabricated.

Statuses, per link:
  LINKED           the record exists and points back at this trade
  PENDING          the record exists but its outcome is not due yet (shadow labels still resolving)
  LEGACY_UNLINKED  absent, and explainable by history: the trade opened before the earliest trade that has this link
                   (or no trade has it at all, so the source was not recording or is not wired yet)
  MISSING          absent although the source was already recording for an earlier trade: an unexplained gap
  NOT_CHECKED      the database that would hold it was not provided

The MISSING/LEGACY split is what keeps a real gap from being excused as history.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import zlib
from contextlib import closing
from typing import Any, Optional

AUDIT_VERSION = "LINKAGE-AUDIT-V1"

# The identifiers the roadmap lists, plus the linked records that carry them.
REQUIRED_IDS = ("trade_id", "signal_id", "scan_id", "observation_id", "decision_hash", "risk_decision_id", "exit_policy_version")
RECORD_LINKS = ("execution_decision", "fills", "resolved_labels")
CHECKS = REQUIRED_IDS + RECORD_LINKS
LINKED, PENDING, LEGACY, MISSING, NOT_CHECKED = "LINKED", "PENDING", "LEGACY_UNLINKED", "MISSING", "NOT_CHECKED"
STATUSES = (LINKED, PENDING, LEGACY, MISSING, NOT_CHECKED)
# For each check, the database that holds the record ("paper" or "shadow").
HOME = {"trade_id": "paper", "signal_id": "paper", "scan_id": "shadow", "observation_id": "shadow", "decision_hash": "shadow",
        "risk_decision_id": "paper", "exit_policy_version": "paper", "execution_decision": "paper", "fills": "paper",
        "resolved_labels": "shadow"}


def _connect_ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:" + os.path.abspath(path).replace(os.sep, "/") + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _link(status: str, reason: Optional[str] = None, value: Any = None) -> dict:
    return {"status": status, "reason": reason, "value": value}


def _trades(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for row in conn.execute("SELECT trade_id, instrument, status, opened_at_ms, payload FROM paper_trades ORDER BY opened_at_ms, trade_id"):
        try:
            payload = json.loads(row["payload"])
        except (TypeError, ValueError):
            payload = {}
        out.append({"trade_id": row["trade_id"], "instrument": row["instrument"], "status": row["status"], "opened_at_ms": row["opened_at_ms"],
                    "signal_id": payload.get("signal_id")})
    return out


def _paper_index(conn: sqlite3.Connection, trades: list[dict]) -> dict:
    """Every paper-side lookup, keyed by signal_id or trade_id, read once."""
    have = _tables(conn)
    def by(table: str, column: str, select: str) -> dict[str, list]:
        out: dict[str, list] = {}
        if table not in have:
            return out
        for row in conn.execute(f"SELECT {column} AS k, {select} FROM {table}"):
            out.setdefault(row["k"], []).append(dict(row))
        return out

    return {
        "tables": have,
        "signals": by("paper_signals", "signal_id", "outcome, at_ms"),
        "fills": by("fills", "signal_id", "fill_id"),
        "sizing": by("risk_sizing_decisions", "signal_id", "decision_id, role, mode, policy_version"),
        "exits": by("exit_policy_counterfactuals", "trade_id", "policy_version, finalized"),
    }


def _shadow_index(conn: sqlite3.Connection) -> dict:
    have = _tables(conn)

    def one(sql: str) -> dict:
        return {r["k"]: dict(r) for r in conn.execute(sql)} if have else {}

    return {
        "tables": have,
        "executed": one("SELECT signal_id AS k, observation_id, scan_id FROM forward_paper_executed") if "forward_paper_executed" in have else {},
        "observations": one("SELECT observation_id AS k, scan_id, decision_hash FROM shadow_observations") if "shadow_observations" in have else {},
        "scans": one("SELECT scan_id AS k, submitted_signal_id FROM shadow_scans") if "shadow_scans" in have else {},
        "resolution": one("SELECT observation_id AS k, resolution_status FROM shadow_resolution") if "shadow_resolution" in have else {},
        "labels": _labels(conn) if "shadow_labels" in have else {},
        "hindsight": {r[0] for r in conn.execute("SELECT observation_id FROM shadow_hindsight")} if "shadow_hindsight" in have else set(),
    }


def _labels(conn: sqlite3.Connection) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for row in conn.execute("SELECT observation_id, label_status FROM shadow_labels"):
        out.setdefault(row["observation_id"], []).append(row["label_status"])
    return out


def audit(paper_db: str, shadow_db: Optional[str] = None) -> dict:
    """Audit every trade in `paper_db`; `shadow_db` (optional) is the research database that should hold their observations."""
    with closing(_connect_ro(paper_db)) as pc:
        if "paper_trades" not in _tables(pc):
            raise ValueError("NOT_A_PAPER_DATABASE: no paper_trades table")
        trades = _trades(pc)
        paper = _paper_index(pc, trades)
    shadow = None
    if shadow_db:
        with closing(_connect_ro(shadow_db)) as sc:
            shadow = _shadow_index(sc)

    # Earliest trade that has each link: a gap before it is history, a gap after it is a real hole.
    first_linked: dict[str, Optional[int]] = {}

    def first(check: str, has) -> Optional[int]:
        times = [t["opened_at_ms"] for t in trades if has(t)]
        first_linked[check] = min(times) if times else None
        return first_linked[check]

    sig = lambda t: t["signal_id"]
    has_sizing = lambda t: bool(paper["sizing"].get(sig(t)))
    has_exit = lambda t: bool(paper["exits"].get(t["trade_id"]))
    has_signal = lambda t: bool(paper["signals"].get(sig(t)))
    has_fill = lambda t: bool(paper["fills"].get(sig(t)))
    has_executed = lambda t: bool(shadow and shadow["executed"].get(sig(t)))
    earliest = {"risk_decision_id": first("risk_decision_id", has_sizing), "exit_policy_version": first("exit_policy_version", has_exit),
                "execution_decision": first("execution_decision", has_signal), "fills": first("fills", has_fill)}
    shadow_first = first("observation_id", lambda t: has_executed(t) and bool(shadow["executed"][sig(t)].get("observation_id"))) if shadow else None

    def absent(check: str, trade: dict, what: str, since: Optional[int]) -> dict:
        if since is None:
            return _link(LEGACY, f"{what}: no trade in this database has it (the source was not recording, or is not wired yet)")
        if trade["opened_at_ms"] < since:
            return _link(LEGACY, f"{what}: trade opened before the earliest trade that has it")
        return _link(MISSING, f"{what}: absent although it was recorded for an earlier trade (unexplained gap)")

    results = []
    for t in trades:
        s = t["signal_id"]
        links: dict[str, dict] = {"trade_id": _link(LINKED, value=t["trade_id"])}
        links["signal_id"] = _link(LINKED, value=s) if s else _link(MISSING, "trade record carries no signal_id")
        # execution decision and fills, from the paper ledger
        sigs = paper["signals"].get(s) or []
        links["execution_decision"] = (_link(LINKED, value=sorted({r["outcome"] for r in sigs})) if sigs
                                       else (absent("execution_decision", t, "no paper_signals row", earliest["execution_decision"])
                                             if "paper_signals" in paper["tables"] else _link(LEGACY, "database has no paper_signals table")))
        fills = paper["fills"].get(s) or []
        links["fills"] = (_link(LINKED, value=[r["fill_id"] for r in fills]) if fills
                          else (absent("fills", t, "no fill rows", earliest["fills"]) if "fills" in paper["tables"] else _link(LEGACY, "database has no fills table")))
        # risk sizing: both roles are reported; the authoritative one is the id we require
        sizing = paper["sizing"].get(s) or []
        if sizing:
            by_role = {r["role"]: r["decision_id"] for r in sizing}
            links["risk_decision_id"] = (_link(LINKED, value=by_role) if "AUTHORITATIVE" in by_role
                                         else _link(MISSING, "risk-sizing decisions exist but none is AUTHORITATIVE", by_role))
        else:
            links["risk_decision_id"] = (absent("risk_decision_id", t, "no risk_sizing_decisions row", earliest["risk_decision_id"])
                                         if "risk_sizing_decisions" in paper["tables"] else _link(LEGACY, "database predates the risk_sizing_decisions table"))
        exits = paper["exits"].get(t["trade_id"]) or []
        links["exit_policy_version"] = (_link(LINKED, value=sorted(r["policy_version"] for r in exits)) if exits
                                        else (absent("exit_policy_version", t, "no exit_policy_counterfactuals rows", earliest["exit_policy_version"])
                                              if "exit_policy_counterfactuals" in paper["tables"] else _link(LEGACY, "database predates the exit_policy_counterfactuals table")))
        # shadow side
        if shadow is None:
            for check in ("scan_id", "observation_id", "decision_hash", "resolved_labels"):
                links[check] = _link(NOT_CHECKED, "no shadow database was provided")
        else:
            ex = shadow["executed"].get(s) if s else None
            if ex is None:
                reason = "no forward_paper_executed row for this signal"
                links["observation_id"] = absent("observation_id", t, reason, shadow_first)
                links["scan_id"] = _link(links["observation_id"]["status"], links["observation_id"]["reason"])
                links["decision_hash"] = _link(links["observation_id"]["status"], links["observation_id"]["reason"])
                links["resolved_labels"] = _link(links["observation_id"]["status"], links["observation_id"]["reason"])
            else:
                oid = ex.get("observation_id")
                scan_row = shadow["scans"].get(ex.get("scan_id"))
                if not ex.get("scan_id"):
                    links["scan_id"] = _link(MISSING, "forward_paper_executed row has no scan_id")
                elif scan_row is None:
                    links["scan_id"] = _link(MISSING, "scan_id is not in shadow_scans", ex["scan_id"])
                elif scan_row.get("submitted_signal_id") != s:
                    links["scan_id"] = _link(MISSING, "shadow_scans.submitted_signal_id does not match this signal", ex["scan_id"])
                else:
                    links["scan_id"] = _link(LINKED, value=ex["scan_id"])
                obs = shadow["observations"].get(oid) if oid else None
                if not oid:
                    links["observation_id"] = _link(MISSING, "forward_paper_executed row has no observation_id")
                elif obs is None:
                    links["observation_id"] = _link(MISSING, "observation_id is not in shadow_observations", oid)
                else:
                    links["observation_id"] = _link(LINKED, value=oid)
                links["decision_hash"] = (_link(LINKED, value=obs["decision_hash"]) if obs and obs.get("decision_hash")
                                          else _link(MISSING, "no decision_hash on the linked observation"))
                if obs is None:
                    links["resolved_labels"] = _link(MISSING, "no linked observation to resolve")
                else:
                    status = (shadow["resolution"].get(oid) or {}).get("resolution_status")
                    labels = shadow["labels"].get(oid) or []
                    if oid in shadow["hindsight"] or status in ("RESOLVED", "RESOLVED_WITH_GAPS"):
                        links["resolved_labels"] = _link(LINKED, value={"resolution_status": status, "label_rows": len(labels)})
                    elif status in ("PENDING", "PARTIAL"):
                        links["resolved_labels"] = _link(PENDING, f"shadow resolution is {status}; the 72h window is not complete", {"label_rows": len(labels)})
                    else:
                        links["resolved_labels"] = _link(MISSING, f"unexpected resolution status {status!r}")
        fully = all(v["status"] in (LINKED, PENDING) for v in links.values())
        results.append({"trade_id": t["trade_id"], "instrument": t["instrument"], "trade_status": t["status"], "opened_at_ms": t["opened_at_ms"],
                        "fully_linked": fully, "links": links})

    summary = {c: {s: sum(1 for r in results if r["links"][c]["status"] == s) for s in STATUSES} for c in CHECKS}
    orphans = []
    if shadow is not None:
        known = {t["signal_id"] for t in trades}
        orphans = sorted(k for k in shadow["executed"] if k not in known)
    return {
        "audit_version": AUDIT_VERSION, "trades": len(results), "fully_linked": sum(1 for r in results if r["fully_linked"]),
        "shadow_checked": shadow is not None, "summary": summary, "results": results,
        "shadow_executed_without_paper_trade": orphans,
        "gaps": [{"trade_id": r["trade_id"], "check": c, "status": v["status"], "reason": v["reason"]}
                 for r in results for c, v in r["links"].items() if v["status"] == MISSING],
    }


def render_markdown(report: dict, limit: int = 30) -> str:
    lines = [f"# Paper / shadow / execution linkage audit ({report['audit_version']})", "",
             "_READ ONLY · NEVER FABRICATES A LINK · CHANGES NO DATABASE_", "",
             f"Trades audited: **{report['trades']}**, fully linked: **{report['fully_linked']}**."
             + ("" if report["shadow_checked"] else " No shadow database was given, so scan, observation, decision-hash and label links were NOT_CHECKED."), "",
             "| link | " + " | ".join(STATUSES) + " |", "|---|" + "---|" * len(STATUSES)]
    for check in CHECKS:
        counts = report["summary"][check]
        lines.append(f"| {check} | " + " | ".join(str(counts[s]) for s in STATUSES) + " |")
    lines += ["", "LEGACY_UNLINKED is history (the source did not exist yet for that trade). MISSING is a gap the history does not explain."]
    if report["gaps"]:
        lines += ["", f"## Unexplained gaps ({len(report['gaps'])})"]
        lines += [f"- `{g['trade_id']}` {g['check']}: {g['reason']}" for g in report["gaps"][:limit]]
        if len(report["gaps"]) > limit:
            lines.append(f"- … {len(report['gaps']) - limit} more in the JSON report")
    if report["shadow_executed_without_paper_trade"]:
        lines += ["", f"## Shadow executions with no paper trade in this database ({len(report['shadow_executed_without_paper_trade'])})"]
        lines += [f"- `{s}`" for s in report["shadow_executed_without_paper_trade"][:limit]]
    return "\n".join(lines) + "\n"


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Read-only paper/shadow/execution linkage audit (TASK M).")
    ap.add_argument("paper_db")
    ap.add_argument("--shadow", help="shadow research database (optional; without it the shadow links are NOT_CHECKED)")
    ap.add_argument("--json", action="store_true", help="print the full JSON report instead of markdown")
    args = ap.parse_args(argv)
    report = audit(args.paper_db, args.shadow)
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else render_markdown(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
