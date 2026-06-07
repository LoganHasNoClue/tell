# TELL — live fact-check

**TELL watches a live (or replayed) debate and fact-checks it in real time.** As
each sentence is spoken it retrieves ground-truth facts with **Moss** semantic
search, judges the claim with an LLM, and pops a card the instant something is
**false or misleading** — with the correction, the source, and a running counter.

> Read the truth in real time.

---

## What it does

- Plays the event video (a real debate) center stage.
- Continuously turns speech into claims, **retrieves matching facts from a
  ground-truth fact base via Moss**, and has the LLM rule each claim
  **true / misleading / false / unverified**.
- Surfaces a **liquid-glass popup** for every false/misleading claim, keeps a
  **live counter**, and logs every verdict — each with a real source.

On the June 27, 2024 Biden–Trump debate (first 12 min): **158 claims checked →
15 false, 17 misleading, 26 true** (e.g. *"largest tax cut in history"* → FALSE;
the 2017 cut was ~$1.5T and not the largest).

## How it works

```
 VIDEO ──▶ transcript ──▶ claim ──▶ [ Moss retrieval ] ──▶ [ LLM judge ] ──▶ verdict
 (real Whisper STT)        (sentence)   (ground-truth facts)   (Truefoundry)    + correction + source
                                                                                     │
                                                                            popup + counter + log
```

- **Fact base** — `backend/factcheck/facts/<scenario>.json`: verified facts with
  sources (BLS, CBO, JCT, CDC, Federal Reserve…).
- **Retrieval (Moss)** — `backend/factcheck/moss_store.py`: builds a Moss index
  from the fact base and `query()`s it per claim. Falls back to a local keyword
  retriever only if `MOSS_PROJECT_ID` / `MOSS_PROJECT_KEY` are unset.
- **Judge** — `backend/factcheck/checker.py`: MiniMax/`gpt-4.1-mini` via the
  Truefoundry gateway, strict JSON, hard timeout, carry-forward.
- **Pipeline** — `backend/factcheck/pipeline.py`: claim grouping + retrieve +
  judge + on-disk cache.

### Two modes (toggle, top-right)
- **REPLAY** (default) — plays a precomputed verification run
  (`frontend/public/scenarios/<id>/factcheck.json`). Reliable, offline-safe.
- **LIVE** — verifies each claim against the backend (`POST /api/check`) in real
  time as it's spoken. Genuinely constant retrieval, computed at runtime.

Either way the verdicts are **real** (Moss + LLM), never hand-authored.

## Run it

```bash
# 1. backend (retrieval + judging)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # set TELL_LLM_* (Truefoundry) and MOSS_PROJECT_ID/KEY
uvicorn main:app --port 8000

# 2. compute the verification run (builds the Moss index, checks every claim)
python ../tools/run_factcheck.py debate_biden_2024

# 3. frontend
cd ../frontend
pnpm install
pnpm dev                    # http://localhost:3000  → press space
```

Toggle **LIVE** (top-right) to verify claims against the backend in real time;
leave on **REPLAY** for the offline-safe precomputed run.

## Design

Minimalist, dark, light accents. **Liquid glass / iOS** components (frosted blur,
hairline borders, rounded, SF type, spring motion). **No gradients.** Video-first
layout: footage center, flagged-claim popups over it, counter + live log in a
glass sidebar, a "Checking claim…" scanning state, and a *Retrieval by Moss* mark.

## Tech

Next.js · React · TypeScript · Tailwind · Framer Motion · Zustand · FastAPI ·
**Moss** semantic search · MiniMax/`gpt-4.1-mini` via **Truefoundry** ·
faster-whisper STT · real debate footage + real Polymarket data (legacy mode).

## Adding a scenario

1. Ingest a clip: `python tools/ingest_video.py --file <mp4> --id <id> ...`
   (real Whisper transcript + scenario config).
2. Write `backend/factcheck/facts/<id>.json` (the ground-truth facts).
3. `python tools/run_factcheck.py <id>` → builds the Moss index + verdicts.

---

*Claims are verified live against a curated ground-truth fact base. Retrieval by
Moss; judgment by LLM. Informational.*
