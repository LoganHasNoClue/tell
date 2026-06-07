"use client";

import { create } from "zustand";

export type Verdict = "true" | "misleading" | "false" | "unverified" | "opinion";

export interface Claim {
  i: number;
  t: number;
  t_end: number;
  text: string;
  checkable: boolean;
  verdict: Verdict;
  claim: string;
  correction: string;
  confidence: number;
  source: string;
  source_url: string;
  topic: string;
  via?: string;
  moss_ms?: number;
}

export interface ScenarioConfig {
  id: string;
  title: string;
  subtitle: string;
  video: string;
  duration: number;
  captions: string;
}

export interface Caption { t: number; speaker: string; text: string; }
export interface Popup { key: number; claim: Claim; bornAt: number; }
export interface Counter { checked: number; false: number; misleading: number; true: number; }

const POPUP_TTL = 9000;
const API = process.env.NEXT_PUBLIC_TELL_API || "http://localhost:8000";

interface FCState {
  status: "idle" | "loading" | "ready" | "error";
  config: ScenarioConfig | null;
  mode: string;
  claims: Claim[]; // precomputed (replay fallback only)
  captions: Caption[];

  playing: boolean;
  t: number;
  duration: number;

  counter: Counter;
  log: Claim[];
  popups: Popup[];
  analyzing: string | null; // text currently being checked
  caption: string;

  live: boolean; // true = real STT of the playing audio; false = precomputed replay
  mossActive: boolean;
  lastMoss: { ms: number; count: number } | null;
  sttUp: boolean; // backend transcription reachable

  videoEl: HTMLVideoElement | null;

  load: (id: string) => Promise<void>;
  setLive: (on: boolean) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (t: number) => void;
  restart: () => void;
  registerVideo: (el: HTMLVideoElement | null) => void;
  dismissPopup: (key: number) => void;
}

let raf = 0;
let lastNow = 0;
let popupKey = 1;
let liveId = 100000;

// --- continuous live audio capture (module-scoped, not reactive) ---
const STT_SR = 16000; // sample rate sent to STT
const WINDOW_S = 5; // seconds of trailing audio re-transcribed each tick
const SLIDE_MS = 1100; // how often we re-transcribe the trailing window (live cadence)
let audioCtx: AudioContext | null = null;
let srcNode: MediaElementAudioSourceNode | null = null;
let srcEl: HTMLVideoElement | null = null;
let workletNode: AudioWorkletNode | null = null;
let capturing = false;
let frames: Float32Array[] = []; // rolling raw-PCM frames (at ctx.sampleRate)
let framesLen = 0;
let ringRate = 48000;
let slideTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let backoffUntil = 0;
let aaiWs: WebSocket | null = null; // AssemblyAI real-time stream (when keyed)
let aaiTurnTimer: ReturnType<typeof setTimeout> | null = null;
let streaming = false;
let judgedTokens: Set<string>[] = []; // token-sets of already-checked sentences

function _tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 2));
}
// already checked if it overlaps a prior sentence a lot (rolling windows repeat)
function _seenBefore(s: string): boolean {
  const t = _tokens(s);
  if (t.size === 0) return true;
  for (const j of judgedTokens) {
    let inter = 0;
    for (const w of t) if (j.has(w)) inter++;
    if (inter / Math.min(t.size, j.size) >= 0.6) return true;
  }
  return false;
}

/** linear-resample a Float32 buffer from srcRate to STT_SR, return Int16 PCM */
function toPcm16(buf: Float32Array, srcRate: number): Int16Array {
  const ratio = srcRate / STT_SR;
  const outLen = Math.floor(buf.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const s = (buf[i0] || 0) * (1 - frac) + (buf[i0 + 1] || 0) * frac;
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  return out;
}

/** wrap Int16 PCM as a 16kHz mono WAV blob */
function wavBlob(pcm: Int16Array): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, STT_SR, true);
  dv.setUint32(28, STT_SR * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wr(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([buf], { type: "audio/wav" });
}

function captionAt(caps: Caption[], t: number): string {
  let cur = "";
  for (const c of caps) {
    if (c.t <= t + 0.05) cur = c.text;
    else break;
  }
  return cur;
}

export const useFC = create<FCState>((set, get) => {
  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /** push a verdict produced by the LIVE pipeline into the counter/log/popups */
  function pushVerdict(text: string, v: any) {
    const verdict: Verdict = (v.verdict || "unverified") as Verdict;
    if (!v.checkable && (verdict === "opinion" || verdict === "unverified")) return;
    const claim: Claim = {
      i: liveId++,
      t: get().t,
      t_end: get().t,
      text,
      checkable: !!v.checkable,
      verdict,
      claim: v.claim || text,
      correction: v.correction || "",
      confidence: v.confidence ?? 0,
      source: v.source || "",
      source_url: v.source_url || "",
      topic: v.topic || "",
      via: v.via,
      moss_ms: v.moss_ms,
    };
    set((s) => {
      const counter = { ...s.counter };
      if (["false", "misleading", "true", "unverified"].includes(verdict)) {
        counter.checked++;
        if (verdict === "false") counter.false++;
        else if (verdict === "misleading") counter.misleading++;
        else if (verdict === "true") counter.true++;
      }
      const log = verdict === "unverified" ? s.log : [claim, ...s.log].slice(0, 40);
      let popups = s.popups;
      if (verdict === "false" || verdict === "misleading") {
        const now = performance.now();
        popups = [{ key: popupKey++, claim, bornAt: now }, ...s.popups.filter((p) => now - p.bornAt < POPUP_TTL)].slice(0, 3);
      }
      return { counter, log, popups };
    });
  }

  async function judgeLive(text: string) {
    set({ analyzing: text });
    set((s) => ({ lastMoss: s.lastMoss })); // keep
    try {
      const r = await fetch(`${API}/api/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: get().config?.id, text }),
      });
      const v = await r.json();
      if (v.moss_ms != null) set({ lastMoss: { ms: v.moss_ms, count: v.retrieved_count ?? 0 } });
      pushVerdict(text, v);
    } catch {
      /* backend hiccup — skip this sentence */
    } finally {
      if (get().analyzing === text) set({ analyzing: null });
    }
  }

  function processLiveText(text: string) {
    const parts = text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i];
      if (s.length <= 8) continue;
      const isLast = i === parts.length - 1;
      const complete = /[.?!]$/.test(s);
      if (isLast && !complete) continue; // the trailing sentence is still being spoken
      if (_seenBefore(s)) continue; // collapse rolling-window repeats of the same claim
      judgedTokens.push(_tokens(s));
      if (judgedTokens.length > 60) judgedTokens.shift();
      judgeLive(s);
    }
  }

  // re-transcribe the trailing WINDOW_S seconds of audio (called every SLIDE_MS)
  async function transcribeWindow() {
    if (!capturing || inFlight || Date.now() < backoffUntil) return;
    if (framesLen < ringRate * 0.7) return; // need a little audio first
    const want = Math.floor(ringRate * WINDOW_S);
    const chosen: Float32Array[] = [];
    let n = 0;
    for (let i = frames.length - 1; i >= 0 && n < want; i--) {
      chosen.unshift(frames[i]);
      n += frames[i].length;
    }
    const buf = new Float32Array(n);
    let o = 0;
    for (const f of chosen) { buf.set(f, o); o += f.length; }
    const blob = wavBlob(toPcm16(buf, ringRate));

    inFlight = true;
    try {
      const fd = new FormData();
      fd.append("audio", blob, "window.wav");
      const r = await fetch(`${API}/api/transcribe`, { method: "POST", body: fd });
      if (r.status === 429) {
        backoffUntil = Date.now() + 3000; // rate-limited: ease off briefly
        return;
      }
      const d = await r.json();
      const text = (d.text || "").trim();
      if (text) {
        set({ caption: text }); // live, continuously-updating transcript tail
        processLiveText(text);
      }
    } catch {
      /* dropped tick */
    } finally {
      inFlight = false;
    }
  }

  async function startCapture() {
    const v = get().videoEl;
    if (!v || capturing) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      await audioCtx.resume();
      ringRate = audioCtx.sampleRate;
      if (!srcNode || srcEl !== v) {
        srcNode = audioCtx.createMediaElementSource(v);
        srcEl = v;
        srcNode.connect(audioCtx.destination); // audible
      }
      if (!workletNode) {
        await audioCtx.audioWorklet.addModule("/pcm-worklet.js");
        workletNode = new AudioWorkletNode(audioCtx, "pcm-processor");
        workletNode.port.onmessage = (e) => {
          if (!capturing) return;
          const frame = e.data as Float32Array;
          if (streaming && aaiWs && aaiWs.readyState === WebSocket.OPEN) {
            // TRUE real-time: stream each PCM frame straight to AssemblyAI
            aaiWs.send(toPcm16(frame, ringRate).buffer);
            return;
          }
          // Groq fallback: keep a rolling buffer for the windowed transcribe
          frames.push(frame);
          framesLen += frame.length;
          const keep = Math.floor(ringRate * (WINDOW_S + 2));
          while (framesLen > keep && frames.length > 1) {
            framesLen -= frames[0].length;
            frames.shift();
          }
        };
      }
      srcNode.connect(workletNode); // tap PCM for STT
      frames = [];
      framesLen = 0;
      capturing = true;

      // prefer real-time AssemblyAI streaming if a key is configured
      streaming = false;
      try {
        const tk = await fetch(`${API}/api/stt-token`).then((r) => r.json());
        if (tk.token) {
          const ws = new WebSocket(
            `wss://streaming.assemblyai.com/v3/ws?sample_rate=${STT_SR}&format_turns=true` +
              `&min_end_of_turn_silence_when_confident=240&max_turn_silence=1200&token=${tk.token}`
          );
          ws.binaryType = "arraybuffer";
          ws.onmessage = (ev) => {
            let m: any;
            try { m = JSON.parse(ev.data); } catch { return; }
            if (m.type !== "Turn") return;
            const tx = (m.transcript || "").trim();
            if (tx) set({ caption: tx }); // live partial words as spoken
            // fact-check on turn-end, or after a ~1.1s pause if the speaker keeps
            // going. Split the turn into SENTENCES and check each individually —
            // judging a whole paragraph at once just returns "unverified".
            const fire = () => {
              if (tx.length > 4) processLiveText(tx);
            };
            if (aaiTurnTimer) clearTimeout(aaiTurnTimer);
            if (m.end_of_turn) fire();
            else aaiTurnTimer = setTimeout(fire, 1100);
          };
          ws.onclose = () => { if (aaiWs === ws) { aaiWs = null; streaming = false; } };
          ws.onerror = () => {};
          aaiWs = ws;
          streaming = true;
        }
      } catch {
        streaming = false;
      }

      if (!streaming) {
        // Groq rolling-window fallback
        if (slideTimer) clearInterval(slideTimer);
        slideTimer = setInterval(transcribeWindow, SLIDE_MS);
      }
    } catch (e) {
      console.warn("[fc] live capture failed", e);
    }
  }

  function stopCapture() {
    capturing = false;
    if (slideTimer) {
      clearInterval(slideTimer);
      slideTimer = null;
    }
    if (aaiTurnTimer) { clearTimeout(aaiTurnTimer); aaiTurnTimer = null; }
    if (aaiWs) {
      try { aaiWs.send(JSON.stringify({ type: "Terminate" })); } catch { /* ignore */ }
      try { aaiWs.close(); } catch { /* ignore */ }
      aaiWs = null;
    }
    streaming = false;
    if (srcNode && workletNode) {
      try { srcNode.disconnect(workletNode); } catch { /* ignore */ }
    }
    frames = [];
    framesLen = 0;
  }

  function apply(t: number) {
    // LIVE: the STT pipeline owns counter/log/popups/caption — just track the clock
    if (get().live) {
      set({ t });
      return;
    }
    // REPLAY (offline fallback): precomputed claims, revealed only after spoken
    const { claims, captions } = get();
    const counter: Counter = { checked: 0, false: 0, misleading: 0, true: 0 };
    const log: Claim[] = [];
    for (const c of claims) {
      if (!c.checkable && (c.verdict === "opinion" || c.verdict === "unverified")) continue;
      const revealAt = (c.t_end ?? c.t) + 0.8;
      if (t >= revealAt) {
        counter.checked++;
        if (c.verdict === "false") counter.false++;
        else if (c.verdict === "misleading") counter.misleading++;
        else if (c.verdict === "true") counter.true++;
        log.push(c);
      }
    }
    log.reverse();
    const now = performance.now();
    let popups = get().popups.filter((p) => now - p.bornAt < POPUP_TTL);
    const existing = new Set(popups.map((p) => p.claim.i));
    for (const c of log) {
      if ((c.verdict === "false" || c.verdict === "misleading") && !existing.has(c.i)) {
        if (t - ((c.t_end ?? c.t) + 0.8) < 6) {
          popups = [{ key: popupKey++, claim: c, bornAt: now }, ...popups].slice(0, 3);
          existing.add(c.i);
        }
      }
    }
    set({ t, counter, log: log.slice(0, 40), popups, caption: captionAt(captions, t) });
  }

  function loop(now: number) {
    const st = get();
    if (!st.playing) {
      stopLoop();
      return;
    }
    if (!lastNow) lastNow = now;
    let dt = (now - lastNow) / 1000;
    lastNow = now;
    if (dt > 0.25) dt = 0.25;
    const v = st.videoEl;
    let t: number;
    if (v) {
      if (v.paused) v.play().catch(() => {});
      t = v.currentTime;
    } else {
      t = st.t + dt;
    }
    if (t >= st.duration) {
      apply(st.duration);
      get().pause();
      return;
    }
    apply(t);
    raf = requestAnimationFrame(loop);
  }

  function resetRun() {
    judgedTokens = [];
    set({
      t: 0,
      counter: { checked: 0, false: 0, misleading: 0, true: 0 },
      log: [],
      popups: [],
      analyzing: null,
      caption: "",
    });
  }

  return {
    status: "idle",
    config: null,
    mode: "",
    claims: [],
    captions: [],
    playing: false,
    t: 0,
    duration: 0,
    counter: { checked: 0, false: 0, misleading: 0, true: 0 },
    log: [],
    popups: [],
    analyzing: null,
    caption: "",
    live: false,
    mossActive: false,
    lastMoss: null,
    sttUp: false,
    videoEl: null,

    async load(id: string) {
      stopLoop();
      stopCapture();
      set({ status: "loading" });
      try {
        const cfg: ScenarioConfig = await fetch(`/scenarios/${id}/scenario.json`, { cache: "no-store" }).then((r) => r.json());
        const [fc, caps] = await Promise.all([
          fetch(`/scenarios/${id}/factcheck.json`, { cache: "no-store" }).then((r) => r.json()),
          fetch(cfg.captions, { cache: "no-store" }).then((r) => r.json()),
        ]);
        set({
          status: "ready",
          config: cfg,
          mode: fc.mode,
          claims: fc.claims,
          captions: caps,
          duration: cfg.duration,
          playing: false,
          live: false,
        });
        resetRun();
        get().setLive(true); // default: real live transcription if backend is up
      } catch (e) {
        console.error("fc load failed", e);
        set({ status: "error" });
      }
    },

    async setLive(on: boolean) {
      if (on) {
        try {
          const r = await fetch(`${API}/api/factcheck/${get().config?.id}/status`);
          const j = await r.json();
          set({ mossActive: !!j.using_moss, sttUp: true });
        } catch {
          console.warn("[fc] backend unreachable — staying on offline replay");
          set({ sttUp: false });
          return; // can't do live STT without the backend
        }
      } else {
        stopCapture();
      }
      const wasPlaying = get().playing;
      get().pause();
      set({ live: on });
      resetRun();
      if (on && wasPlaying) get().play();
      else if (!on) {
        const v = get().videoEl;
        if (v) v.currentTime = 0;
        apply(0);
      }
    },

    play() {
      const st = get();
      if (st.status !== "ready" || st.playing) return;
      if (st.t >= st.duration) get().restart();
      set({ playing: true });
      const v = get().videoEl;
      if (v) v.play().catch(() => {});
      if (st.live) startCapture(); // begin transcribing the audio (gesture-safe)
      lastNow = 0;
      stopLoop();
      raf = requestAnimationFrame(loop);
    },
    pause() {
      set({ playing: false });
      stopLoop();
      stopCapture();
      const v = get().videoEl;
      if (v) v.pause();
    },
    togglePlay() {
      get().playing ? get().pause() : get().play();
    },
    seek(t: number) {
      const { duration, videoEl } = get();
      const clamped = Math.max(0, Math.min(duration, t));
      if (videoEl) videoEl.currentTime = clamped;
      if (get().live) {
        // moving the playhead restarts the live transcript from here
        judgedTokens = [];
        set({ t: clamped, popups: [], caption: "" });
      } else {
        set({ popups: [] });
        apply(clamped);
      }
    },
    restart() {
      get().seek(0);
      resetRun();
    },
    registerVideo(el) {
      set({ videoEl: el });
    },
    dismissPopup(key) {
      set({ popups: get().popups.filter((p) => p.key !== key) });
    },
  };
});

if (typeof window !== "undefined") {
  (window as unknown as { useFC: typeof useFC }).useFC = useFC;
}
