"""Runs the checks over the forward tables and records verdicts. The paper
database is opened read-only; the only thing written is the append-only
verdict table in the shadow database."""
from __future__ import annotations

import json
import sqlite3
import time
from collections import Counter
from contextlib import closing
from typing import Optional

from market_edge_exec.quality import CHECKER_VERSION, checks as K
from market_edge_exec.shadow.store import ShadowStore

SHADOW_OBSERVATION, RISK_SIZING_DECISION, PAPER_TRADE, SHADOW_JOIN = "SHADOW_OBSERVATION", "RISK_SIZING_DECISION", "PAPER_TRADE", "SHADOW_JOIN"


def _ro(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect("file:" + path.replace("\\", "/") + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _verdict(kind: str, subject: str, findings) -> dict:
    status, reasons = K.worst(findings)
    return {"subject_kind": kind, "subject_id": subject, "verdict": status, "reasons": reasons}


def compute(shadow: ShadowStore, paper_db_path: Optional[str], now_ms: int, listing_ms: Optional[dict] = None) -> list[dict]:
    verdicts: list[dict] = []
    with closing(shadow._connect()) as s:
        obs = [dict(r) for r in s.execute("SELECT * FROM shadow_observations")]
        resolution = {r["observation_id"]: r["resolution_status"] for r in s.execute("SELECT observation_id, resolution_status FROM shadow_resolution")}
        labels: dict[str, list[str]] = {}
        for r in s.execute("SELECT observation_id, labels FROM shadow_labels"):
            try:
                inner = json.loads(__import__("zlib").decompress(r["labels"]).decode())
                labels.setdefault(r["observation_id"], []).extend(str((v or {}).get("label_status")) for v in inner.values() if isinstance(v, dict))
            except Exception:  # noqa: BLE001
                labels.setdefault(r["observation_id"], []).append("CORRUPTED")
        executed = [dict(r) for r in s.execute("SELECT signal_id, observation_id, scan_id FROM forward_paper_executed")]
        obs_ids = {o["observation_id"] for o in obs}
    dup = K.duplicate_findings(obs)
    for o in obs:
        findings = K.observation_findings(o, now_ms, listing_ms)
        if o["observation_id"] in dup:
            findings.append(dup[o["observation_id"]])
        if o["research_candidate_valid"]:
            findings += K.resolution_findings(resolution.get(o["observation_id"]), labels.get(o["observation_id"], []))
        verdicts.append(_verdict(SHADOW_OBSERVATION, o["observation_id"], findings))

    trades: dict[str, dict] = {}
    if paper_db_path:
        with closing(_ro(paper_db_path)) as p:
            for r in p.execute("SELECT trade_id, payload FROM paper_trades"):
                try:
                    trade = json.loads(r["payload"])
                    trades[r["trade_id"]] = trade
                    verdicts.append(_verdict(PAPER_TRADE, r["trade_id"], K.paper_trade_findings(trade, now_ms)))
                except (TypeError, ValueError):
                    verdicts.append(_verdict(PAPER_TRADE, r["trade_id"], [(K.QUARANTINED, "CORRUPTED_RECORD")]))
            for r in p.execute("SELECT * FROM risk_sizing_decisions"):
                verdicts.append(_verdict(RISK_SIZING_DECISION, r["decision_id"], K.sizing_decision_findings(dict(r))))
    for e in executed:
        findings = []
        if e["observation_id"] not in obs_ids:
            findings.append((K.INVALID, "BAD_JOIN_NO_SHADOW_OBSERVATION"))
        if paper_db_path and e["signal_id"] not in trades:
            findings.append((K.INVALID, "BAD_JOIN_NO_PAPER_TRADE"))
        verdicts.append(_verdict(SHADOW_JOIN, e["signal_id"], findings))
    return verdicts


def summarize(shadow: ShadowStore) -> dict:
    latest = shadow.latest_quality()
    by_kind: dict[str, Counter] = {}
    reasons: Counter = Counter()
    for (kind, _), v in latest.items():
        by_kind.setdefault(kind, Counter())[v["verdict"]] += 1
        for r in v["reasons"]:
            reasons[f"{kind}:{r}"] += 1
    return {"checker_version": CHECKER_VERSION, "subjects": len(latest),
            "by_kind": {k: {s: c.get(s, 0) for s in (K.VALID, K.INVALID, K.UNRESOLVED, K.QUARANTINED)} for k, c in sorted(by_kind.items())},
            "reasons": dict(sorted(reasons.items()))}


def run(shadow: ShadowStore, paper_db_path: Optional[str], now_ms: Optional[int] = None, listing_ms: Optional[dict] = None) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    verdicts = compute(shadow, paper_db_path, now_ms, listing_ms)
    written = shadow.record_quality_verdicts(verdicts, CHECKER_VERSION, now_ms)
    return {"checked": len(verdicts), "new_verdicts": written, **summarize(shadow)}
