"""TASK K (#89): dynamic correlation / factor clusters, a research candidate beside CLUSTER-STATIC-V1.

Pure and offline: it takes aligned closes and returns groupings. It imports nothing from sizing, the ledger or the engine, so
it cannot affect a decision. Nothing calls it from production; Risk Sizing V2 still uses the static map, unchanged. A candidate
here becomes authoritative only through MAJOR 6's evidence-gated review, under its own `cluster_method_version`.

Never looser than the static map, by construction: every dynamic grouping is the static grouping PLUS extra links found in the
data, so two assets the static map keeps together always stay together (including everything sharing UNCLASSIFIED). The data can
only tighten risk.

No single universal threshold. A candidate is a named set of parameters (window set, agreement rule, link level), several are
evaluated side by side, and a link needs the correlation to hold in EVERY window of the candidate (the minimum across windows),
on volatility-scaled returns, with enough overlapping bars. An asset without enough data gets no dynamic link and keeps only its static
cluster: missing data never loosens, never invents a link.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Optional

from market_edge_exec.risk import clusters as static

DYNAMIC_VERSION = "CLUSTER-DYNAMIC-CANDIDATES-V1"
MIN_OVERLAP_BARS = 30      # a window with fewer overlapping returns than this yields no correlation, never a guess


@dataclass(frozen=True)
class Candidate:
    """A named parameter set. The parameters are part of the version: changing one means a new name."""
    version: str
    windows: tuple           # bars per window (e.g. hourly bars: 72 = 3d, 168 = 7d, 720 = 30d)
    link_level: float        # |correlation| that must hold in EVERY window for two assets to be one bet
    vol_scaled: bool = True  # standardise each return by its trailing volatility before correlating


CANDIDATES = {c.version: c for c in (
    Candidate("CLUSTER-DYN-V1-C50", (72, 168, 720), 0.50),
    Candidate("CLUSTER-DYN-V1-C65", (72, 168, 720), 0.65),
    Candidate("CLUSTER-DYN-V1-C80", (72, 168, 720), 0.80),
    Candidate("CLUSTER-DYN-V1-C65-RAW", (72, 168, 720), 0.65, vol_scaled=False),
)}


def log_returns(closes: list[float]) -> list[float]:
    out = []
    for a, b in zip(closes, closes[1:]):
        out.append(math.log(b / a) if a > 0 and b > 0 and math.isfinite(a) and math.isfinite(b) else math.nan)
    return out


def _scale(rets: list[float], lookback: int = 24) -> list[float]:
    """Return / trailing standard deviation (no lookahead: the deviation uses only earlier returns). NaN until enough history."""
    out = []
    for i, r in enumerate(rets):
        hist = [x for x in rets[max(0, i - lookback):i] if math.isfinite(x)]
        if len(hist) < 8 or not math.isfinite(r):
            out.append(math.nan)
            continue
        m = sum(hist) / len(hist)
        sd = math.sqrt(sum((x - m) ** 2 for x in hist) / (len(hist) - 1))
        out.append(r / sd if sd > 0 else math.nan)
    return out


def corr(a: list[float], b: list[float], window: int) -> Optional[float]:
    """Pearson correlation over the last `window` aligned returns, using only pairs where both are finite; None if too few."""
    xs, ys = a[-window:], b[-window:]
    pairs = [(x, y) for x, y in zip(xs, ys) if math.isfinite(x) and math.isfinite(y)]
    if len(pairs) < MIN_OVERLAP_BARS:
        return None
    mx, my = sum(p[0] for p in pairs) / len(pairs), sum(p[1] for p in pairs) / len(pairs)
    sx = math.sqrt(sum((p[0] - mx) ** 2 for p in pairs))
    sy = math.sqrt(sum((p[1] - my) ** 2 for p in pairs))
    if sx == 0 or sy == 0:
        return None
    return sum((p[0] - mx) * (p[1] - my) for p in pairs) / (sx * sy)


def beta(asset: list[float], market: list[float], window: int) -> Optional[float]:
    xs, ys = market[-window:], asset[-window:]
    pairs = [(x, y) for x, y in zip(xs, ys) if math.isfinite(x) and math.isfinite(y)]
    if len(pairs) < MIN_OVERLAP_BARS:
        return None
    mx, my = sum(p[0] for p in pairs) / len(pairs), sum(p[1] for p in pairs) / len(pairs)
    var = sum((p[0] - mx) ** 2 for p in pairs)
    return None if var == 0 else sum((p[0] - mx) * (p[1] - my) for p in pairs) / var


def _returns(closes_by_asset: dict[str, list[float]], candidate: Candidate) -> dict[str, list[float]]:
    out = {}
    for asset, closes in closes_by_asset.items():
        r = log_returns(list(closes))
        out[asset.upper().removesuffix("-PERP")] = _scale(r) if candidate.vol_scaled else r
    return out


def pair_link(a: list[float], b: list[float], candidate: Candidate) -> dict:
    """Correlation in every window and the minimum |corr| across them; `linked` only if every window has data and clears the level."""
    per = {w: corr(a, b, w) for w in candidate.windows}
    if any(v is None for v in per.values()):
        return {"windows": per, "min_abs": None, "sign": None, "linked": False, "reason": "insufficient overlapping data in at least one window"}
    signs = {v > 0 for v in per.values()}
    min_abs = min(abs(v) for v in per.values())
    same_sign = len(signs) == 1        # a correlation that flips sign between windows is not a stable link
    linked = same_sign and min_abs >= candidate.link_level
    return {"windows": per, "min_abs": min_abs, "sign": (1 if next(iter(signs)) else -1) if same_sign else 0, "linked": linked,
            "reason": None if linked else ("sign changes between windows" if not same_sign else "below the link level in at least one window")}


class _Union:
    def __init__(self, items: Iterable[str]):
        self.parent = {i: i for i in items}

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)   # deterministic representative: the smallest name


def compute(closes_by_asset: dict[str, list[float]], candidate: Candidate, market: str = "BTC") -> dict:
    """Dynamic clusters for one candidate, point-in-time: only the closes passed in are used.

    Returns assignments (asset -> cluster id), the links found, each asset's BTC beta and broad-crypto beta per window, and the static
    assignment beside it. Clusters are connected components of (static links + dynamic links)."""
    rets = _returns(closes_by_asset, candidate)
    assets = sorted(rets)
    uf = _Union(assets)
    # static links first: the dynamic result can never separate what the static map keeps together
    static_group: dict[str, list[str]] = {}
    for a in assets:
        static_group.setdefault(static.cluster_for(a)[0], []).append(a)
    for members in static_group.values():
        for m in members[1:]:
            uf.union(members[0], m)
    links = []
    for i, a in enumerate(assets):
        for b in assets[i + 1:]:
            info = pair_link(rets[a], rets[b], candidate)
            if info["linked"]:
                uf.union(a, b)
                links.append({"a": a, "b": b, "sign": info["sign"], "min_abs_corr": info["min_abs"]})
    groups: dict[str, list[str]] = {}
    for a in assets:
        groups.setdefault(uf.find(a), []).append(a)
    assignment = {a: "DYN:" + uf.find(a) for a in assets}
    index = [sum(x for x in col if math.isfinite(x)) / max(1, sum(1 for x in col if math.isfinite(x)))
             for col in zip(*[rets[a] for a in assets])] if assets else []
    factors = {}
    for a in assets:
        factors[a] = {"beta_btc": {w: beta(rets[a], rets[market], w) for w in candidate.windows} if market in rets else None,
                      "beta_crypto": {w: beta(rets[a], index, w) for w in candidate.windows}}
    return {"version": candidate.version, "dynamic_version": DYNAMIC_VERSION, "params": {"windows": list(candidate.windows), "link_level": candidate.link_level,
            "vol_scaled": candidate.vol_scaled, "min_overlap_bars": MIN_OVERLAP_BARS},
            "assignments": assignment, "clusters": {"DYN:" + k: sorted(v) for k, v in sorted(groups.items())},
            "links": links, "factors": factors,
            "static": {a: static.cluster_for(a)[0] for a in assets}, "static_method_version": static.CLUSTER_METHOD_VERSION}


def refines_static(result: dict) -> bool:
    """True when no static cluster is split by the dynamic grouping (the never-looser property)."""
    by_static: dict[str, set] = {}
    for a, s in result["static"].items():
        by_static.setdefault(s, set()).add(result["assignments"][a])
    return all(len(v) == 1 for v in by_static.values())


def same_bet(result: dict, a: str, direction_a: str, b: str, direction_b: str) -> bool:
    """Direction-aware: two positions are one bet when their assets share a cluster and point the same way, or are stably
    anti-correlated and point opposite ways. A long and a short in the same cluster hedge each other unless the link says otherwise."""
    a, b = a.upper().removesuffix("-PERP"), b.upper().removesuffix("-PERP")
    if a == b:
        return direction_a == direction_b
    if result["assignments"].get(a) is None or result["assignments"].get(a) != result["assignments"].get(b):
        return False
    sign = next((l["sign"] for l in result["links"] if {l["a"], l["b"]} == {a, b}), None)
    if sign == -1:
        return direction_a != direction_b
    return direction_a == direction_b
