"""
Fact-check pipeline: transcript -> claims -> (Moss retrieve) -> (LLM judge) -> verdict.

`build_claims` merges the raw STT fragments into sentence-level claims keyed to the
video clock. `FactCheckPipeline.check` runs retrieval + judgment for one claim, with
an on-disk cache so a scenario is computed live ONCE and replays instantly offline.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .checker import Checker
from .moss_store import FactStore

CACHE_DIR = Path(__file__).parent / "cache"
SENT_END = (".", "?", "!")


def build_claims(captions: list[dict], max_chars: int = 240) -> list[dict]:
    """Merge raw caption fragments into sentence-level claims with start/end times."""
    claims: list[dict] = []
    buf: list[str] = []
    start_t = None
    last_t = None
    for c in captions:
        text = c["text"].strip()
        if not text:
            continue
        if start_t is None:
            start_t = c["t"]
        buf.append(text)
        last_t = c["t"]
        joined = " ".join(buf).strip()
        if joined.endswith(SENT_END) or len(joined) >= max_chars:
            claims.append({"t": round(start_t, 2), "t_end": round(last_t, 2), "text": joined})
            buf, start_t = [], None
    if buf and start_t is not None:
        claims.append({"t": round(start_t, 2), "t_end": round(last_t or start_t, 2), "text": " ".join(buf).strip()})
    return claims


class FactCheckPipeline:
    def __init__(self, scenario_id: str, use_cache: bool = True):
        self.scenario_id = scenario_id
        self.store = FactStore(scenario_id)
        self.checker = Checker()
        self.use_cache = use_cache
        self.cache_path = CACHE_DIR / f"{scenario_id}.json"
        self._cache: dict[str, dict] = {}
        if use_cache and self.cache_path.exists():
            try:
                self._cache = json.loads(self.cache_path.read_text())
            except Exception:
                self._cache = {}

    @property
    def mode(self) -> str:
        retr = "moss" if self.store.using_moss else "local"
        judge = "llm" if self.checker.live else "offline"
        return f"{retr}+{judge}"

    async def ensure_ready(self):
        await self.store.ensure_index()

    @staticmethod
    def _key(text: str) -> str:
        return hashlib.sha1(text.strip().lower().encode()).hexdigest()[:16]

    def _save_cache(self):
        if not self.use_cache:
            return
        CACHE_DIR.mkdir(exist_ok=True)
        self.cache_path.write_text(json.dumps(self._cache, indent=2))

    async def check(self, claim_text: str) -> dict:
        """Retrieve facts for a claim and judge it. Cached by claim text."""
        key = self._key(claim_text)
        if self.use_cache and key in self._cache:
            return self._cache[key]

        facts = await self.store.retrieve(claim_text, top_k=3)
        verdict = await self.checker.judge(claim_text, facts)
        verdict["retrieved"] = [
            {"text": f["text"][:160], "score": f["score"],
             "source": f.get("metadata", {}).get("source", "")}
            for f in facts
        ]
        if self.use_cache:
            self._cache[key] = verdict
            self._save_cache()
        return verdict
