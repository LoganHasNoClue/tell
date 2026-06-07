"""
Self-fact checker — the buzzer brain for the live mic page.

Optimised for SPEED (it has to interrupt mid-sentence): Moss retrieves the
relevant personal fact, then a deterministic value comparison decides — no LLM in
the hot path. Moss is genuinely doing the retrieval, live, on every utterance.
"""

from __future__ import annotations

from .moss_store import FactStore


class SelfChecker:
    def __init__(self, scenario: str = "self_logan"):
        self.store = FactStore(scenario, index_name=f"tell-{scenario}")

    async def ensure(self):
        await self.store.ensure_index(rebuild=True)

    @property
    def fields(self) -> list[dict]:
        return [
            {"field": f["metadata"].get("field"), "value": f["metadata"].get("value")}
            for f in self.store.facts
        ]

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
