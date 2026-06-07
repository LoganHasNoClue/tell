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
}

export interface FactCheckFile {
  scenario: string;
  mode: string;
  totals: Record<string, number>;
  checked: number;
  flagged: number;
  claims: Claim[];
}

export interface ScenarioConfig {
  id: string;
  title: string;
  subtitle: string;
  video: string;
  duration: number;
  captions: string;
}

export interface Caption {
  t: number;
  speaker: string;
  text: string;
}

export interface Popup {
  key: number;
  claim: Claim;
  bornAt: number; // ms
}

export interface Counter {
  checked: number;
  false: number;
  misleading: number;
  true: number;
}

const RESOLVE_DELAY = 1.0; // seconds of "analyzing" before a verdict resolves
const POPUP_TTL = 9000; // ms a flagged popup stays
const API = process.env.NEXT_PUBLIC_TELL_API || "http://localhost:8000";

// non-reactive bookkeeping for live mode
const livePending = new Set<number>();

interface FCState {
  status: "idle" | "loading" | "ready" | "error";
  config: ScenarioConfig | null;
  mode: string;
  claims: Claim[];
  captions: Caption[];

  playing: boolean;
  t: number;
  duration: number;

  counter: Counter;
  log: Claim[]; // resolved checkable claims, newest first
  popups: Popup[]; // active flagged cards
  analyzing: Claim | null; // claim currently being checked
  caption: string;

  live: boolean; // true = compute verdicts from the backend per claim, in real time
  liveResults: Record<number, Claim>;
  mossActive: boolean;

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
let lastApply = -1;
let popupKey = 1;

function captionAt(caps: Caption[], t: number): string {
  let cur = "";
  for (const c of caps) {
    if (c.t <= t + 0.05) cur = c.text;
    else break;
  }
  return cur;
}

export const useFC = create<FCState>((set, get) => {
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /** live mode: verify a single claim against the backend (Moss + LLM), once. */
  async function checkClaim(c: Claim) {
    if (livePending.has(c.i)) return;
    livePending.add(c.i);
    try {
      const r = await fetch(`${API}/api/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: get().config?.id, text: c.text }),
      });
      const v = await r.json();
      const merged: Claim = {
        ...c,
        verdict: v.verdict ?? "unverified",
        checkable: !!v.checkable,
        claim: v.claim || c.text,
        correction: v.correction || "",
        confidence: v.confidence ?? 0,
        source: v.source || "",
        source_url: v.source_url || "",
        topic: v.topic || c.topic || "",
      };
      set({ liveResults: { ...get().liveResults, [c.i]: merged } });
      apply(get().t);
    } catch (e) {
      console.warn("[fc] live check failed", e);
    } finally {
      livePending.delete(c.i);
    }
  }

  /** recompute everything that depends on the clock for time `t` */
  function apply(t: number) {
    const { claims, captions, live, liveResults } = get();
    const counter: Counter = { checked: 0, false: 0, misleading: 0, true: 0 };
    const log: Claim[] = [];
    let analyzing: Claim | null = null;

    for (const c of claims) {
      const due = t >= c.t;
      let vc: Claim | undefined;
      let resolved = false;

      if (live) {
        vc = liveResults[c.i];
        if (due && !vc) {
          checkClaim(c); // fire live retrieval+judgment
          analyzing = c; // still checking
        }
        resolved = due && !!vc;
      } else {
        if (!c.checkable && (c.verdict === "opinion" || c.verdict === "unverified")) continue;
        vc = c;
        if (due && t < c.t + RESOLVE_DELAY) analyzing = c;
        resolved = t >= c.t + RESOLVE_DELAY;
      }

      if (resolved && vc) {
        const v = vc.verdict;
        if (vc.checkable && (v === "false" || v === "misleading" || v === "true" || v === "unverified")) {
          counter.checked++;
          if (v === "false") counter.false++;
          else if (v === "misleading") counter.misleading++;
          else if (v === "true") counter.true++;
          if (v !== "unverified") log.push(vc);
        }
      }
    }
    log.reverse();

    // popups: flagged claims spoken recently, kept for TTL, capped
    const now = performance.now();
    let popups = get().popups.filter((p) => now - p.bornAt < POPUP_TTL);
    const existing = new Set(popups.map((p) => p.claim.i));
    for (const c of log) {
      if ((c.verdict === "false" || c.verdict === "misleading") && !existing.has(c.i)) {
        if (t - c.t < 6) {
          popups = [{ key: popupKey++, claim: c, bornAt: now }, ...popups].slice(0, 3);
          existing.add(c.i);
        }
      }
    }

    set({
      t,
      counter,
      log: log.slice(0, 40),
      popups,
      analyzing,
      caption: captionAt(captions, t),
    });
  }

  function loop(now: number) {
    const st = get();
    if (!st.playing) {
      stop();
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
    if (t - lastApply >= 0.05 || t < lastApply) {
      lastApply = t;
      apply(t);
    }
    raf = requestAnimationFrame(loop);
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
    liveResults: {},
    mossActive: false,
    videoEl: null,

    async setLive(on: boolean) {
      if (on) {
        try {
          const r = await fetch(`${API}/api/factcheck/${get().config?.id}/status`);
          const j = await r.json();
          set({ mossActive: !!j.using_moss });
        } catch {
          console.warn("[fc] backend unreachable — staying on replay");
          return;
        }
      }
      livePending.clear();
      set({ live: on, liveResults: {}, popups: [], log: [] });
      apply(get().t);
    },

    async load(id: string) {
      stop();
      set({ status: "loading" });
      try {
        const cfg: ScenarioConfig = await fetch(`/scenarios/${id}/scenario.json`, {
          cache: "no-store",
        }).then((r) => r.json());
        const [fc, caps] = await Promise.all([
          fetch(`/scenarios/${id}/factcheck.json`, { cache: "no-store" }).then((r) => r.json()),
          fetch(cfg.captions, { cache: "no-store" }).then((r) => r.json()),
        ]);
        const file = fc as FactCheckFile;
        set({
          status: "ready",
          config: cfg,
          mode: file.mode,
          claims: file.claims,
          captions: caps,
          duration: cfg.duration,
          t: 0,
          playing: false,
          counter: { checked: 0, false: 0, misleading: 0, true: 0 },
          log: [],
          popups: [],
          analyzing: null,
          caption: "",
        });
      } catch (e) {
        console.error("fc load failed", e);
        set({ status: "error" });
      }
    },

    play() {
      const st = get();
      if (st.status !== "ready" || st.playing) return;
      if (st.t >= st.duration) get().restart();
      set({ playing: true });
      const v = get().videoEl;
      if (v) v.play().catch(() => {});
      lastNow = 0;
      stop();
      raf = requestAnimationFrame(loop);
    },
    pause() {
      set({ playing: false });
      stop();
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
      set({ popups: [] });
      apply(clamped);
    },
    restart() {
      get().seek(0);
      set({ popups: [], log: [] });
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
