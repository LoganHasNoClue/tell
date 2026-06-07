"""
TELL backend — FastAPI app hosting the WebSocket that streams StateFrames.

Run:  uvicorn main:app --reload --port 8000

The frontend is fully self-sufficient in demo mode (it has its own replay engine),
so this server is the "real pipeline" path: connect the UI to ws://host/ws and it
streams frames from here instead — demo replay by default, or live MiniMax scoring
when TELL_LLM_* env vars are set. Same StateFrame contract either way.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import os
import tempfile

from fastapi import Body, FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except Exception:
    pass

from modes import DemoReplay, LivePipeline, Scenario
from factcheck.pipeline import FactCheckPipeline, build_claims

SCENARIO_DIR = Path(__file__).parent / "scenarios"
TICK_HZ = 15.0

app = FastAPI(title="TELL")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if SCENARIO_DIR.exists():
    app.mount("/scenarios", StaticFiles(directory=str(SCENARIO_DIR)), name="scenarios")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/scenarios")
def scenarios():
    idx = SCENARIO_DIR / "index.json"
    return JSONResponse(json.loads(idx.read_text()) if idx.exists() else [])


# ---- Live fact-check (Moss retrieval + LLM judgment, computed on demand) ----
_pipes: dict[str, FactCheckPipeline] = {}


async def _get_pipe(scenario_id: str) -> FactCheckPipeline:
    if scenario_id not in _pipes:
        # use_cache=False => the live endpoint queries Moss + the LLM for every
        # claim at runtime (no pre-loaded verdicts). This is the real-time path.
        p = FactCheckPipeline(scenario_id, use_cache=False)
        await p.ensure_ready()
        _pipes[scenario_id] = p
    return _pipes[scenario_id]


@app.get("/api/factcheck/{scenario_id}/status")
async def factcheck_status(scenario_id: str):
    p = await _get_pipe(scenario_id)
    return {"scenario": scenario_id, "mode": p.mode, "using_moss": p.store.using_moss}


@app.post("/api/check")
async def api_check(payload: dict = Body(...)):
    """Verify a single spoken claim live: Moss retrieve -> LLM judge. Cached."""
    scenario_id = payload.get("scenario", "debate_biden_2024")
    text = (payload.get("text") or "").strip()
    if not text:
        return {"verdict": "unverified", "checkable": False}
    p = await _get_pipe(scenario_id)
    return await p.check(text)


@app.get("/api/claims/{scenario_id}")
async def api_claims(scenario_id: str):
    """The sentence-level claims for a scenario, keyed to the video clock."""
    caps = json.loads((SCENARIO_DIR / scenario_id / "captions.json").read_text())
    return {"scenario": scenario_id, "claims": build_claims(caps)}


# ---- Live mic self-fact-check (fast path: Moss retrieval, no LLM) ----
_self_checker = None


async def _get_self():
    global _self_checker
    if _self_checker is None:
        from factcheck.self import SelfChecker

        _self_checker = SelfChecker()
        await _self_checker.ensure()
    return _self_checker


@app.get("/api/selffacts")
async def api_selffacts():
    sc = await _get_self()
    return {"fields": sc.fields, "facts": sc.all_facts, "using_moss": sc.store.using_moss}


@app.post("/api/roast")
async def api_roast(payload: dict = Body(...)):
    """A short, cocky one-liner about a false claim (spoken by the voice agent)."""
    sc = await _get_self()
    return await sc.roast(payload.get("claim", ""), payload.get("correction", ""))


# ---- Live transcription of the playing video's audio (real STT, no precompute) ----
_whisper = None


def _get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel("base.en", device="cpu", compute_type="int8")
    return _whisper


# Hosted STT preference: Groq whisper-large-v3-turbo (fastest + accurate) ->
# OpenAI gpt-4o-mini-transcribe -> local faster-whisper base.en (fallback).
def _hosted_stt():
    groq = os.getenv("GROQ_API_KEY")
    if groq:
        return ("https://api.groq.com/openai/v1", groq, os.getenv("TELL_STT_MODEL", "whisper-large-v3-turbo"))
    oai = os.getenv("OPENAI_API_KEY")
    if oai:
        return ("https://api.openai.com/v1", oai, os.getenv("TELL_STT_MODEL", "gpt-4o-mini-transcribe"))
    return None


def _transcribe_file(path: str) -> str:
    hosted = _hosted_stt()
    if hosted:
        base, key, model = hosted
        try:
            from openai import OpenAI

            client = OpenAI(base_url=base, api_key=key, timeout=15)
            with open(path, "rb") as f:
                out = client.audio.transcriptions.create(
                    model=model, file=f, language="en", response_format="text"
                )
            return (out if isinstance(out, str) else getattr(out, "text", "")).strip()
        except Exception as e:
            print(f"[transcribe] hosted STT failed ({model}), falling back to local: {e}")
    model = _get_whisper()
    segments, _ = model.transcribe(path, language="en", beam_size=1, vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()


@app.post("/api/transcribe")
async def api_transcribe(audio: UploadFile = File(...)):
    """Transcribe one short audio chunk captured live from the playing video."""
    data = await audio.read()
    if len(data) < 1500:
        return {"text": ""}
    suffix = ".webm" if "webm" in (audio.content_type or "") else ".bin"
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        text = await asyncio.to_thread(_transcribe_file, path)
        return {"text": text}
    except Exception as e:
        print(f"[transcribe] {e}")
        return {"text": ""}
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


@app.post("/api/selfcheck")
async def api_selfcheck(payload: dict = Body(...)):
    """Instant path: verify a structured self-claim (field+value) via Moss. ~ms."""
    sc = await _get_self()
    return await sc.check(
        payload.get("field", ""), payload.get("value", ""), payload.get("text", "")
    )


@app.post("/api/selfjudge")
async def api_selfjudge(payload: dict = Body(...)):
    """General path: judge ANY spoken self-statement against the dossier (Moss + LLM)."""
    sc = await _get_self()
    return await sc.judge(payload.get("text", ""))


class Session:
    """Owns the clock + engine for one WS connection."""

    def __init__(self, scenario_id: str, mode: str):
        self.scenario = Scenario(scenario_id)
        self.mode = mode
        self.t = 0.0
        self.prev_t = 0.0
        self.playing = False
        if mode == "live":
            self.engine = LivePipeline(self.scenario)
            self.demo = None
        else:
            self.demo = DemoReplay(self.scenario)
            self.demo.reset_from(0.0)
            self.engine = None

    @property
    def effective_mode(self) -> str:
        # live falls back to demo if no LLM client is configured
        if self.mode == "live" and self.engine and not self.engine.live:
            return "live(carry)"
        return self.mode

    def meta(self) -> dict:
        c = self.scenario.config
        return {
            "type": "meta",
            "scenario": c["id"],
            "mode": self.effective_mode,
            "duration": self.scenario.duration,
            "outcome_label": c["outcome_label"],
            "hero_label": c["hero_label"],
            "lead_time_s": c.get("lead_time_s"),
            "model_label": c.get("model_label"),
        }

    def seek(self, t: float):
        t = max(0.0, min(self.scenario.duration, t))
        self.t = t
        self.prev_t = t
        if self.demo:
            self.demo.reset_from(t)

    async def next_frame(self) -> dict:
        if self.demo:
            drivers = self.demo.drivers_between(self.prev_t, self.t)
            frame = self.demo.frame(self.t, drivers)
        else:
            frame = await self.engine.step(self.prev_t, self.t)
        frame["type"] = "frame"
        self.prev_t = self.t
        return frame


async def _control_loop(ws: WebSocket, sess: Session):
    """Handle inbound control messages."""
    while True:
        raw = await ws.receive_text()
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        cmd = msg.get("cmd")
        if cmd == "play":
            if sess.t >= sess.scenario.duration:
                sess.seek(0.0)
            sess.playing = True
        elif cmd == "pause":
            sess.playing = False
        elif cmd == "seek":
            sess.seek(float(msg.get("t", 0.0)))
        elif cmd == "restart":
            sess.seek(0.0)
            sess.playing = True


async def _clock_loop(ws: WebSocket, sess: Session):
    """Advance the master clock and stream frames."""
    dt = 1.0 / TICK_HZ
    last = time.monotonic()
    while True:
        now = time.monotonic()
        elapsed = now - last
        last = now
        if sess.playing:
            sess.t = min(sess.scenario.duration, sess.t + elapsed)
            frame = await sess.next_frame()
            await ws.send_text(json.dumps(frame))
            if sess.t >= sess.scenario.duration:
                sess.playing = False
        await asyncio.sleep(dt)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        init = json.loads(await ws.receive_text())
        sess = Session(init.get("scenario", "fomc_2026_03"), init.get("mode", "demo"))
    except Exception as e:
        await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        await ws.close()
        return

    await ws.send_text(json.dumps(sess.meta()))
    # send an initial paused frame so the UI renders immediately
    await ws.send_text(json.dumps(await sess.next_frame()))

    control = asyncio.create_task(_control_loop(ws, sess))
    clock = asyncio.create_task(_clock_loop(ws, sess))
    try:
        await asyncio.gather(control, clock)
    except WebSocketDisconnect:
        pass
    finally:
        control.cancel()
        clock.cancel()
