"""Pure lifecycle rules, mirrored from production's forward-engine.js:
stop-first on an ambiguous candle, 50% at TP1 then breakeven stop, the rest
at TP2, timeout after the max hold window."""
from market_edge_exec.paper import lifecycle

H = 3_600_000


def c(t, high, low, close=None, open_=None):
    return {"time": t, "open": open_ if open_ is not None else low, "high": high, "low": low, "close": close if close is not None else (high + low) / 2}


def run(direction, candles, tp1_hit=False, remaining=10.0, now=10 * H, opened=0):
    return lifecycle.advance(direction, 100.0, 95.0 if direction == "long" else 105.0,
                             110.0 if direction == "long" else 90.0, 120.0 if direction == "long" else 80.0,
                             remaining, 10.0, tp1_hit, opened, candles, now)


def test_long_stop_closes_everything():
    events = run("long", [c(1 * H, 101, 94)])
    assert [(e.kind, e.quantity) for e in events] == [("STOP", 10.0)]
    assert events[0].fill_price < 95.0  # adverse slippage on a sell


def test_tp1_then_breakeven_stop():
    events = run("long", [c(1 * H, 111, 99), c(2 * H, 105, 99.5)])
    assert [(e.kind, e.quantity) for e in events] == [("TP1", 5.0), ("BREAKEVEN_STOP", 5.0)]


def test_tp1_and_tp2_in_one_candle_close_the_trade():
    events = run("long", [c(1 * H, 121, 99)])
    assert [e.kind for e in events] == ["TP1", "TP2"]
    assert sum(e.quantity for e in events) == 10.0


def test_ambiguous_candle_is_stop_first():
    events = run("long", [c(1 * H, 115, 90)])
    assert [e.kind for e in events] == ["STOP"]


def test_short_mirror():
    events = run("short", [c(1 * H, 101, 89), c(2 * H, 95, 79)])
    assert [e.kind for e in events] == ["TP1", "TP2"]
    assert events[0].fill_price > 90.0  # buying back fills higher


def test_timeout_after_max_hold_window():
    events = run("long", [c(1 * H, 102, 99, close=101)], now=lifecycle.MAX_HOLD_MS + 1)
    assert [e.kind for e in events] == ["TIMEOUT"]
    assert events[0].level == 101


def test_quiet_candles_produce_no_events():
    assert run("long", [c(1 * H, 102, 99), c(2 * H, 103, 98)]) == []


def test_resuming_after_tp1_uses_breakeven_stop():
    events = run("long", [c(3 * H, 101, 99.9)], tp1_hit=True, remaining=5.0)
    assert [(e.kind, e.quantity) for e in events] == [("BREAKEVEN_STOP", 5.0)]
