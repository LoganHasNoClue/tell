#!/usr/bin/env python3
"""
Run the fact-check pipeline over a scenario's real transcript and write the
computed verdicts to frontend/public/scenarios/<id>/factcheck.json.

Retrieval = Moss when MOSS_PROJECT_ID/KEY are set, else a local fallback.
Judgment = the LLM via the Truefoundry gateway (TELL_LLM_*).
Verdicts are REAL (computed at runtime), then replayed in the UI in sync with the
video — the same "compute live, replay for reliability" pattern used elsewhere.

    python tools/run_factcheck.py debate_biden_2024
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

try:
    from dotenv import load_dotenv

    load_dotenv(BACKEND / ".env")
except Exception:
    pass

from factcheck.pipeline import FactCheckPipeline, build_claims  # noqa: E402

FRONT = ROOT / "frontend" / "public" / "scenarios"
BACK = BACKEND / "scenarios"


async def main(scenario_id: str):
    caps = json.loads((BACK / scenario_id / "captions.json").read_text())
    claims = build_claims(caps)
    pipe = FactCheckPipeline(scenario_id, use_cache=True)
    await pipe.ensure_ready()
    print(f"# scenario: {scenario_id}")
    print(f"# pipeline mode: {pipe.mode}  ({len(claims)} claims)\n")

    out = []
    counts = {"true": 0, "misleading": 0, "false": 0, "unverified": 0, "opinion": 0}
    for i, cl in enumerate(claims):
        v = await pipe.check(cl["text"])
        counts[v["verdict"]] = counts.get(v["verdict"], 0) + 1
        rec = {
            "i": i, "t": cl["t"], "t_end": cl["t_end"], "text": cl["text"],
            "checkable": v.get("checkable", False), "verdict": v["verdict"],
            "claim": v.get("claim", ""), "correction": v.get("correction", ""),
            "confidence": v.get("confidence", 0.0), "source": v.get("source", ""),
            "source_url": v.get("source_url", ""), "topic": v.get("topic", ""),
        }
        out.append(rec)
        if v["verdict"] in ("false", "misleading"):
            print(f"  t={cl['t']:6.1f} [{v['verdict'].upper():10}] {v.get('claim','')[:54]}")
            if v.get("correction"):
                print(f"           ↳ {v['correction'][:80]}")

    payload = {
        "scenario": scenario_id,
        "mode": pipe.mode,
        "totals": counts,
        "checked": sum(counts.values()),
        "flagged": counts.get("false", 0) + counts.get("misleading", 0),
        "claims": out,
    }
    for base in (FRONT, BACK):
        d = base / scenario_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "factcheck.json").write_text(json.dumps(payload, indent=2))

    print(f"\n✓ {payload['checked']} claims checked · "
          f"{counts['false']} false · {counts['misleading']} misleading · "
          f"{counts['true']} true")
    print(f"  wrote factcheck.json (mode: {pipe.mode})")


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 else "debate_biden_2024"
    asyncio.run(main(sid))
