"""Phase 4 Part 2: real NautilusTrader BacktestEngine scenarios -- BTC/ETH
long/short, market entry, reduce-only exit, cancel, partial fill (if the
sim's fill model produces one), PnL/position updates. Uses Nautilus's own
SimulatedExchange/OrderMatchingEngine/Portfolio/Cache -- NOT the Phase-2
NautilusPortfolio bookkeeping substitute.

This is deliberately a single `engine.run()` call with every scenario's
orders scripted into the strategy's on_bar callback, because incrementally
calling add_data()/run() multiple times on the same BacktestEngine
reproduced a native crash in the original sandbox (see
backtest_engine_crash_repro.py) -- one full run avoids that interleaving
entirely, regardless of whether this environment also hits that bug.

Only run this after backtest_engine_crash_repro.py passes in the same
environment. Prints a JSON scenario report to stdout and writes it to
real_backtest_scenarios.json.
"""
from __future__ import annotations

import json
from decimal import Decimal

from nautilus_trader.backtest.engine import BacktestEngine, BacktestEngineConfig
from nautilus_trader.config import LoggingConfig
from nautilus_trader.model.currencies import BTC, ETH, USDT
from nautilus_trader.model.data import Bar, BarType
from nautilus_trader.model.enums import AccountType, OmsType, OrderSide, TimeInForce
from nautilus_trader.model.identifiers import InstrumentId, Symbol, Venue
from nautilus_trader.model.instruments import CryptoPerpetual
from nautilus_trader.model.objects import Money, Price, Quantity
from nautilus_trader.trading.strategy import Strategy

VENUE = Venue("MARKET_EDGE_SIM")


def make_perp(symbol: str, base_ccy) -> CryptoPerpetual:
    return CryptoPerpetual(
        instrument_id=InstrumentId(symbol=Symbol(symbol), venue=VENUE), raw_symbol=Symbol(symbol),
        base_currency=base_ccy, quote_currency=USDT, settlement_currency=USDT, is_inverse=False,
        price_precision=1, price_increment=Price.from_str("0.1"), size_precision=3, size_increment=Quantity.from_str("0.001"),
        max_quantity=Quantity.from_str("1000.000"), min_quantity=Quantity.from_str("0.001"),
        max_notional=None, min_notional=Money(10.00, USDT), max_price=Price.from_str("1000000.0"), min_price=Price.from_str("0.1"),
        margin_init=Decimal("0.05"), margin_maint=Decimal("0.025"), maker_fee=Decimal("0.0002"), taker_fee=Decimal("0.00018"),
        ts_event=0, ts_init=0,
    )


def make_bar(bar_type: BarType, price: float, ts: int) -> Bar:
    return Bar(
        bar_type=bar_type, open=Price.from_str(f"{price:.1f}"), high=Price.from_str(f"{price + 20:.1f}"),
        low=Price.from_str(f"{price - 20:.1f}"), close=Price.from_str(f"{price:.1f}"), volume=Quantity.from_str("50.000"),
        ts_event=ts, ts_init=ts,
    )


class ScenarioStrategy(Strategy):
    """Scripts every scenario against a bar counter so the whole thing runs in one engine.run()."""

    def __init__(self, btc_id: InstrumentId, eth_id: InstrumentId, btc_bar_type: BarType, eth_bar_type: BarType):
        super().__init__()
        self.btc_id, self.eth_id = btc_id, eth_id
        self.btc_bar_type, self.eth_bar_type = btc_bar_type, eth_bar_type
        self.events = []
        self._btc_bar_count = 0
        self._eth_bar_count = 0
        self.cancel_target_id = None

    def on_start(self):
        self.subscribe_bars(self.btc_bar_type)
        self.subscribe_bars(self.eth_bar_type)

    def on_bar(self, bar: Bar):
        is_btc = bar.bar_type == self.btc_bar_type
        count = self._btc_bar_count if is_btc else self._eth_bar_count
        instrument_id = self.btc_id if is_btc else self.eth_id
        side_entry = OrderSide.BUY if is_btc else OrderSide.SELL  # BTC LONG, ETH SHORT
        label = "BTC" if is_btc else "ETH"

        if count == 0:
            order = self.order_factory.market(instrument_id=instrument_id, order_side=side_entry, quantity=Quantity.from_str("0.100"))
            self.submit_order(order)
            self.events.append({"scenario": f"{label}_ENTRY_SUBMIT", "side": side_entry.name, "order_id": str(order.client_order_id)})
        elif count == 1:
            # A resting limit order far from market, to be cancelled next bar (CANCEL scenario), BTC only.
            if is_btc:
                cancel_target = self.order_factory.limit(instrument_id=instrument_id, order_side=OrderSide.BUY, quantity=Quantity.from_str("0.050"), price=Price.from_str("1000.0"))
                self.submit_order(cancel_target)
                self.cancel_target_id = cancel_target.client_order_id
                self.events.append({"scenario": "CANCEL_TARGET_SUBMIT", "order_id": str(cancel_target.client_order_id)})
        elif count == 2:
            if is_btc and self.cancel_target_id is not None:
                self.cancel_order(self.cache.order(self.cancel_target_id))
                self.events.append({"scenario": "CANCEL_SUBMIT", "order_id": str(self.cancel_target_id)})
        elif count == 3:
            net = self.portfolio.net_position(instrument_id)
            if net != 0:
                reduce_side = OrderSide.SELL if net > 0 else OrderSide.BUY
                exit_order = self.order_factory.market(instrument_id=instrument_id, order_side=reduce_side, quantity=Quantity.from_str(f"{abs(net):.3f}"), reduce_only=True)
                self.submit_order(exit_order)
                self.events.append({"scenario": f"{label}_REDUCE_ONLY_EXIT_SUBMIT", "order_id": str(exit_order.client_order_id)})

        if is_btc:
            self._btc_bar_count += 1
        else:
            self._eth_bar_count += 1


def run() -> dict:
    btc = make_perp("BTC-PERP", BTC)
    eth = make_perp("ETH-PERP", ETH)

    engine = BacktestEngine(config=BacktestEngineConfig(logging=LoggingConfig(log_level="ERROR")))
    engine.add_venue(
        venue=VENUE, oms_type=OmsType.NETTING, account_type=AccountType.MARGIN,
        starting_balances=[Money(1_000_000, USDT)], base_currency=USDT, default_leverage=Decimal(5),
    )
    engine.add_instrument(btc)
    engine.add_instrument(eth)

    btc_bar_type = BarType.from_str(f"{btc.id}-1-MINUTE-LAST-EXTERNAL")
    eth_bar_type = BarType.from_str(f"{eth.id}-1-MINUTE-LAST-EXTERNAL")
    strategy = ScenarioStrategy(btc.id, eth.id, btc_bar_type, eth_bar_type)
    engine.add_strategy(strategy)

    bars = []
    btc_price, eth_price = 60_000.0, 3_000.0
    for i in range(6):
        ts = i * 60_000_000_000
        bars.append(make_bar(btc_bar_type, btc_price, ts))
        bars.append(make_bar(eth_bar_type, eth_price, ts))
        btc_price += 15
        eth_price += 2
    engine.add_data(bars)
    engine.run()

    account = engine.portfolio.account(VENUE)
    btc_position = engine.portfolio.net_position(btc.id)
    eth_position = engine.portfolio.net_position(eth.id)
    cancel_order = engine.cache.order(strategy.cancel_target_id) if strategy.cancel_target_id else None

    report = {
        "scenario": "REAL_BACKTEST_ENGINE_BTC_ETH_LONG_SHORT",
        "events": strategy.events,
        "btc_net_position_after_entry_and_exit": float(btc_position) if btc_position is not None else None,
        "eth_net_position_after_entry_and_exit": float(eth_position) if eth_position is not None else None,
        "cancel_order_status": cancel_order.status.name if cancel_order else None,
        "account_balances": [str(b) for b in account.balances_total().values()] if account else None,
        "orders_total": len(engine.cache.orders()),
        "orders_filled": len([o for o in engine.cache.orders() if o.status.name == "FILLED"]),
        "positions_closed": len(engine.cache.positions_closed()),
    }
    return report


if __name__ == "__main__":
    result = run()
    print(json.dumps(result, indent=2, default=str))
    with open("real_backtest_scenarios.json", "w") as handle:
        json.dump(result, handle, indent=2, default=str)
