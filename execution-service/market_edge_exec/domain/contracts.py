"""Domain contracts shared with the Node/JS side.

These mirror research/execution-architecture/domain-objects.js field-for-field
(same names, same required/optional split) plus a schema/version pair so the
two languages can detect drift instead of silently disagreeing. No field is
renamed between the JS and Python versions; see tests/test_js_python_parity.py
for the round-trip check against fixtures generated from the JS objects.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional

SCHEMA_VERSION = "1.0.0"


class ContractError(ValueError):
    pass


def _require(data: dict, fields: list[str], kind: str) -> None:
    missing = [f for f in fields if data.get(f) is None]
    if missing:
        raise ContractError(f"{kind}_INVALID: missing {','.join(missing)}")


@dataclass(frozen=True)
class AlphaSignal:
    signal_id: str
    asset: str
    direction: str  # 'long' | 'short'
    timestamp: int
    entry: Optional[float] = None
    stop: Optional[float] = None
    targets: list = field(default_factory=list)
    quant_score: Optional[float] = None
    strategy_id: Optional[str] = None
    schema: str = "AlphaSignal"
    version: str = SCHEMA_VERSION

    @staticmethod
    def create(data: dict) -> "AlphaSignal":
        _require(data, ["signal_id", "asset", "direction", "timestamp"], "ALPHA_SIGNAL")
        if data["direction"] not in ("long", "short"):
            raise ContractError("ALPHA_SIGNAL_INVALID: invalid direction")
        return AlphaSignal(
            signal_id=str(data["signal_id"]), asset=str(data["asset"]), direction=data["direction"],
            timestamp=int(data["timestamp"]), entry=data.get("entry"), stop=data.get("stop"),
            targets=list(data.get("targets", [])), quant_score=data.get("quant_score"),
            strategy_id=data.get("strategy_id"),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class RiskDecision:
    signal_id: str
    approved: bool
    approved_leverage: float = 1.0
    max_position_notional: Optional[float] = None
    reason: Optional[str] = None
    schema: str = "RiskDecision"
    version: str = SCHEMA_VERSION

    @staticmethod
    def create(data: dict) -> "RiskDecision":
        _require(data, ["signal_id", "approved"], "RISK_DECISION")
        return RiskDecision(
            signal_id=str(data["signal_id"]), approved=bool(data["approved"]),
            approved_leverage=float(data.get("approved_leverage", 1.0)),
            max_position_notional=data.get("max_position_notional"), reason=data.get("reason"),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class PortfolioDecision:
    signal_id: str
    quantity: float
    reduce_only: bool = False
    schema: str = "PortfolioDecision"
    version: str = SCHEMA_VERSION

    @staticmethod
    def create(data: dict) -> "PortfolioDecision":
        _require(data, ["signal_id", "quantity"], "PORTFOLIO_DECISION")
        return PortfolioDecision(signal_id=str(data["signal_id"]), quantity=float(data["quantity"]), reduce_only=bool(data.get("reduce_only", False)))

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ExecutionIntent:
    signal_id: str
    instrument: str
    side: str  # 'buy' | 'sell'
    quantity: float
    order_type: str
    strategy_id: str
    limit_price: Optional[float] = None
    stop: Optional[float] = None
    targets: list = field(default_factory=list)
    leverage: float = 1.0
    reduce_only: bool = False
    time_in_force: str = "GTC"
    venue_preference: Optional[str] = None
    schema: str = "ExecutionIntent"
    version: str = SCHEMA_VERSION

    @staticmethod
    def create(data: dict) -> "ExecutionIntent":
        _require(data, ["signal_id", "instrument", "side", "quantity", "order_type", "strategy_id"], "EXECUTION_INTENT")
        if data["side"] not in ("buy", "sell"):
            raise ContractError("EXECUTION_INTENT_INVALID: invalid side")
        return ExecutionIntent(
            signal_id=str(data["signal_id"]), instrument=str(data["instrument"]), side=data["side"],
            quantity=float(data["quantity"]), order_type=str(data["order_type"]), strategy_id=str(data["strategy_id"]),
            limit_price=data.get("limit_price"), stop=data.get("stop"), targets=list(data.get("targets", [])),
            leverage=float(data.get("leverage", 1.0)), reduce_only=bool(data.get("reduce_only", False)),
            time_in_force=str(data.get("time_in_force", "GTC")), venue_preference=data.get("venue_preference"),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ExecutionFill:
    signal_id: str
    fill_id: str
    status: str  # FILLED | PARTIALLY_FILLED | CANCELLED | REJECTED
    quantity_filled: float
    avg_price: Optional[float] = None
    fee: float = 0.0
    backend: str = "UNKNOWN"
    timestamp: int = 0
    schema: str = "ExecutionFill"
    version: str = SCHEMA_VERSION

    STATUSES = ("FILLED", "PARTIALLY_FILLED", "CANCELLED", "REJECTED")

    @staticmethod
    def create(data: dict) -> "ExecutionFill":
        _require(data, ["signal_id", "fill_id", "status", "quantity_filled"], "EXECUTION_FILL")
        if data["status"] not in ExecutionFill.STATUSES:
            raise ContractError(f"EXECUTION_FILL_INVALID: unknown status {data['status']}")
        return ExecutionFill(
            signal_id=str(data["signal_id"]), fill_id=str(data["fill_id"]), status=data["status"],
            quantity_filled=float(data["quantity_filled"]), avg_price=data.get("avg_price"),
            fee=float(data.get("fee", 0.0)), backend=str(data.get("backend", "UNKNOWN")),
            timestamp=int(data.get("timestamp", 0)),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class PositionSnapshot:
    instrument: str
    quantity: float
    avg_entry: Optional[float] = None
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0
    backend: str = "UNKNOWN"
    schema: str = "PositionSnapshot"
    version: str = SCHEMA_VERSION

    @staticmethod
    def create(data: dict) -> "PositionSnapshot":
        _require(data, ["instrument", "quantity"], "POSITION_SNAPSHOT")
        return PositionSnapshot(
            instrument=str(data["instrument"]), quantity=float(data["quantity"]), avg_entry=data.get("avg_entry"),
            unrealized_pnl=float(data.get("unrealized_pnl", 0.0)), realized_pnl=float(data.get("realized_pnl", 0.0)),
            backend=str(data.get("backend", "UNKNOWN")),
        )

    def to_dict(self) -> dict:
        return asdict(self)
