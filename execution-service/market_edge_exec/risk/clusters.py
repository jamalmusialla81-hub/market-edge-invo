"""Correlated-risk clusters for Risk Sizing V2 (versioned, auditable).

CLUSTER-STATIC-V1 is a deliberately simple static assignment: crypto assets
are NOT treated as independent just because they are different symbols.
Each asset maps to one cluster; planned loss is capped per cluster.

Conservative fallback: an asset with no reliable assignment goes to the
shared cluster UNCLASSIFIED. All unclassified assets draw on that ONE
cluster budget, so several unknown symbols can never stack as if they were
independent. A future data-driven method (rolling correlation from clean
venue candles) must ship under a new version string, never by editing this map.
"""
from __future__ import annotations

CLUSTER_METHOD_VERSION = "CLUSTER-STATIC-V1"
UNCLASSIFIED = "UNCLASSIFIED"

_CLUSTERS: dict[str, tuple[str, ...]] = {
    # Highest-cap majors move together more than anything else in crypto.
    "MAJORS": ("BTC", "ETH"),
    "L1_PLATFORMS": ("SOL", "AVAX", "ADA", "DOT", "NEAR", "SUI", "APT", "SEI", "TON", "TRX", "ATOM", "ALGO", "HBAR",
                     "XLM", "XRP", "LTC", "BCH", "ETC", "ICP", "INJ", "TIA", "HYPE", "BNB", "KAS", "FTM", "S"),
    "L2_SCALING": ("ARB", "OP", "MATIC", "POL", "STRK", "IMX", "MNT", "ZK", "BLAST", "BASE"),
    "DEFI": ("UNI", "AAVE", "MKR", "LDO", "CRV", "SNX", "COMP", "DYDX", "GMX", "PENDLE", "JUP", "RAY", "AERO", "ENA",
             "ONDO", "LINK", "PYTH", "JTO", "SUSHI", "1INCH", "CAKE"),
    "MEMES": ("DOGE", "SHIB", "PEPE", "KPEPE", "WIF", "BONK", "KBONK", "FLOKI", "KFLOKI", "POPCAT", "MEW", "BRETT",
              "TRUMP", "FARTCOIN", "PENGU", "MOODENG", "GOAT", "PNUT", "NEIRO", "TURBO", "SPX", "MOG", "KSHIB"),
    "AI_DATA": ("FET", "RENDER", "TAO", "WLD", "AR", "FIL", "GRT", "VIRTUAL", "AI16Z", "IO", "OCEAN", "AKT"),
}
_ASSET_TO_CLUSTER = {asset: cluster for cluster, assets in _CLUSTERS.items() for asset in assets}


def cluster_for(asset: str) -> tuple[str, bool]:
    """Returns (cluster_id, reliably_assigned)."""
    key = str(asset or "").upper().removesuffix("-PERP")
    if key in _ASSET_TO_CLUSTER:
        return _ASSET_TO_CLUSTER[key], True
    return UNCLASSIFIED, False


def cluster_table() -> dict[str, list[str]]:
    return {cluster: list(assets) for cluster, assets in _CLUSTERS.items()}
