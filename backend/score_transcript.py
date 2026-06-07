"""
Phase-1 de-risk: prove the brain on a STATIC transcript before any real-time wiring.

Feeds a scenario's authored captions to the Scorer chunk-by-chunk and prints the
ScoreUpdate JSON for each tick. With TELL_LLM_* set it exercises MiniMax via the
Truefoundry gateway; without keys it shows the carry-forward behaviour.

    python score_transcript.py fomc_2026_03
"""

from __future__ import annotations

import asyncio
import json
import sys

from modes import Scenario
from pipeline.scoring import Scorer, ScoringContext


async def main(scenario_id: str):
    scn = Scenario(scenario_id)
    scorer = Scorer()
    ctx = ScoringContext(
        rubric_id=scn.config["rubric_id"],
        outcome_label=scn.outcome_label,
        prev_prob=scn.run[0]["our_prob"],
    )
    print(f"# scenario: {scenario_id}  outcome: {scn.outcome_label!r}")
    print(f"# scorer live: {scorer.live}  (set TELL_LLM_* to enable MiniMax)\n")

    # walk the clock at the scoring cadence, scoring the trailing window each time
    t = 0.0
    while t <= scn.duration:
        window = scn.captions.window(t)
        if window:
            update = await scorer.score(ctx, window, t)
            ctx.prev_prob = update["our_prob"]
            if update["drivers"] or scorer.live:
                print(json.dumps({k: update[k] for k in ("t", "our_prob", "delta", "drivers")}))
        t += 3.0


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 else "fomc_2026_03"
    asyncio.run(main(sid))
