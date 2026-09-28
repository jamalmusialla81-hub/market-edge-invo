"""Minimal reproduction of a native crash in this environment's
nautilus_trader==1.221.0 wheel.

`BacktestEngine.run()` crashes with `double free or corruption (out)` (a
native/Rust-Cython memory error, not a Python exception) even with ZERO
strategies attached -- just a venue, one stub instrument, one bar, and
run(). This was checked with: a custom-built CryptoPerpetual instrument, the
official TestInstrumentProvider.btcusdt_perp_binance() stub, MARGIN and (a
different, expected) CASH account-type failure, a strategy with a market
order, a strategy with a non-filling resting limit order, a strategy with no
order at all, and both numpy>=2 and numpy<2. All of these reproduce the same
crash -- it happens inside SimulatedExchange/OrderMatchingEngine bar
processing regardless of what our code does, which points at a build/ABI
incompatibility between this prebuilt wheel and this container (most likely
glibc or a native dependency version), not application-level misuse.

Run this directly to reproduce: `python diagnostics/backtest_engine_crash_repro.py`
It should print "NO STRATEGY run complete, no crash" -- in this environment
it instead prints nothing further and the process aborts.
"""
from decimal import Decimal

from nautilus_trader.backtest.engine import BacktestEngine, BacktestEngineConfig
from nautilus_trader.config import LoggingConfig
from nautilus_trader.model.currencies import USDT
from nautilus_trader.model.data import Bar, BarType
from nautilus_trader.model.enums import AccountType, OmsType
from nautilus_trader.model.objects import Money, Price, Quantity
from nautilus_trader.test_kit.providers import TestInstrumentProvider

btc = TestInstrumentProvider.btcusdt_perp_binance()
venue = btc.id.venue

engine = BacktestEngine(config=BacktestEngineConfig(logging=LoggingConfig(log_level="ERROR")))
engine.add_venue(
    venue=venue, oms_type=OmsType.NETTING, account_type=AccountType.MARGIN,
    starting_balances=[Money(100_000, USDT)], base_currency=USDT, default_leverage=Decimal(5),
)
engine.add_instrument(btc)

bar_type = BarType.from_str(f"{btc.id}-1-MINUTE-LAST-EXTERNAL")
bars = [Bar(
    bar_type=bar_type, open=Price.from_str("60000.0"), high=Price.from_str("60010.0"),
    low=Price.from_str("59990.0"), close=Price.from_str("60000.0"), volume=Quantity.from_str("10.000"),
    ts_event=0, ts_init=0,
)]
engine.add_data(bars)
engine.run()
print("NO STRATEGY run complete, no crash")
