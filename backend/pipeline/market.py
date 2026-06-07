"""
Market feed.

Demo mode: read market_odds.csv (t,market_prob) and step it forward against the
video clock — this is how we guarantee an honest, repeatable "our line vs their
line."

Live mode (stretch): poll Polymarket (Gamma/CLOB) or Kalshi for the chosen
market's mid price. Endpoints change — VERIFY against current docs before the
demo; we keep this behind a flag and always fall back to the CSV.
"""

from __future__ import annotations

import csv
from bisect import bisect_right
from pathlib import Path


class MarketFeed:
    def __init__(self, csv_path: str | Path):
        self.ts: list[float] = []
        self.ps: list[float] = []
        with open(csv_path) as f:
            for row in csv.DictReader(f):
                self.ts.append(float(row["t"]))
                self.ps.append(float(row["market_prob"]))

    def at(self, t: float) -> float:
        """Linear-interpolated market probability at time t."""
        if not self.ts:
            return 0.5
        if t <= self.ts[0]:
            return self.ps[0]
        if t >= self.ts[-1]:
            return self.ps[-1]
        i = bisect_right(self.ts, t)
        t0, t1 = self.ts[i - 1], self.ts[i]
        p0, p1 = self.ps[i - 1], self.ps[i]
        f = (t - t0) / (t1 - t0 or 1)
        return p0 + (p1 - p0) * f


# --- live polling stub (kept simple + behind a flag) -------------------------
async def poll_polymarket(token_id: str) -> float | None:
    """
    Best-effort live mid-price for a Polymarket CLOB token. Returns None on any
    failure so the caller falls back to the CSV. Verify the endpoint/params
    against current Polymarket docs before relying on this in a live run.
    """
    try:
        import httpx

        url = "https://clob.polymarket.com/midpoint"
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(url, params={"token_id": token_id})
            r.raise_for_status()
            return float(r.json()["mid"])
    except Exception as e:
        print(f"[market] live poll failed, using CSV: {e}")
        return None
