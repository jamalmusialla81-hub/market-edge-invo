"""Version/build metadata reported by /health and the desktop About page.

build_info.json is written by the desktop packaging step next to the frozen
executable (or pointed to by MARKET_EDGE_BUILD_INFO); a source checkout has
none and reports "dev"."""
from __future__ import annotations

import json
import os
import sys
from functools import lru_cache
from pathlib import Path

from market_edge_exec import __version__


@lru_cache(maxsize=1)
def build_info() -> dict:
    candidates = []
    if os.environ.get("MARKET_EDGE_BUILD_INFO"):
        candidates.append(Path(os.environ["MARKET_EDGE_BUILD_INFO"]))
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "build_info.json")
        if getattr(sys, "_MEIPASS", None):
            candidates.append(Path(sys._MEIPASS) / "build_info.json")
    info = {"git_sha": "dev", "build_timestamp": None}
    for c in candidates:
        try:
            info.update(json.loads(c.read_text(encoding="utf-8")))
            break
        except (OSError, ValueError):
            continue
    info.update({"backend_version": __version__, "frozen": bool(getattr(sys, "frozen", False)),
                 "python": sys.version.split()[0]})
    return info
