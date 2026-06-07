"""StateFrame assembly + the divergence math (matches the frontend contract)."""

from __future__ import annotations

DIVERGE_THRESHOLD = 0.05


def build_state_frame(
    t: float,
    our_prob: float,
    market_prob: float,
    delta: float,
    drivers: list[dict],
    subsignals: dict,
    outcome_label: str,
) -> dict:
    lead = our_prob - market_prob
    return {
        "t": round(t, 2),
        "our_prob": round(our_prob, 4),
        "market_prob": round(market_prob, 4),
        "lead": round(lead, 4),
        "diverging": abs(lead) >= DIVERGE_THRESHOLD,
        "delta": round(delta, 4),
        "drivers": drivers,
        "subsignals": subsignals,
        "outcome_label": outcome_label,
    }
