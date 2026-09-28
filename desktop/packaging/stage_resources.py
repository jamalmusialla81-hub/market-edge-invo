#!/usr/bin/env python3
"""Stages everything the installed app runs into desktop/src-tauri/bundle/,
which tauri.conf.json ships as the app's resources:

  bundle/
    execution-service/   PyInstaller one-folder build (market-edge-exec[.exe] + _internal/)
    signal-bridge/       the forward loop and the production scanner, byte-for-byte
                         copies of the repo files (MANIFEST.json holds their sha256)
    runtime/             node[.exe] -- the official Node.js binary, private to the app
    migrations/          numbered SQL migrations for the service's SQLite file
    config/              defaults.json + build_info.json (read-only; user state lives in app data)

Build-machine only. The installed app never needs Python, Node, npm or the repo.

usage: stage_resources.py --exec-dist <pyinstaller dist/execution-service> [--node <path to node>]
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "desktop" / "src-tauri" / "bundle"

ENTRY = "signal-bridge/forward_loop.mjs"
_RELATIVE_IMPORT = re.compile(r"""(?:from\s*|import\s*\(\s*|require\s*\(\s*|^import\s+)['"](\.{1,2}/[^'"]+)['"]""", re.M)


def import_graph(entry: str) -> list[str]:
    """Every repo file the forward loop loads, found by following its relative
    imports (static, dynamic and require). They are copied unchanged, keeping
    their relative layout, so each import resolves exactly as in the repo.
    Bare specifiers other than node: builtins would need node_modules, which
    the loop does not use -- fail loudly if that ever changes."""
    seen, todo = set(), [entry]
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        seen.add(rel)
        src = (ROOT / rel).read_text(encoding="utf-8")
        for spec in _RELATIVE_IMPORT.findall(src):
            todo.append(Path(os.path.normpath(os.path.join(os.path.dirname(rel), spec))).as_posix())
        bare = [m for m in re.findall(r"""from\s*['"]([^./'"][^'"]*)['"]""", src) if not m.startswith("node:")]
        if bare:
            sys.exit(f"{rel} imports packages {bare}; bundle node_modules for them first")
    return sorted(seen)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_sha() -> str:
    if os.environ.get("GITHUB_SHA"):
        return os.environ["GITHUB_SHA"]
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exec-dist", required=True, type=Path)
    ap.add_argument("--node", default=shutil.which("node"))
    args = ap.parse_args()

    exe_name = "market-edge-exec.exe" if os.name == "nt" else "market-edge-exec"
    if not (args.exec_dist / exe_name).is_file():
        sys.exit(f"missing {args.exec_dist / exe_name}; run pyinstaller first")
    if not args.node:
        sys.exit("no node binary to bundle")
    node_src = Path(args.node).resolve()

    if OUT.exists():
        shutil.rmtree(OUT)
    for d in ("signal-bridge", "runtime", "migrations", "config"):
        (OUT / d).mkdir(parents=True)

    # Symlinks are dereferenced here because the Tauri bundler copies
    # resources as plain files anyway; the smoke check below and the CI
    # integration tests then exercise exactly the tree that ships.
    shutil.copytree(args.exec_dist, OUT / "execution-service", symlinks=False)

    manifest = {}
    for rel in import_graph(ENTRY):
        dst = OUT / "signal-bridge" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)
        manifest[rel] = sha256(ROOT / rel)
        assert sha256(dst) == manifest[rel]
    # same module semantics as the repo root package.json ("type": "commonjs"):
    # quant-engine.js / ml-engine.js are CommonJS, the .mjs files are ESM.
    (OUT / "signal-bridge" / "package.json").write_text(json.dumps({"name": "market-edge-signal-bridge", "private": True, "type": "commonjs"}, indent=2) + "\n")
    (OUT / "signal-bridge" / "MANIFEST.json").write_text(json.dumps({"source": "repo files copied unchanged", "sha256": manifest}, indent=2) + "\n")

    node_dst = OUT / "runtime" / ("node.exe" if os.name == "nt" else "node")
    shutil.copy2(node_src, node_dst)
    node_version = subprocess.check_output([str(node_dst), "--version"], text=True).strip()

    for sql in sorted((ROOT / "execution-service" / "migrations").glob("*.sql")):
        shutil.copy2(sql, OUT / "migrations" / sql.name)

    selftest = subprocess.run([str(OUT / "execution-service" / exe_name), "nautilus-selftest"], capture_output=True, text=True)
    if selftest.returncode != 0:
        sys.exit(f"staged execution-service failed nautilus-selftest:\n{selftest.stdout[-2000:]}\n{selftest.stderr[-4000:]}")
    exec_info = json.loads(subprocess.check_output([str(OUT / "execution-service" / exe_name), "version"], text=True).strip().splitlines()[-1])
    version = json.loads((ROOT / "desktop" / "src-tauri" / "tauri.conf.json").read_text())["version"]
    build_info = {
        "app_version": version,
        "git_sha": git_sha(),
        "build_timestamp": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "target": f"{platform.system().lower()}-{platform.machine().lower()}",
        "node_version": node_version,
        "packaging": {
            "execution-service": "PyInstaller one-folder (desktop/packaging/market-edge-exec.spec), CPython "
                                 + exec_info["python"] + ", full nautilus_trader package collected",
            "forward-loop": "official Node.js runtime " + node_version + " + unmodified repo sources",
        },
    }
    for dst in (OUT / "config" / "build_info.json", OUT / "execution-service" / "build_info.json"):
        dst.write_text(json.dumps(build_info, indent=2) + "\n")
    (OUT / "config" / "defaults.json").write_text(json.dumps({
        "exec_port": 8765,
        "cycle_interval_ms": 300000,
        "hummingbot_mode": "disabled",
        "auto_start_paper": True,
    }, indent=2) + "\n")

    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file() and not f.is_symlink())
    print(json.dumps({"staged": str(OUT), "bytes": total, **build_info}, indent=2))


if __name__ == "__main__":
    main()
