"""
Self-fact checker — the buzzer brain for the live mic page.

Optimised for SPEED (it has to interrupt mid-sentence): Moss retrieves the
relevant personal fact, then a deterministic value comparison decides — no LLM in
the hot path. Moss is genuinely doing the retrieval, live, on every utterance.
"""

from __future__ import annotations

import asyncio
import json
import os
import re

from .moss_store import FactStore

JUDGE_TIMEOUT = float(os.getenv("TELL_SELFJUDGE_TIMEOUT", "5"))

ROAST_SYSTEM = """You are TELL's savage sidekick. Someone just said something FALSE about themselves
and got buzzed. Fire back ONE short line (max 14 words) that is cocky, sarcastic, and jokingly rude —
roast them for the lie. You can be a little crude and casual (lmao, bro, nice try, sure buddy) but keep
it funny, not genuinely cruel. Second or third person. No quotes, no emojis, just the line."""

JUDGE_SYSTEM = """You are TELL, a real-time self-fact-checker. Someone is speaking ABOUT THEMSELVES.
You are given their spoken statement and VERIFIED REFERENCE FACTS about that exact person.
Decide whether the statement is false.

Return STRICT JSON only:
{"verdict": "false" | "true" | "unverified",
 "claim": "<the self-claim in <=12 words>",
 "correction": "<the true fact with specifics, <=20 words; empty unless false>",
 "confidence": <0..1>}

Rules:
- "false" ONLY if it clearly contradicts a reference fact (wrong name, age, birthplace,
  school, company, etc.). Wrong specifics = false.
- "true" if a reference fact supports it.
- "unverified" if the facts don't address it, or it's an opinion/greeting/filler.
- Be fast and decisive. Do not invent facts beyond the references."""


class SelfChecker:
    def __init__(self, scenario: str = "self_logan"):
        self.store = FactStore(scenario, index_name=f"tell-{scenario}")
        # fastest available model on the gateway for the general fallback path
        self.model = os.getenv("TELL_FAST_MODEL", "openai/gpt-4o-mini")
        self._llm = None
        base, key = os.getenv("TELL_LLM_BASE_URL"), os.getenv("TELL_LLM_API_KEY")
        if base and key:
            try:
                from openai import AsyncOpenAI

                self._llm = AsyncOpenAI(base_url=base, api_key=key, timeout=JUDGE_TIMEOUT)
            except Exception as e:
                print(f"[selfjudge] LLM unavailable: {e}")

    async def ensure(self):
        await self.store.ensure_index(rebuild=True)

    async def judge(self, text: str) -> dict:
        """General path: Moss-retrieve relevant dossier facts, LLM-judge any statement."""
        text = (text or "").strip()
        if len(text) < 4:
            return {"verdict": "unverified", "text": text}
        facts = await self.store.retrieve(text, top_k=4)
        via = "moss" if self.store.using_moss else "local"
        if not self._llm or not facts:
            return {"verdict": "unverified", "text": text, "via": via}

        refs = "\n".join(f"- {f['text']}" for f in facts)
        user = f'STATEMENT: "{text}"\n\nREFERENCE FACTS:\n{refs}\n\nReturn the JSON now.'
        try:
            resp = await asyncio.wait_for(
                self._llm.chat.completions.create(
                    model=self.model, temperature=0.0, max_tokens=70,
                    messages=[{"role": "system", "content": JUDGE_SYSTEM},
                              {"role": "user", "content": user}],
                ),
                timeout=JUDGE_TIMEOUT,
            )
            raw = resp.choices[0].message.content or ""
            raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
            data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
        except Exception as e:
            print(f"[selfjudge] {e}")
            return {"verdict": "unverified", "text": text, "via": via}

        verdict = str(data.get("verdict", "unverified")).lower()
        if verdict not in {"false", "true", "unverified"}:
            verdict = "unverified"
        return {
            "verdict": verdict,
            "claim": str(data.get("claim", text))[:120],
            "correction": str(data.get("correction", ""))[:200],
            "confidence": float(data.get("confidence", 0.5)),
            "fact": facts[0]["text"],
            "via": via,
            "text": text,
        }

    @property
    def fields(self) -> list[dict]:
        return [
            {"field": f["metadata"].get("field"), "value": f["metadata"].get("value")}
            for f in self.store.facts
        ]

    @property
    def all_facts(self) -> list[dict]:
        return [
            {
                "field": f["metadata"].get("field"),
                "value": f["metadata"].get("value"),
                "text": f["text"],
                "topic": f["metadata"].get("topic"),
            }
            for f in self.store.facts
        ]

    async def roast(self, claim: str, correction: str) -> dict:
        """One short, cocky, jokingly-rude line about the false claim (for TTS)."""
        fallback = "yeah, that's not true. nice try, champ."
        if not self._llm:
            return {"line": fallback}
        user = (
            f'They just falsely claimed: "{claim}". The actual truth: {correction or "the opposite"}. '
            "Roast them for it in ONE short line."
        )
        try:
            resp = await asyncio.wait_for(
                self._llm.chat.completions.create(
                    model=self.model, temperature=0.9, max_tokens=40,
                    messages=[{"role": "system", "content": ROAST_SYSTEM},
                              {"role": "user", "content": user}],
                ),
                timeout=5,
            )
            line = (resp.choices[0].message.content or fallback).strip().strip('"').strip()
            return {"line": line or fallback}
        except Exception as e:
            print(f"[roast] {e}")
            return {"line": fallback}

    async def check(self, field: str, value: str, text: str = "") -> dict:
        value = (value or "").strip()
        query = text or f"{field} {value}".strip()
        facts = await self.store.retrieve(query, top_k=3)
        via = "moss" if self.store.using_moss else "local"

        # find a retrieved fact for the asserted field
        match = None
        for f in facts:
            if f.get("metadata", {}).get("field") == field:
                match = f
                break
        if not match:
            return {"field": field, "said": value, "verdict": "unknown", "via": via}

        md = match["metadata"]
        expected = md.get("value", "")
        aliases = [str(a).lower() for a in (md.get("aliases") or [expected]) if a]
        said = value.lower()
        ok = any(said == a or (len(said) >= 3 and (said in a or a in said)) for a in aliases)

        return {
            "field": field,
            "said": value,
            "expected": expected,
            "verdict": "true" if ok else "false",
            "correction": "" if ok else f"Your {field} is {expected}, not {value}.",
            "fact": match["text"],
            "score": match.get("score"),
            "via": via,
        }
