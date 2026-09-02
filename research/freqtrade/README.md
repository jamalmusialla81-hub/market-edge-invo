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

The local environment currently has no Freqtrade binary/container runtime. This
configuration is therefore a lab contract, not a claim that those commands ran.
Never add API keys here; `config.json` remains `dry_run: true`.
