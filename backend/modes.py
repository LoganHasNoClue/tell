"""
LIVE vs DEMO orchestration.

Both produce the identical StateFrame stream — the frontend never knows which
one is feeding it. DEMO replays the precomputed run (zero network, stage-safe).
LIVE runs the real pipeline: captions/STT -> Scorer (MiniMax via Truefoundry)
-> market feed, with carry-forward so it never blanks.
"""

from __future__ import annotations

import json
from bisect import bisect_right
from pathlib import Path

from pipeline.market import MarketFeed
from pipeline.scoring import Scorer, ScoringContext
from pipeline.state import build_state_frame
from pipeline.stt import CaptionTrack

SCENARIO_DIR = Path(__file__).parent / "scenarios"


class Scenario:
    def __init__(self, scenario_id: str):
        d = SCENARIO_DIR / scenario_id
        self.id = scenario_id
        self.config = json.loads((d / "scenario.json").read_text())
        self.run = json.loads((d / "run.json").read_text())
        self.market = MarketFeed(d / "market_odds.csv")
        self.captions = CaptionTrack(d / "captions.json")
        self.duration = float(self.config["duration"])
        self.outcome_label = self.config["outcome_label"]
        # index run timestamps for fast lookup
        self._ts = [u["t"] for u in self.run]

    def _interp_prob(self, t: float) -> float:
        ts = self._ts
        if t <= ts[0]:
            return self.run[0]["our_prob"]
        if t >= ts[-1]:
            return self.run[-1]["our_prob"]
        i = bisect_right(ts, t)
        u0, u1 = self.run[i - 1], self.run[i]
        f = (t - u0["t"]) / ((u1["t"] - u0["t"]) or 1)
        return u0["our_prob"] + (u1["our_prob"] - u0["our_prob"]) * f

    def _sub_at(self, t: float) -> dict:
        ts = self._ts
        i = max(0, bisect_right(ts, t) - 1)
        return self.run[i]["subsignals"]


class DemoReplay:
    """Precomputed replay — the safety net."""

    def __init__(self, scenario: Scenario):
        self.s = scenario
        self._fired: set[int] = set()

    def reset_from(self, t: float):
        self._fired = {i for i, u in enumerate(self.s.run) if u["t"] <= t and u["drivers"]}

    def drivers_between(self, prev_t: float, t: float) -> list[dict]:
        out = []
        for i, u in enumerate(self.s.run):
            if prev_t < u["t"] <= t and u["drivers"] and i not in self._fired:
                self._fired.add(i)
                out.extend(u["drivers"])
        return out

    def frame(self, t: float, drivers: list[dict]) -> dict:
        our = self.s._interp_prob(t)
        prev = self.s._interp_prob(max(0.0, t - 2.0))
        return build_state_frame(
            t,
            our,
            self.s.market.at(t),
            our - prev,
            drivers,
            self.s._sub_at(t),
            self.s.outcome_label,
        )


class LivePipeline:
    """
    Real-time scoring against the bundled clip. Uses authored captions as the
    finalized STT segment source (swap in DeepgramStream for live audio). Scores
    on a ~3s cadence; carries forward the last good probability on any failure.
    """

    def __init__(self, scenario: Scenario, cadence: float = 3.0):
        self.s = scenario
        self.scorer = Scorer()
        self.ctx = ScoringContext(
            rubric_id=scenario.config["rubric_id"],
            outcome_label=scenario.outcome_label,
            prev_prob=scenario.run[0]["our_prob"],
        )
        self.cadence = cadence
        self._last_score_t = -999.0
        self._last_frame_sub = {"hawk_dove": None, "hedging": None, "momentum": None}

    @property
    def live(self) -> bool:
        return self.scorer.live

    async def step(self, prev_t: float, t: float) -> dict:
        """Advance the clock; score if the cadence elapsed. Returns a StateFrame."""
        drivers: list[dict] = []
        if t - self._last_score_t >= self.cadence:
            self._last_score_t = t
            window = self.s.captions.window(t)
            if window:
                update = await self.scorer.score(self.ctx, window, t)
                self.ctx.prev_prob = update["our_prob"]
                drivers = update["drivers"]
                if any(v is not None for v in update["subsignals"].values()):
                    self._last_frame_sub = update["subsignals"]
                # keep a short running summary for context (cheap, incremental)
                if drivers:
                    self.ctx.summary = (self.ctx.summary + " " + drivers[0]["quote"])[-600:]

        our = self.ctx.prev_prob
        return build_state_frame(
            t,
            our,
            self.s.market.at(t),
            0.0,  # delta is computed UI-side from the line for the live path
            drivers,
            self._last_frame_sub,
            self.s.outcome_label,
        )
