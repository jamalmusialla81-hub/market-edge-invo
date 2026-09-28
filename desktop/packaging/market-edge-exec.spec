# PyInstaller spec: freezes execution-service/run_server.py (FastAPI +
# uvicorn + SQLite + the COMPLETE nautilus_trader package) into a one-folder
# executable `market-edge-exec` that runs with no Python installed.
#
# nautilus_trader is mostly compiled Cython/Rust extension modules whose
# imports PyInstaller cannot see, so the whole package and its runtime
# dependencies are collected explicitly (collect_all), not just the modules
# the service imports today: nothing in Nautilus is silently dropped
# (`market-edge-exec nautilus-selftest` runs the real BacktestEngine).
#
# Build:  pyinstaller --noconfirm --distpath <out> --workpath <tmp> desktop/packaging/market-edge-exec.spec
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))
SERVICE = os.path.join(ROOT, "execution-service")

datas, binaries, hiddenimports = [], [], []
for pkg in ("nautilus_trader", "msgspec", "pandas", "pyarrow", "numpy", "fsspec", "portion", "pytz", "tzdata",
            "click", "tqdm", "uvicorn", "fastapi", "starlette", "pydantic", "pydantic_core", "anyio", "h11", "httpx"):
    d, b, h = collect_all(pkg, exclude_datas=["**/tests/**", "**/test/**"])
    datas += d
    binaries += b
    hiddenimports += h
if os.name != "nt":
    hiddenimports += collect_submodules("uvloop")
hiddenimports += collect_submodules("market_edge_exec") + ["real_backtest_scenarios"]
datas += [(os.path.join(SERVICE, "migrations"), "migrations")]

a = Analysis(
    [os.path.join(SERVICE, "run_server.py")],
    pathex=[SERVICE, os.path.join(SERVICE, "diagnostics")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "PyInstaller", "pip", "setuptools"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="market-edge-exec",
    console=True,   # stdout/stderr are piped to the desktop app's logs; it spawns with CREATE_NO_WINDOW
    upx=False,
    codesign_identity=os.environ.get("MACOS_SIGNING_IDENTITY") or None,
    entitlements_file=os.environ.get("MACOS_ENTITLEMENTS") or None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="execution-service")
