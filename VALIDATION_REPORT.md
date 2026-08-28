# Market Edge validation report

Report date: 2026-08-28

## System

The existing static app was extended rather than rebuilt. The quantitative engine now separates data validation, confirmed swing structure, market regime, independent strategies, five-timeframe gating, entry quality, risk sizing, leverage, simulation, walk-forward testing and empirical research gates.

The deployment verdict is **PAPER TRADE ONLY**. The system has not demonstrated a consistent positive out-of-sample expectancy across assets, and its browser backtest is not an exact historical replica of the live five-timeframe scan.

## Data

Live research uses completed public candles from Hyperliquid, Binance and Coinbase where available. A candidate requires multiple-source directional agreement. The engine rejects duplicate timestamps, invalid OHLC data, excessive missing intervals, recent extreme spikes, incomplete candles, stale candles and exchange price disagreement above 2%.

Historical validation in this report used 900 completed Hyperliquid 4-hour candles per asset for BTC, ETH, SOL, DOGE and LTC. That is roughly 150 days and is not enough to establish a durable edge across multiple market cycles.

## Strategies

- Trend continuation: rising/falling EMA structure, non-extended pullback, bounded RSI and adequate volume.
- Breakout + retest: confirmed swing level break followed by a hold/failure at the broken level with adequate volume.
- Momentum continuation: established trend, rate-of-change acceleration, MACD agreement and volume expansion without chase.
- Mean reversion: range regime, momentum extreme and objective rejection near confirmed support/resistance.
- Liquidity-sweep reversal: sweep of a confirmed swing followed by reclaim/rejection and CHoCH evidence.

Contradictory strategies are rejected instead of averaged into one score.

## Five-timeframe live roles

- 1d: macro regime
- 4h: primary direction
- 1h: setup formation
- 15m: confirmation
- 5m: execution timing and chase detection

A short-term bounce cannot create a LONG against a strong bearish 1d regime or opposing 4h direction.

## Cost and execution assumptions

- Entry occurs no earlier than the next candle open.
- 0.03% slippage is applied on entry and exit.
- 0.05% fee is applied on entry and exit (0.16% total modeled friction).
- If stop and target are touched in the same candle, the stop is assumed first.
- TP1 and TP2 are modeled as partial exits; after TP1 the remaining stop moves to entry.
- Maximum holding period is 30 four-hour candles.
- Funding is omitted because reliable aligned historical funding was not loaded.

Actual Hyperliquid base taker fees start below the model assumption, but Invo builder fees, spread, slippage and user tier may differ. The model intentionally uses a conservative combined value.

## Fixed chronological split results

Values are R multiples per completed trade.

| Asset | Overall trades | Overall expectancy | Validation trades | Validation expectancy | Test trades | Test expectancy | Test PF | Rolling unseen expectancy | Stable neighbouring parameters |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| BTC | 17 | -0.369R | 6 | +0.105R | 5 | -0.689R | 0.08 | 0.000R (no selected fold trades) | 0/9 |
| ETH | 17 | +0.711R | 5 | +1.100R | 5 | +0.554R | 7.67 | +0.780R | 9/9 |
| SOL | 20 | +0.190R | 6 | +0.250R | 4 | -0.246R | 0.63 | -0.799R | 6/9 |
| DOGE | 16 | -0.368R | 7 | -0.758R | 3 | -1.148R | — | -0.831R | 0/9 |
| LTC | 22 | +0.029R | 6 | -0.398R | 6 | -0.223R | 0.69 | -0.349R | 0/9 |

The test samples are very small. ETH is encouraging but not sufficient for live approval. SOL is a clear example of why training/validation profit must not override a negative later test and rolling unseen result.

## LONG vs SHORT results (overall sample)

| Asset | LONG trades | LONG expectancy | LONG PF | SHORT trades | SHORT expectancy | SHORT PF |
|---|---:|---:|---:|---:|---:|---:|
| BTC | 9 | -0.311R | 0.54 | 8 | -0.434R | 0.36 |
| ETH | 11 | +0.483R | 2.22 | 6 | +1.129R | 19.03 |
| SOL | 9 | -0.105R | 0.83 | 11 | +0.432R | 2.38 |
| DOGE | 7 | -0.916R | — | 9 | +0.059R | 1.09 |
| LTC | 9 | -0.463R | 0.34 | 13 | +0.371R | 1.73 |

This confirms a material LONG problem in SOL, DOGE and LTC. BTC was negative in both directions. Because those assets also failed later-period validation, the public app disables BTC, SOL, DOGE and LTC candidates until stronger evidence replaces these gates.

## Walk-forward method

The engine uses expanding chronological training data, a following validation window and then the next unseen test window. Candidate quality and R:R settings are selected using only past training/validation results. The selected parameters are then applied to the next test window. Windows roll forward without random shuffling.

Parameter stability tests the 3×3 neighbourhood around the selected quality and R:R values. A strategy is marked stable only when at least 40% of neighbouring settings remain positive in the later period. This is still a limited stability test, not proof of robustness.

## Quality calibration

The backtest reports unseen results in 60–69, 70–79, 80–89 and 90+ quality buckets. Quality remains a ranking score, not a win probability. No UI language claims that an 85 score means an 85% chance of winning.

## Social data

Market Edge does not scrape Invo. Social/trader information is accepted only through authorised user-provided JSON/CSV or manual card fields. Reliability weighting penalises small samples, high leverage and drawdown. No imported social dataset was available for this validation, so social weight was zero and no predictive benefit is claimed.

## Forward test

The browser ledger records timestamp, asset, direction, strategy, entry, entry zone, stop, TP1, TP2, quality, regime, timeframe alignment, selected market features, outcome and R. Original signal fields are not changed after recording. The current unseen sample is insufficient for a readiness decision.

## Failed or unproven ideas

- BTC strategy: negative test expectancy and no stable neighbouring parameters.
- SOL: positive earlier results failed in the untouched test and rolling unseen windows.
- DOGE: negative validation, test, walk-forward and LONG expectancy.
- LTC: near-flat overall result hid negative validation, test and walk-forward expectancy.
- Social confirmation: untested due to no authorised dataset.
- Exact multi-timeframe historical reproduction: not achieved with the currently loaded aligned history.
- Funding model: not implemented in the historical simulator.

## Limitations

- 900 four-hour candles cover only about 150 days.
- Per-asset test samples contain only 3–6 trades.
- The browser backtest is 4h-only while live decisions require 5m/15m/1h/4h/1d data.
- Liquidation is estimated; Invo's displayed mark-price liquidation value remains authoritative.
- Public APIs can be unavailable or blocked on some networks.
- Correlation protection uses user-entered net exposure, not direct wallet access.
- There is no evidence that the current engine will make money in the future.

## Deployment verdict

**PAPER TRADE ONLY**

The system did not demonstrate consistent positive expectancy. ETH showed limited positive unseen results, but the sample and historical fidelity are inadequate for live approval.
