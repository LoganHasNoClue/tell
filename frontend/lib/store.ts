"use client";

import { create } from "zustand";
import { loadScenario } from "./scenarios";
import { ReplayEngine } from "./replay";
import { TellSocket } from "./ws";
import type { ScenarioConfig, StateFrame, WhyEntry } from "./types";

export interface SeriesPoint {
  t: number;
  our: number;
  market: number;
}

interface TellState {
  status: "idle" | "loading" | "ready" | "error";
  source: "demo" | "live";
  config: ScenarioConfig | null;
  engine: ReplayEngine | null;

  playing: boolean;
  t: number;
  duration: number;

  frame: StateFrame | null;
  series: SeriesPoint[];
  why: WhyEntry[];

  /** ms timestamp of the last driver flash, for the WHY/flag pulse */
  lastDriverAt: number;
  maxAbsLead: number;
  leadProven: boolean;
  leadTimeS: number | null;
  leadLevel: number;

  videoEl: HTMLVideoElement | null;
  socket: TellSocket | null;

  load: (id: string) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (t: number) => void;
  restart: () => void;
  registerVideo: (el: HTMLVideoElement | null) => void;
  connectBackend: () => void;
  disconnectBackend: () => void;
}

let rafId = 0;
let lastNow = 0;
let lastCommitT = 0;
let lastSeriesT = 0;
let whyId = 1;

export const useTell = create<TellState>((set, get) => {
  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function commit(t: number, opts: { force?: boolean } = {}) {
    const { engine, config } = get();
    if (!engine || !config) return;

    const frame = engine.frame(t);

    // fire any drivers crossed since last commit
    const fired = engine.driversBetween(lastCommitT, t);
    let why = get().why;
    let lastDriverAt = get().lastDriverAt;
    if (fired.length) {
      const entries: WhyEntry[] = fired.map((f) => ({
        id: whyId++,
        t: f.t,
        quote: f.driver.quote,
        effect: f.driver.effect,
        why: f.driver.why,
      }));
      // newest first
      why = [...entries.reverse(), ...why].slice(0, 24);
      lastDriverAt = performance.now();
      frame.drivers = fired.map((f) => f.driver);
    }

    // chart series sampling (~10Hz)
    let series = get().series;
    if (opts.force || t - lastSeriesT >= 0.1) {
      lastSeriesT = t;
      series = [...series, { t, our: frame.our_prob, market: frame.market_prob }];
    }

    const absLead = Math.abs(frame.lead);
    const maxAbsLead = Math.max(get().maxAbsLead, absLead);
    const leadProven = engine.leadProven(t);

    lastCommitT = t;
    set({
      t,
      frame,
      series,
      why,
      lastDriverAt,
      maxAbsLead,
      leadProven,
    });
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
    if (dt > 0.25) dt = 0.25; // tab was backgrounded; don't jump

    const v = st.videoEl;
    const off = st.config?.video_offset ?? 0;
    let t: number;

    if (v && st.t >= off) {
      // Real video is the CLOCK MASTER during the video region: we read its
      // currentTime instead of seeking it. No per-frame seeks => audio + video
      // play smoothly (seeking is what made it stutter with sound on).
      if (v.paused) v.play().catch(() => {});
      t = v.currentTime + off;
    } else {
      // Pre-roll (or no real video): advance a virtual clock.
      t = st.t + dt;
      if (v) {
        if (!v.paused) v.pause();
        if (t >= off) {
          // crossing into the video region — hand the clock to the video
          v.currentTime = Math.max(0, t - off);
          v.play().catch(() => {});
        }
      }
    }

    if (t >= st.duration) {
      t = st.duration;
      commit(t, { force: true });
      get().pause();
      return;
    }

    if (t - lastCommitT >= 0.045) commit(t);
    else set({ t });

    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    stopLoop();
    lastNow = 0;
    rafId = requestAnimationFrame(loop);
  }

  // apply a StateFrame pushed from the backend (live pipeline path)
  function applyLive(frame: StateFrame) {
    const eng = get().engine;
    let why = get().why;
    let lastDriverAt = get().lastDriverAt;
    if (frame.drivers && frame.drivers.length) {
      const entries: WhyEntry[] = frame.drivers.map((d) => ({
        id: whyId++,
        t: frame.t,
        quote: d.quote,
        effect: d.effect,
        why: d.why,
      }));
      why = [...entries.reverse(), ...why].slice(0, 24);
      lastDriverAt = performance.now();
    }
    let series = get().series;
    if (frame.t - lastSeriesT >= 0.08) {
      lastSeriesT = frame.t;
      series = [...series, { t: frame.t, our: frame.our_prob, market: frame.market_prob }];
    }
    set({
      t: frame.t,
      frame,
      series,
      why,
      lastDriverAt,
      maxAbsLead: Math.max(get().maxAbsLead, Math.abs(frame.lead)),
      leadProven: eng ? eng.leadProven(frame.t) : false,
    });
  }

  return {
    status: "idle",
    source: "demo",
    config: null,
    engine: null,
    playing: false,
    t: 0,
    duration: 120,
    frame: null,
    series: [],
    why: [],
    lastDriverAt: 0,
    maxAbsLead: 0,
    leadProven: false,
    leadTimeS: null,
    leadLevel: 0.68,
    videoEl: null,
    socket: null,

    async load(id: string) {
      stopLoop();
      set({ status: "loading" });
      try {
        const loaded = await loadScenario(id);
        const engine = new ReplayEngine(loaded);
        whyId = 1;
        lastCommitT = 0;
        lastSeriesT = 0;
        engine.resetFrom(0);
        const frame = engine.frame(0);
        set({
          status: "ready",
          config: loaded.config,
          engine,
          duration: loaded.config.duration,
          t: 0,
          playing: false,
          frame,
          series: [{ t: 0, our: frame.our_prob, market: frame.market_prob }],
          why: [],
          lastDriverAt: 0,
          maxAbsLead: 0,
          leadProven: false,
          leadTimeS: engine.leadTimeS,
          leadLevel: engine.leadLevel,
        });
      } catch (e) {
        console.error("scenario load failed", e);
        set({ status: "error" });
      }
    },

    play() {
      const st = get();
      if (st.status !== "ready" || st.playing) return;
      const v = get().videoEl;
      if (st.source === "live" && st.socket) {
        if (st.t >= st.duration) get().restart();
        st.socket.send({ cmd: "play" });
        set({ playing: true });
        if (v) v.play().catch(() => {});
        return;
      }
      if (st.t >= st.duration) get().restart();
      set({ playing: true });
      if (v) v.play().catch(() => {});
      startLoop();
    },

    pause() {
      const st = get();
      if (st.source === "live" && st.socket) st.socket.send({ cmd: "pause" });
      set({ playing: false });
      stopLoop();
      const v = get().videoEl;
      if (v) v.pause();
    },

    togglePlay() {
      get().playing ? get().pause() : get().play();
    },

    seek(t: number) {
      const { engine, duration, source, socket } = get();
      if (!engine) return;
      const clamped = Math.max(0, Math.min(duration, t));
      if (source === "live" && socket) {
        lastSeriesT = clamped;
        engine.resetFrom(clamped);
        socket.send({ cmd: "seek", t: clamped });
        set({ t: clamped, series: [], why: [] });
        const v = get().videoEl;
        if (v) v.currentTime = clamped;
        return;
      }
      engine.resetFrom(clamped);
      lastCommitT = clamped;
      lastSeriesT = clamped;
      // rebuild series up to clamped for a coherent chart after a scrub
      const series: SeriesPoint[] = [];
      for (let x = 0; x <= clamped + 1e-6; x += 0.2) {
        const f = engine.frame(x);
        series.push({ t: x, our: f.our_prob, market: f.market_prob });
      }
      const frame = engine.frame(clamped);
      const v = get().videoEl;
      const off = get().config?.video_offset ?? 0;
      if (v) v.currentTime = Math.max(0, clamped - off);
      set({
        t: clamped,
        frame,
        series,
        leadProven: engine.leadProven(clamped),
      });
    },

    restart() {
      const { source, socket } = get();
      if (source === "live" && socket) {
        lastSeriesT = 0;
        socket.send({ cmd: "restart" });
        set({ t: 0, series: [], why: [], maxAbsLead: 0, lastDriverAt: 0, playing: true });
        return;
      }
      get().seek(0);
      set({ why: [], maxAbsLead: 0, lastDriverAt: 0 });
    },

    registerVideo(el) {
      set({ videoEl: el });
    },

    connectBackend() {
      const { config, socket } = get();
      if (!config || socket) return;
      get().pause();
      stopLoop();
      const url =
        process.env.NEXT_PUBLIC_TELL_WS || "ws://localhost:8000/ws";
      lastSeriesT = 0;
      const sock = new TellSocket(url, config.id, "demo", {
        onMeta: (m) => set({ duration: m.duration ?? get().duration }),
        onFrame: (f) => applyLive(f),
        onError: () => {
          // backend unreachable -> fall back to local, never break the demo
          console.warn("[tell] backend unreachable; staying on local demo");
          get().disconnectBackend();
        },
        onClose: () => {
          if (get().source === "live") get().disconnectBackend();
        },
      });
      sock.connect();
      set({ socket: sock, source: "live", playing: false, series: [], why: [], t: 0 });
    },

    disconnectBackend() {
      const { socket } = get();
      socket?.close();
      set({ socket: null, source: "demo", playing: false });
      // rebuild the local engine view at the current clock
      get().seek(get().t);
    },

    // dev/test: deterministically step the engine to `target` (no rAF needed)
    pump(target: number) {
      const st = get();
      if (!st.engine) return;
      let t = lastCommitT;
      while (t < target) {
        t = Math.min(target, t + 0.25);
        commit(t);
      }
      set({ t: target, playing: false });
    },
  } as TellState & { pump: (t: number) => void };
});

if (typeof window !== "undefined") {
  // dev convenience: drive the terminal from the console / preview harness
  (window as unknown as { useTell: typeof useTell }).useTell = useTell;
}
