# Market Edge Freqtrade research lab

This folder is an isolated, dry-run-only comparison lab. It is not connected to
Market Edge production, customer accounts, an exchange, or any API credentials.

`freqtrade-adapter.js` deliberately consumes immutable Market Edge decision
records. It does **not** reproduce the strategy evaluator, so an apparently
better Freqtrade result cannot silently replace Market Edge logic.

Before an experiment can be accepted, run and store all of the following against
the same frozen decision/candle window:

1. completed-candle parity comparison;
2. `lookahead-analysis` for every compatible feature set;
3. `recursive-analysis` with multiple startup-candle counts;
4. the four round-trip cost cases: 0.08%, 0.16%, 0.25%, 0.40%.

The local research environment uses an isolated Python 3.12 virtual environment
with Freqtrade 2025.10. Docker is not required. The tracked smoke fixture is
synthetic and proves only that the offline Freqtrade commands run; it is never
used in Market Edge research, parity, model training, or production decisions.

Run the installation smoke test from the repository root:

```sh
.freqtrade-venv/bin/python research/freqtrade/smoke/generate_smoke_data.py
.freqtrade-venv/bin/python -m freqtrade backtesting --config research/freqtrade/smoke/config.json --userdir research/freqtrade/smoke/user_data --datadir research/freqtrade/smoke/data --strategy OfflineSmokeStrategy --strategy-path research/freqtrade/smoke --data-format-ohlcv json --timerange 20240101-20240121 --export none
```

Never add API keys here; every configuration remains `dry_run: true` and no
tracked strategy has exchange execution capability.
