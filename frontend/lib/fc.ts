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
const CHUNK_MS = 2500; // length of each live audio chunk sent to STT (Groq is fast)

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

// --- live audio capture (module-scoped, not reactive) ---
let audioCtx: AudioContext | null = null;
let srcNode: MediaElementAudioSourceNode | null = null;
let srcEl: HTMLVideoElement | null = null;
let capturing = false;
let captureDest: MediaStreamAudioDestinationNode | null = null;
let sttJudged = new Set<string>();

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
    const sentences = text
      .split(/(?<=[.?!])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8);
    for (const s of sentences) {
      const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, "");
      if (sttJudged.has(key)) continue;
      sttJudged.add(key);
      judgeLive(s);
    }
  }

  async function transcribeChunk(blob: Blob) {
    try {
      const fd = new FormData();
      fd.append("audio", blob, "chunk.webm");
      const r = await fetch(`${API}/api/transcribe`, { method: "POST", body: fd });
      const d = await r.json();
      const text = (d.text || "").trim();
      if (!text) return;
      set({ caption: text }); // live transcript shown as it's heard
      processLiveText(text);
    } catch {
      /* ignore a dropped chunk */
    }
  }

  function recordChunk(stream: MediaStream) {
    if (!capturing) return;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
    } catch {
      try {
        rec = new MediaRecorder(stream);
      } catch {
        return;
      }
    }
    const blobs: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) blobs.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(blobs, { type: rec.mimeType || "audio/webm" });
      if (blob.size > 2000 && get().playing) transcribeChunk(blob);
      if (capturing) recordChunk(stream); // next chunk
    };
    rec.start();
    setTimeout(() => {
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        /* ignore */
      }
    }, CHUNK_MS);
  }

  function startCapture() {
    const v = get().videoEl;
    if (!v || capturing) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtx.resume();
      if (!srcNode || srcEl !== v) {
        srcNode = audioCtx.createMediaElementSource(v);
        srcEl = v;
        srcNode.connect(audioCtx.destination); // route to speakers once, so it's audible
      }
      captureDest = audioCtx.createMediaStreamDestination();
      srcNode.connect(captureDest); // tap a copy for STT
      capturing = true;
      recordChunk(captureDest.stream);
    } catch (e) {
      console.warn("[fc] live capture failed", e);
    }
  }

  function stopCapture() {
    capturing = false;
    if (srcNode && captureDest) {
      try { srcNode.disconnect(captureDest); } catch { /* ignore */ }
    }
    captureDest = null;
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
    sttJudged = new Set();
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
        sttJudged = new Set();
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
