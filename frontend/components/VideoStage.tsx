"use client";

import { useEffect, useRef, useState } from "react";
import { useTell } from "@/lib/store";
import { wall } from "@/lib/format";

export default function VideoStage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const speakerRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const prerollRef = useRef<HTMLDivElement>(null);
  const registerVideo = useTell((s) => s.registerVideo);
  const config = useTell((s) => s.config);
  const [hasVideo, setHasVideo] = useState(true);
  const [muted, setMuted] = useState(false);

  // register the <video> as the (optional) follower of the master clock
  useEffect(() => {
    registerVideo(videoRef.current);
    return () => registerVideo(null);
  }, [registerVideo, config?.id]);

  // probe whether a real mp4 exists for this scenario
  useEffect(() => {
    if (!config) return;
    setHasVideo(true);
    let alive = true;
    fetch(config.video, { method: "HEAD" })
      .then((r) => {
        if (!alive) return;
        const type = r.headers.get("content-type") || "";
        if (!r.ok || type.includes("text/html")) setHasVideo(false);
      })
      .catch(() => alive && setHasVideo(false));
    return () => {
      alive = false;
    };
  }, [config?.id, config?.video]);

  // caption + clock + pre-roll (ALWAYS), plus the synthetic waveform when its
  // canvas is mounted. Decoupled from React renders via a single rAF loop.
  useEffect(() => {
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let observed: HTMLCanvasElement | null = null;
    let lastCapT = -1;
    const BARS = 56;

    function syncCanvas() {
      const wave = waveRef.current;
      if (wave && wave !== observed) {
        ctx = wave.getContext("2d");
        const resize = () => {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          wave.width = wave.clientWidth * dpr;
          wave.height = wave.clientHeight * dpr;
          ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        ro?.disconnect();
        ro = new ResizeObserver(resize);
        ro.observe(wave);
        observed = wave;
      } else if (!wave) {
        observed = null;
        ctx = null;
      }
    }

    function frame() {
      const st = useTell.getState();
      const t = st.t;
      const playing = st.playing;
      const engine = st.engine;
      const cap = engine?.caption(t) ?? null;

      // synthetic waveform — only when its canvas is on screen
      syncCanvas();
      const wave = waveRef.current;
      if (wave && ctx) {
        const w = wave.clientWidth;
        const h = wave.clientHeight;
        ctx.clearRect(0, 0, w, h);
        const speaking = playing && cap != null && t - cap.t < 6;
        const env = speaking ? 1 : 0.18;
        const gap = w / BARS;
        for (let i = 0; i < BARS; i++) {
          const phase = i * 0.5;
          const osc =
            0.5 +
            0.5 *
              Math.sin(t * 6 + phase) *
              Math.sin(t * 2.3 + phase * 0.7) *
              (playing ? 1 : 0.2);
          const amp = (0.12 + 0.88 * Math.abs(osc)) * env;
          const bh = Math.max(2, amp * h * 0.8);
          const x = i * gap + gap * 0.5;
          const grad = ctx.createLinearGradient(0, h / 2 - bh / 2, 0, h / 2 + bh / 2);
          grad.addColorStop(0, "rgba(0,224,138,0.95)");
          grad.addColorStop(1, "rgba(0,224,138,0.25)");
          ctx.fillStyle = grad;
          ctx.fillRect(x - gap * 0.28, h / 2 - bh / 2, gap * 0.56, bh);
        }
      }

      // pre-roll overlay (market repricing before the video starts)
      const off = st.config?.video_offset ?? 0;
      if (prerollRef.current) {
        prerollRef.current.style.opacity = off > 0 && t < off ? "1" : "0";
      }

      // caption + speaker (clears when there's no active line, e.g. on restart)
      if (cap) {
        if (cap.t !== lastCapT) {
          lastCapT = cap.t;
          if (capRef.current) capRef.current.textContent = cap.text;
          if (speakerRef.current) speakerRef.current.textContent = cap.speaker;
        }
      } else if (lastCapT !== -1) {
        lastCapT = -1;
        if (capRef.current) capRef.current.textContent = " ";
        if (speakerRef.current) speakerRef.current.textContent = "—";
      }
      if (clockRef.current) clockRef.current.textContent = wall(t);

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [config?.id]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-black hairline vignette">
      {/* real video, if present */}
      {hasVideo && config && (
        <video
          ref={videoRef}
          src={config.video}
          muted={muted}
          playsInline
          preload="auto"
          onError={() => setHasVideo(false)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {/* synthetic broadcast tile (fallback / when no mp4) */}
      {!hasVideo && (
        <div className="absolute inset-0 scanlines">
          <div className="absolute inset-0 bg-gradient-to-b from-[#0c1118] via-[#0a0d12] to-[#06080b]" />
          <div className="absolute left-1/2 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-tell/[0.07] blur-3xl" />
          <div className="absolute inset-0 flex flex-col items-center justify-center px-10">
            <div className="text-[10px] tracking-[0.4em] text-muted/70 mb-6">
              {config?.source_label?.toUpperCase()}
            </div>
            <canvas ref={waveRef} className="h-28 w-full max-w-[520px]" />
            <div className="mt-6 text-[11px] tracking-[0.3em] text-muted/50">
              AUDIO-IN · LIVE TRANSCRIPTION
            </div>
          </div>
        </div>
      )}

      {/* pre-roll overlay */}
      <div
        ref={prerollRef}
        style={{ opacity: 0, transition: "opacity 300ms" }}
        className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm"
      >
        <div className="text-[11px] tracking-[0.4em] text-down/90 mb-3 liveblink">
          ● STATEMENT RELEASED · 2:00 PM ET
        </div>
        <div className="text-[15px] text-white/85 font-medium">
          Market repricing on the decision
        </div>
        <div className="mt-2 max-w-sm text-center text-[12px] leading-relaxed text-muted">
          The hard number moves the market in milliseconds. TELL waits for the
          words — the press conference begins shortly.
        </div>
      </div>

      {/* top chrome */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between p-3.5">
        <div className="flex items-center gap-2 rounded-md bg-black/55 px-2.5 py-1.5 backdrop-blur">
          <span className="h-2 w-2 rounded-full bg-down liveblink" />
          <span className="text-[10px] font-semibold tracking-[0.25em] text-white/90">
            LIVE
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const next = !muted;
              setMuted(next);
              if (videoRef.current) videoRef.current.muted = next;
            }}
            className="flex items-center gap-1.5 rounded-md bg-black/55 px-2.5 py-1.5 backdrop-blur transition hover:bg-black/75"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00E08A" strokeWidth="2">
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M19 5a9 9 0 0 1 0 14" />
              </svg>
            )}
            <span className="text-[10px] font-semibold tracking-[0.2em] text-white/80">
              {muted ? "MUTED" : "AUDIO"}
            </span>
          </button>
          <div className="rounded-md bg-black/55 px-2.5 py-1.5 backdrop-blur">
            <span ref={clockRef} className="mono tnum text-[11px] text-white/80">
              14:00:00
            </span>
          </div>
        </div>
      </div>

      {/* lower-third caption */}
      <div className="absolute bottom-0 left-0 right-0 p-4">
        <div className="rounded-lg bg-black/65 px-4 py-3 backdrop-blur-md hairline">
          <div className="flex items-center gap-2">
            <span className="rounded bg-tell/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-tell">
              <span ref={speakerRef}>—</span>
            </span>
            <span className="text-[10px] tracking-[0.2em] text-muted/70">
              TRANSCRIPT
            </span>
          </div>
          <div
            ref={capRef}
            className="mt-1.5 text-[15px] leading-snug text-white/90 min-h-[22px]"
          >
            &nbsp;
          </div>
        </div>
      </div>
    </div>
  );
}
