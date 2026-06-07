"""
Fact retrieval layer.

PRIMARY: Moss (https://www.moss.dev) — a real-time semantic search runtime. We
build an index from the ground-truth fact base and query it per spoken claim.

FALLBACK: a lightweight local keyword retriever, used only when MOSS_PROJECT_ID /
MOSS_PROJECT_KEY are not set — so the pipeline runs end-to-end before the Moss
credentials are wired. Same interface either way.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

FACTS_DIR = Path(__file__).parent / "facts"


def _load_facts(scenario_id: str) -> list[dict]:
    data = json.loads((FACTS_DIR / f"{scenario_id}.json").read_text())
    return data["facts"]


_TOKEN = re.compile(r"[a-z0-9]+")


def _tokens(s: str) -> set[str]:
    stop = {"the", "a", "an", "of", "to", "in", "is", "was", "and", "that", "it",
            "he", "we", "i", "for", "on", "with", "his", "her", "our", "are",
            "as", "at", "by", "be", "this", "you", "they", "have", "has", "had"}
    return {w for w in _TOKEN.findall(s.lower()) if w not in stop and len(w) > 2}


class FactStore:
    def __init__(self, scenario_id: str, index_name: str | None = None):
        self.scenario_id = scenario_id
        self.facts = _load_facts(scenario_id)
        self.by_id = {f["id"]: f for f in self.facts}
        self.index_name = index_name or f"tell-{scenario_id}"
        self.project_id = os.getenv("MOSS_PROJECT_ID")
        self.project_key = os.getenv("MOSS_PROJECT_KEY")
        self._client = None
        self._ready = False

    @property
    def using_moss(self) -> bool:
        return bool(self.project_id and self.project_key)

    async def ensure_index(self, rebuild: bool = False):
        """Create (if needed) and load the Moss index. No-op for local fallback."""
        if not self.using_moss:
            self._ready = True
            return "local"
        from moss import MossClient, DocumentInfo

        self._client = MossClient(self.project_id, self.project_key)

        def _str_meta(meta: dict) -> dict:
            # Moss metadata values must be strings; we keep the rich (list) metadata
            # locally in self.by_id and only send a stringified copy to the index.
            out = {}
            for k, v in (meta or {}).items():
                out[k] = ", ".join(map(str, v)) if isinstance(v, list) else str(v)
            return out

        docs = [
            DocumentInfo(id=f["id"], text=f["text"], metadata=_str_meta(f.get("metadata", {})))
            for f in self.facts
        ]
        try:
            await self._client.create_index(self.index_name, docs, "moss-minilm")
        except Exception as e:
            # index likely already exists — that's fine unless caller forced rebuild
            if rebuild:
                try:
                    await self._client.delete_index(self.index_name)
                    await self._client.create_index(self.index_name, docs, "moss-minilm")
                except Exception as e2:
                    print(f"[moss] rebuild failed: {e2}")
            else:
                print(f"[moss] create_index note: {e}")
        try:
            await self._client.load_index(self.index_name)
        except Exception as e:
            print(f"[moss] load_index note: {e}")
        self._ready = True
        return "moss"

    async def retrieve(self, claim: str, top_k: int = 3) -> list[dict]:
        """Return [{id, text, score, metadata}] most relevant to the claim."""
        if not self._ready:
            await self.ensure_index()

        if self.using_moss and self._client:
            try:
                from moss import QueryOptions

                res = await self._client.query(
                    self.index_name, claim, QueryOptions(top_k=top_k, alpha=0.6)
                )
                out = []
                for d in res.docs:
                    meta = self.by_id.get(d.id, {}).get("metadata", {})
                    out.append({"id": d.id, "text": d.text, "score": float(d.score), "metadata": meta})
                return out
            except Exception as e:
                print(f"[moss] query failed, using local fallback: {e}")

        # local fallback: token-overlap scoring
        q = _tokens(claim)
        scored = []
        for f in self.facts:
            ft = _tokens(f["text"])
            if not ft:
                continue
            overlap = len(q & ft)
            score = overlap / (len(q) ** 0.5 + 1e-6)
            scored.append((score, f))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [
            {"id": f["id"], "text": f["text"], "score": round(s, 3), "metadata": f.get("metadata", {})}
            for s, f in scored[:top_k]
            if s > 0
        ]
