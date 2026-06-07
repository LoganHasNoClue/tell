"""
The fact-check judge.

Given a spoken claim + the ground-truth facts retrieved by Moss, calls the LLM
(MiniMax / gpt-4.1-mini via the Truefoundry gateway) and returns a verdict.
Strict JSON, hard timeout, carry-forward to 'unverified' on any failure so the
live stream never stalls.
"""

from __future__ import annotations

import asyncio
import json
import os
import re

TIMEOUT = float(os.getenv("TELL_FACTCHECK_TIMEOUT", "6"))

SYSTEM = """You are TELL, a real-time fact-checking judge for a live political debate.
You receive ONE spoken claim and a set of VERIFIED REFERENCE FACTS retrieved from a
trusted fact base. Decide whether the claim holds up against those facts.

Return STRICT JSON only, no prose:
{
  "checkable": <true|false>,            // false for opinions, pleasantries, procedure
  "verdict": "true" | "misleading" | "false" | "unverified" | "opinion",
  "claim": "<the core factual assertion in <=14 words>",
  "correction": "<the accurate fact + number, <=24 words; empty if verdict is true/opinion>",
  "confidence": <float 0..1>
}

Rules:
- Judge ONLY against the provided reference facts. If the facts do not address the
  claim, verdict = "unverified" and checkable may still be true.
- "false": contradicts the facts. "misleading": technically defensible but omits/
  distorts context, or wrong magnitude. "true": supported. "opinion": not a factual
  claim (set checkable=false).
- correction must cite the real number/fact from the references, concisely.
- Be decisive but fair; do not invent facts beyond the references."""


class Checker:
    def __init__(self):
        self.model = os.getenv("TELL_LLM_MODEL", "openai/gpt-4.1-mini")
        self.base_url = os.getenv("TELL_LLM_BASE_URL")
        self.api_key = os.getenv("TELL_LLM_API_KEY")
        self._client = None
        if self.base_url and self.api_key:
            try:
                from openai import AsyncOpenAI

                self._client = AsyncOpenAI(base_url=self.base_url, api_key=self.api_key, timeout=TIMEOUT)
            except Exception as e:
                print(f"[checker] LLM client unavailable: {e}")

    @property
    def live(self) -> bool:
        return self._client is not None

    @staticmethod
    def _extract(text: str) -> dict:
        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
        s, e = text.find("{"), text.rfind("}")
        return json.loads(text[s:e + 1])

    async def judge(self, claim: str, facts: list[dict]) -> dict:
        unverified = {
            "checkable": False, "verdict": "unverified", "claim": claim[:80],
            "correction": "", "confidence": 0.0,
        }
        if not self._client or not facts:
            return unverified

        refs = "\n".join(
            f"- {f['text']} (source: {f.get('metadata', {}).get('source', 'n/a')})"
            for f in facts
        )
        user = f"SPOKEN CLAIM:\n\"{claim}\"\n\nREFERENCE FACTS:\n{refs}\n\nReturn the JSON now."
        try:
            resp = await asyncio.wait_for(
                self._client.chat.completions.create(
                    model=self.model, temperature=0.1, max_tokens=220,
                    messages=[{"role": "system", "content": SYSTEM},
                              {"role": "user", "content": user}],
                ),
                timeout=TIMEOUT,
            )
            data = self._extract(resp.choices[0].message.content or "")
        except Exception as e:
            print(f"[checker] carry-forward unverified: {e}")
            return unverified

        verdict = str(data.get("verdict", "unverified")).lower()
        if verdict not in {"true", "misleading", "false", "unverified", "opinion"}:
            verdict = "unverified"
        # attach the best source for display
        src = facts[0].get("metadata", {}) if facts else {}
        return {
            "checkable": bool(data.get("checkable", verdict not in {"opinion"})),
            "verdict": verdict,
            "claim": str(data.get("claim", claim))[:120],
            "correction": str(data.get("correction", ""))[:240],
            "confidence": float(data.get("confidence", 0.5)),
            "source": src.get("source", ""),
            "source_url": src.get("source_url", ""),
            "topic": src.get("topic", ""),
        }
