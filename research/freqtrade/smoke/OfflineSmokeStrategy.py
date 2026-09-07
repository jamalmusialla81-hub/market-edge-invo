"""Offline-only Freqtrade smoke strategy.

This file proves the isolated Freqtrade installation can backtest local candles.
It is not imported by Market Edge, cannot access an exchange, and is never a
candidate for production strategy replacement.
"""

from pandas import DataFrame
from freqtrade.strategy import IStrategy


class OfflineSmokeStrategy(IStrategy):
    INTERFACE_VERSION = 3
    can_short = False
    timeframe = "5m"
    startup_candle_count = 20
    minimal_roi = {"0": 0.01}
    stoploss = -0.02
    process_only_new_candles = True

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["sma_fast"] = dataframe["close"].rolling(5).mean()
        dataframe["sma_slow"] = dataframe["close"].rolling(20).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[(dataframe["sma_fast"] > dataframe["sma_slow"]) & (dataframe["volume"] > 0), "enter_long"] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[(dataframe["sma_fast"] < dataframe["sma_slow"]) & (dataframe["volume"] > 0), "exit_long"] = 1
        return dataframe
