"""Generate deterministic local candles for the Freqtrade installation check.

The generated series is deliberately synthetic and is never used for Market
Edge research, parity, metrics, model training, or product decisions.
"""

import json
from pathlib import Path


def main() -> None:
    rows = []
    start = 1_704_067_200_000  # 2024-01-01T00:00:00Z
    price = 42_000.0
    # 6,000 five-minute bars permits Freqtrade's 199/499/999/1999 warm-up
    # comparison without ever becoming Market Edge research data.
    for index in range(6_000):
        drift = 18 if (index // 40) % 2 == 0 else -15
        open_price = price
        close = open_price + drift + ((index % 7) - 3) * 2
        high = max(open_price, close) + 9
        low = min(open_price, close) - 9
        rows.append([start + index * 300_000, open_price, high, low, close, 100 + index])
        price = close
    target = Path(__file__).parent / "data" / "BTC_USDT-5m.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(rows), encoding="utf-8")


if __name__ == "__main__":
    main()
