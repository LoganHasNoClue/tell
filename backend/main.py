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

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
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
