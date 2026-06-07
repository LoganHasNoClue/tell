"""
TELL scoring engine — the brain.

Calls MiniMax M3 behind the Truefoundry gateway (OpenAI-compatible) with the
mode rubric, low temperature, a hard timeout, and carry-forward on any failure
so the UI is NEVER blanked. Smoothing keeps the line readable.

Reliability contract (01_ARCHITECTURE.md §3, §9):
  - hard-timeout each call (~1.5s); on timeout/parse-fail -> carry previous prob.
  - quotes must be verbatim; we don't trust the model to enforce it, we filter.
  - mild smoothing: move <= MAX_STEP per tick unless a strong driver justifies it.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

RUBRIC_DIR = Path(__file__).parent / "rubrics"
MAX_STEP = 0.08
CALL_TIMEOUT = float(os.getenv("TELL_LLM_TIMEOUT", "1.6"))


def load_rubric(rubric_id: str, outcome_label: str) -> str:
    text = (RUBRIC_DIR / f"{rubric_id}.txt").read_text()
    return text.replace("{outcome_label}", outcome_label)


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _extract_json(text: str) -> dict:
    """Pull the first JSON object out of a model response."""
    text = text.strip()
    # strip code fences if present
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no json object in response")
    return json.loads(text[start : end + 1])


@dataclass
class ScoringContext:
    rubric_id: str
    outcome_label: str
    prev_prob: float = 0.5
    summary: str = ""
    system_prompt: str = field(default="", repr=False)

    def __post_init__(self):
        if not self.system_prompt:
            self.system_prompt = load_rubric(self.rubric_id, self.outcome_label)


class Scorer:
    """
    Wraps the LLM call. Uses the OpenAI SDK pointed at the Truefoundry gateway
    (base_url + api key from env). If the SDK/keys are absent, callers should
    fall back to the precomputed run (demo mode) — this object never raises into
    the stream; on any error it returns the carried-forward previous estimate.
    """

    def __init__(self):
        self.model = os.getenv("TELL_LLM_MODEL", "minimax-m3")
        self.base_url = os.getenv("TELL_LLM_BASE_URL")  # Truefoundry gateway URL
        self.api_key = os.getenv("TELL_LLM_API_KEY")
        self._client = None
        if self.base_url and self.api_key:
            try:
                from openai import AsyncOpenAI

                self._client = AsyncOpenAI(
                    base_url=self.base_url, api_key=self.api_key, timeout=CALL_TIMEOUT
                )
            except Exception as e:  # pragma: no cover
                print(f"[scoring] LLM client unavailable: {e}")

    @property
    def live(self) -> bool:
        return self._client is not None

    async def score(self, ctx: ScoringContext, transcript_window: str, t: float) -> dict:
        """Return a ScoreUpdate dict. Always succeeds (carry-forward on failure)."""
        carry = {
            "t": round(t, 2),
            "our_prob": ctx.prev_prob,
            "delta": 0.0,
            "drivers": [],
            "subsignals": {"hawk_dove": None, "hedging": None, "momentum": None},
            "transcript_window": transcript_window,
        }
        if not self._client:
            return carry

        user = (
            f"SUMMARY SO FAR:\n{ctx.summary or '(none yet)'}\n\n"
            f"RECENT TRANSCRIPT:\n{transcript_window}\n\n"
            f"YOUR PREVIOUS P(OUTCOME): {ctx.prev_prob:.3f}\n\n"
            "Return the strict JSON now."
        )
        try:
            import asyncio

            resp = await asyncio.wait_for(
                self._client.chat.completions.create(
                    model=self.model,
                    temperature=0.2,
                    max_tokens=400,
                    messages=[
                        {"role": "system", "content": ctx.system_prompt},
                        {"role": "user", "content": user},
                    ],
                ),
                timeout=CALL_TIMEOUT,
            )
            raw = resp.choices[0].message.content or ""
            data = _extract_json(raw)
        except Exception as e:
            print(f"[scoring] carry-forward (t={t:.1f}): {e}")
            return carry

        target = _clamp(float(data.get("our_prob", ctx.prev_prob)))
        # smoothing: cap the move unless a high-confidence driver justifies a jump
        drivers = data.get("drivers", []) or []
        strong = any(abs(float(d.get("effect", 0))) >= 0.06 for d in drivers)
        step_cap = MAX_STEP * (2.0 if strong else 1.0)
        move = _clamp(target - ctx.prev_prob, -step_cap, step_cap)
        new_prob = _clamp(ctx.prev_prob + move)

        # enforce verbatim quotes
        clean_drivers = []
        for d in drivers[:2]:
            q = str(d.get("quote", "")).strip()
            if q and q.lower() in transcript_window.lower():
                clean_drivers.append(
                    {
                        "quote": q,
                        "effect": round(float(d.get("effect", 0)), 3),
                        "why": str(d.get("why", ""))[:60],
                    }
                )

        sub = data.get("subsignals", {}) or {}
        return {
            "t": round(t, 2),
            "our_prob": round(new_prob, 4),
            "delta": round(new_prob - ctx.prev_prob, 4),
            "drivers": clean_drivers,
            "subsignals": {
                "hawk_dove": sub.get("hawk_dove"),
                "hedging": sub.get("hedging"),
                "momentum": sub.get("momentum"),
            },
            "transcript_window": transcript_window,
        }
