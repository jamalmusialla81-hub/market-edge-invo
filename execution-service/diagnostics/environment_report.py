"""Prints an exact environment report as JSON: OS, Python, nautilus_trader,
numpy. Used by CI to record what was actually tested, per Phase 4's
requirement to return exact versions rather than a vague "it worked"."""
import json
import platform
import sys


def report() -> dict:
    data = {
        "os": platform.platform(), "python": sys.version.split()[0],
        "nautilus_trader": None, "numpy": None,
    }
    try:
        import nautilus_trader
        data["nautilus_trader"] = nautilus_trader.__version__
    except Exception as error:  # noqa: BLE001
        data["nautilus_trader_import_error"] = str(error)
    try:
        import numpy
        data["numpy"] = numpy.__version__
    except Exception as error:  # noqa: BLE001
        data["numpy_import_error"] = str(error)
    return data


if __name__ == "__main__":
    print(json.dumps(report(), indent=2))
