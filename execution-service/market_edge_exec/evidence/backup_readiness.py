"""Evidence readiness from a desktop backup (#74): which evidence-gated roadmap tasks a `.mebackup` can unblock.

The forward evidence every remaining MAJOR task waits on lives only in the desktop app's local databases. This reads the
app's own export (desktop/src-tauri/src/backup.rs, format v2), validates it the way restore does, extracts only the two
known database entries to a scratch directory, opens them read-only and runs the existing evaluators unchanged:

  #25 MAJOR 4 (paper adaptive exits)   READY only if MAJOR 3H (exits.evaluation) gives some policy a PASS
  #26 MAJOR 5 (forward diagnostic)     READY once a valid shadow database exists (the issue's own unblock condition);
                                       the diagnostic's evidence sufficiency is reported alongside
  #27 MAJOR 6 (V2 sizing review)       READY once the sizing review (#70) clears its evidence floor
  #28 MAJOR 7 (exit model research)    READY once 3H has enough finalized trades/episodes for its own floor
  #29 MAJOR 8 (microstructure)         NOT_ASSESSABLE: a backup holds no L2/tick data

Every READY/BLOCKED comes from the reused modules' own counts and verdicts; nothing here has a bar of its own. It changes no
issue, no mode and no database. The backup and the extracted files are never written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from contextlib import closing
from typing import Any, Optional

READINESS_VERSION = "BACKUP-READINESS-V1"
LABEL = "RESEARCH ONLY · READS A LOCAL BACKUP · CHANGES NO ISSUE, MODE OR DATABASE"
FORMAT = "market-edge-backup"          # backup.rs FORMAT
FORMAT_VERSION = 2                     # backup.rs FORMAT_VERSION (newest this reader understands)
PAPER_ENTRY = "market_edge_paper.sqlite3"
SHADOW_ENTRY = "market_edge_shadow_research.sqlite3"


class BackupRejected(ValueError):
    pass


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _integrity(path: str) -> str:
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as conn:
        return conn.execute("PRAGMA integrity_check").fetchone()[0]


def extract(backup_path: str, dest_dir: str) -> dict:
    """Validate and extract. Only the two known entries are ever written, under fixed names in `dest_dir`."""
    try:
        zf = zipfile.ZipFile(backup_path)
    except (zipfile.BadZipFile, OSError) as e:
        raise BackupRejected(f"not a Market Edge backup (not a zip archive: {e})")
    with zf:
        names = set(zf.namelist())
        if "manifest.json" not in names:
            raise BackupRejected("not a Market Edge backup (no manifest.json)")
        try:
            manifest = json.loads(zf.read("manifest.json"))
        except ValueError as e:
            raise BackupRejected(f"manifest.json is invalid: {e}")
        if manifest.get("format") != FORMAT:
            raise BackupRejected(f"unknown backup format {manifest.get('format')!r}")
        if int(manifest.get("format_version") or 0) > FORMAT_VERSION:
            raise BackupRejected(f"backup format v{manifest.get('format_version')} is newer than this reader supports (v{FORMAT_VERSION})")
        if manifest.get("secrets_included") is not False:
            raise BackupRejected("backup says it includes secrets; refusing to read it")
        out: dict[str, Any] = {"manifest": manifest, "paper_db": None, "shadow_db": None, "ignored_entries": sorted(names - {"manifest.json", "settings.json", PAPER_ENTRY, SHADOW_ENTRY})}
        for entry, key, digest in ((PAPER_ENTRY, "paper_db", manifest.get("db_sha256")),
                                   (SHADOW_ENTRY, "shadow_db", manifest.get("shadow_sha256") if manifest.get("shadow_included") else None)):
            if key == "shadow_db" and not manifest.get("shadow_included"):
                continue
            if entry not in names:
                raise BackupRejected(f"backup manifest lists {entry} but the archive does not contain it")
            target = os.path.join(dest_dir, entry)
            with zf.open(entry) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            actual = _sha256(target)
            if actual != digest:
                raise BackupRejected(f"{entry} checksum mismatch (backup corrupted): expected {digest}, got {actual}")
            check = _integrity(target)
            if check != "ok":
                raise BackupRejected(f"{entry} failed SQLite integrity_check: {check}")
            out[key] = target
    return out


def _gate(task: str, title: str, ready: bool, have: str, need: str, note: Optional[str] = None) -> dict:
    return {"task": task, "title": title, "status": "READY" if ready else "BLOCKED", "have": have, "need": need, **({"note": note} if note else {})}


def assess(paper_db: Optional[str], shadow_db: Optional[str]) -> dict:
    from market_edge_exec.analysis import forward_diagnostic as D
    from market_edge_exec.evaluation import sizing_review as SR
    from market_edge_exec.exits.evaluation import EVIDENCE_BAR_V1, evaluate
    from market_edge_exec.exits.store import ExitStore

    exits: Optional[dict] = None
    if paper_db:
        with closing(sqlite3.connect(f"file:{paper_db}?mode=ro", uri=True)) as conn:
            has_exits = conn.execute("SELECT 1 FROM sqlite_master WHERE name='exit_policy_counterfactuals'").fetchone() is not None
        if has_exits:
            def ro():
                c = sqlite3.connect(f"file:{paper_db}?mode=ro", uri=True)
                c.row_factory = sqlite3.Row
                return c
            exits = evaluate(ExitStore(ro).finalized_records())
    sizing = SR.review(paper_db) if paper_db else None
    diagnostic = D.diagnose(shadow_db, paper_db) if shadow_db else None

    bar = EVIDENCE_BAR_V1
    n_ex, ep_ex = (exits["trades_with_baseline"], exits["independent_episodes"]) if exits else (0, 0)
    passing = sorted(k for k, v in (exits or {}).get("policies", {}).items() if v["verdict"] == "PASS")
    ex_have = f"{n_ex} finalized trades / {ep_ex} episodes" + ("" if exits else " (no exit counterfactual table)")
    gates = [
        _gate("#25", "MAJOR 4 paper adaptive exit rollout", bool(passing),
              f"{ex_have}; passing policies: {', '.join(passing) or 'none'}", f"a 3H PASS (bar {bar['version']})",
              "READY means a policy passed 3H; activating PAPER mode is still a separate owner decision."),
        _gate("#26", "MAJOR 5 forward data diagnostic batch", diagnostic is not None,
              "shadow database present" if diagnostic else "no shadow database in this backup", "a backup that includes the shadow database",
              (f"diagnostic evidence {'SUFFICIENT' if diagnostic['evidence']['sufficient'] else 'INSUFFICIENT'}"
               + ("" if diagnostic["evidence"]["sufficient"] else ": " + "; ".join(diagnostic["evidence"]["missing"]))) if diagnostic else None),
        _gate("#27", "MAJOR 6 forward risk sizing review", bool(sizing) and sizing["verdict"] != "INSUFFICIENT_EVIDENCE",
              f"{sizing['trades']} closed SHADOW trades / {sizing['independent_episodes']} episodes" if sizing else "no paper ledger",
              f"{SR.SIZING_EVIDENCE_BAR_V1['min_trades']} / {SR.SIZING_EVIDENCE_BAR_V1['min_independent_episodes']}",
              f"review verdict {sizing['verdict']}" if sizing else None),
        _gate("#28", "MAJOR 7 exit model research", n_ex >= bar["min_trades"] and ep_ex >= bar["min_independent_episodes"],
              ex_have, f"{bar['min_trades']} / {bar['min_independent_episodes']} (3H's own floor)"),
        {"task": "#29", "title": "MAJOR 8 microstructure", "status": "NOT_ASSESSABLE", "have": "no L2/tick data in a backup",
         "need": "a genuine L2/tick data pipeline (see the issue)"},
    ]
    return {"gates": gates, "exit_evaluation": exits, "sizing_review": sizing, "forward_diagnostic": diagnostic}


def run(backup_path: str, out_dir: Optional[str] = None) -> dict:
    scratch = tempfile.mkdtemp(prefix="me-backup-")
    try:
        ext = extract(backup_path, scratch)
        result = assess(ext["paper_db"], ext["shadow_db"])
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    m = ext["manifest"]
    report = {"readiness_version": READINESS_VERSION, "label": LABEL,
              "backup": {"file": os.path.basename(backup_path), "sha256": _sha256(backup_path), "created_at": m.get("created_at"),
                         "app_version": m.get("app_version"), "git_sha": m.get("git_sha"), "format_version": m.get("format_version"),
                         "shadow_included": bool(m.get("shadow_included")), "ignored_entries": ext["ignored_entries"]},
              **result}
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "readiness.json"), "w") as f:
            json.dump(report, f, indent=2, sort_keys=True, default=str)
        with open(os.path.join(out_dir, "readiness.md"), "w") as f:
            f.write(render_markdown(report))
    return report


def render_markdown(r: dict) -> str:
    b = r["backup"]
    lines = [f"# Evidence readiness from a desktop backup ({r['readiness_version']})", "", f"_{r['label']}_", "",
             f"Backup `{b['file']}` (sha256 `{b['sha256'][:16]}…`), created {b['created_at']} by app {b['app_version']} "
             f"({b['git_sha']}), format v{b['format_version']}, shadow database {'included' if b['shadow_included'] else 'NOT included'}.", "",
             "| task | status | have | need |", "|---|---|---|---|"]
    lines += [f"| {g['task']} {g['title']} | **{g['status']}** | {g['have']} | {g['need']} |" for g in r["gates"]]
    notes = [f"- {g['task']}: {g['note']}" for g in r["gates"] if g.get("note")]
    if notes:
        lines += ["", *notes]
    lines += ["", "READY means the task's own evidence gate has cleared on this backup; it flips no issue and activates nothing.", ""]
    if r["sizing_review"]:
        from market_edge_exec.evaluation import sizing_review as SR
        lines += ["---", "", SR.render_markdown(r["sizing_review"])]
    if r["forward_diagnostic"]:
        from market_edge_exec.analysis import forward_diagnostic as D
        lines += ["---", "", D.render_markdown(r["forward_diagnostic"])]
    if r["exit_evaluation"]:
        from market_edge_exec.exits.evaluation import render_markdown as exit_md
        lines += ["---", "", exit_md(r["exit_evaluation"])]
    return "\n".join(lines) + "\n"


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Which evidence-gated roadmap tasks a desktop backup unblocks. " + LABEL)
    ap.add_argument("backup", help="a .mebackup file exported from the desktop app")
    ap.add_argument("--out", help="directory for readiness.md / readiness.json (keep it outside the repo)")
    args = ap.parse_args(argv)
    try:
        report = run(args.backup, args.out)
    except BackupRejected as e:
        sys.stderr.write(f"backup rejected: {e}\n")
        return 2
    for g in report["gates"]:
        sys.stdout.write(f"{g['task']:<4} {g['status']:<15} {g['title']}: have {g['have']}; need {g['need']}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
