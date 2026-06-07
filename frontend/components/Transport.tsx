"use client";

import { useEffect } from "react";
import { useTell } from "@/lib/store";
import { clock } from "@/lib/format";

export default function Transport() {
  const playing = useTell((s) => s.playing);
  const t = useTell((s) => s.t);
  const duration = useTell((s) => s.duration);
  const toggle = useTell((s) => s.togglePlay);
  const seek = useTell((s) => s.seek);
  const restart = useTell((s) => s.restart);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        useTell.getState().togglePlay();
      } else if (e.key === "r") {
        useTell.getState().restart();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const frac = duration ? t / duration : 0;

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggle}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-tell text-black shadow-tell transition hover:scale-105 active:scale-95"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <rect x="2" y="1" width="3.5" height="12" rx="1" />
            <rect x="8.5" y="1" width="3.5" height="12" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <path d="M3 1.5 L12 7 L3 12.5 Z" />
          </svg>
        )}
      </button>
      <button
        onClick={restart}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-white/60 transition hover:text-white hover:border-white/25"
        aria-label="Restart"
        title="Restart (r)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>

      <span className="mono tnum text-[12px] text-white/70 w-[42px] text-right">
        {clock(t)}
      </span>
      <div
        className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/10"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-tell"
          style={{ width: `${frac * 100}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white opacity-0 shadow-tell transition group-hover:opacity-100"
          style={{ left: `${frac * 100}%` }}
        />
      </div>
      <span className="mono tnum text-[12px] text-muted w-[42px]">
        {clock(duration)}
      </span>
    </div>
  );
}
