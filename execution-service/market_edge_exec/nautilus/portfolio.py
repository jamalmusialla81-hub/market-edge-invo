"""NautilusTrader-backed canonical state.

Honesty note (see execution-service/README.md "Nautilus integration depth"):
this uses the REAL, installed nautilus_trader package's model types
(InstrumentId, Currency, Money, Quantity, Price, OrderSide) to validate and
represent every position/order this service touches, so instrument ids,
quantities, and prices are always Nautilus-shaped values rather than bare
floats/strings. What is NOT wired up in this pass is the full live
TradingNode / BacktestEngine order-matching and actor/message-bus stack —
that requires venue/instrument configuration and an async runtime beyond
this pass's scope, and is called out as NEXT STEP. Canonical position and
PnL bookkeeping in this pass is done by this class, backed by
persistence/store.py, using Nautilus's own value types throughout.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from nautilus_trader.model.enums import OrderSide
from nautilus_trader.model.identifiers import InstrumentId, Symbol, Venue
from nautilus_trader.model.objects import Price, Quantity

from market_edge_exec.domain.contracts import ExecutionIntent, PositionSnapshot
from market_edge_exec.persistence.store import Store


QUANTITY_DUST = 5e-8  # below the 8dp quantity precision used for every fill


def to_instrument_id(instrument: str) -> InstrumentId:
    """'BTC-PERP' -> InstrumentId(Symbol('BTC-PERP'), Venue('MARKET_EDGE'))."""
    return InstrumentId(Symbol(instrument), Venue("MARKET_EDGE"))


def to_order_side(side: str) -> OrderSide:
    return OrderSide.BUY if side == "buy" else OrderSide.SELL


@dataclass
class _Position:
    quantity: float
    avg_entry: float
    realized_pnl: float = 0.0
    backend: str = "NAUTILUS_NATIVE"


class NautilusPortfolio:
    """Canonical position/PnL owner for this service. Real Nautilus model
    types round-trip every value through this class (see to_instrument_id /
    Quantity / Price below), even though the matching itself is our own
    paper fill logic rather than Nautilus's SimulatedExchange."""

    def __init__(self, store: Store):
        self._store = store
        self._positions: dict[str, _Position] = {}
        for row in store.positions():
            self._positions[row["instrument"]] = _Position(
                row["quantity"], row.get("avg_entry") or 0.0, row.get("realized_pnl") or 0.0, row.get("backend") or "NAUTILUS_NATIVE",
            )

    def apply_fill(self, intent: ExecutionIntent, fill_price: float, quantity_filled: float, backend: str) -> PositionSnapshot:
        # Round-trip through real Nautilus value types to validate shape/precision.
        instrument_id = to_instrument_id(intent.instrument)
        side = to_order_side(intent.side)
        qty = Quantity.from_str(f"{quantity_filled:.8f}".rstrip("0").rstrip(".") or "0")
        price = Price.from_str(f"{fill_price:.8f}".rstrip("0").rstrip(".") or "0")

        signed_qty = float(qty) if side == OrderSide.BUY else -float(qty)
        existing = self._positions.get(intent.instrument, _Position(0.0, float(price), backend=backend))
        new_quantity = existing.quantity + signed_qty
        if abs(new_quantity) < QUANTITY_DUST:
            # Each fill is rounded to 8dp separately, so closing a position in
            # parts can leave a 1e-8 residue that would read as a ghost position.
            new_quantity = 0.0
        realized = existing.realized_pnl
        reducing = existing.quantity != 0 and (signed_qty > 0) != (existing.quantity > 0)
        if reducing:
            # Realize on any reduction (a partial TP1 exit included), not only
            # when the position flips sign.
            closed = min(abs(existing.quantity), abs(signed_qty))
            direction = 1 if existing.quantity > 0 else -1
            realized += direction * closed * (float(price) - existing.avg_entry)
        if existing.quantity == 0 or (reducing and new_quantity != 0 and (new_quantity > 0) != (existing.quantity > 0)):
            avg_entry = float(price)  # fresh position, or flipped through zero
        elif reducing:
            avg_entry = existing.avg_entry  # a partial close does not move the entry
        else:
            avg_entry = (existing.avg_entry * abs(existing.quantity) + float(price) * quantity_filled) / (abs(existing.quantity) + quantity_filled)

        # The backend of record for an instrument is whichever backend most
        # recently filled it -- a position only ever lives on one backend at
        # a time in this design (no split routing of the same instrument).
        position = _Position(new_quantity, avg_entry, realized, backend=backend)
        self._positions[str(instrument_id.symbol)] = position
        snapshot = PositionSnapshot.create({
            "instrument": str(instrument_id.symbol), "quantity": position.quantity, "avg_entry": position.avg_entry,
            "realized_pnl": position.realized_pnl, "backend": backend,
        })
        self._store.upsert_position(snapshot.to_dict())
        return snapshot

    def position(self, instrument: str) -> Optional[PositionSnapshot]:
        entry = self._positions.get(instrument)
        if not entry or entry.quantity == 0:
            return None
        return PositionSnapshot.create({"instrument": instrument, "quantity": entry.quantity, "avg_entry": entry.avg_entry, "realized_pnl": entry.realized_pnl, "backend": entry.backend})

    def open_positions(self) -> list[PositionSnapshot]:
        return [self.position(instrument) for instrument, position in self._positions.items() if position.quantity != 0]
