"use client";

import { useEffect } from "react";
import { useFC } from "@/lib/fc";

function clock(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function FCTransport() {
  const playing = useFC((s) => s.playing);
  const t = useFC((s) => s.t);
  const duration = useFC((s) => s.duration);
  const toggle = useFC((s) => s.togglePlay);
  const seek = useFC((s) => s.seek);
  const restart = useFC((s) => s.restart);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        useFC.getState().togglePlay();
      } else if (e.key === "r") {
        useFC.getState().restart();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const frac = duration ? t / duration : 0;

  return (
    <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
      <button
        onClick={toggle}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black transition active:scale-95"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <svg width="15" height="15" viewBox="0 0 14 14" fill="currentColor">
            <rect x="2" y="1" width="3.5" height="12" rx="1.2" />
            <rect x="8.5" y="1" width="3.5" height="12" rx="1.2" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 14 14" fill="currentColor">
            <path d="M3 1.5 12 7 3 12.5Z" />
          </svg>
        )}
      </button>
      <button
        onClick={restart}
        className="text-white/45 transition hover:text-white"
        title="Restart (r)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>
      <span className="mono tnum w-[42px] text-right text-[12px] text-white/70">{clock(t)}</span>
      <div
        className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/12"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${frac * 100}%` }} />
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition group-hover:opacity-100"
          style={{ left: `${frac * 100}%` }}
        />
      </div>
      <span className="mono tnum w-[42px] text-[12px] text-white/40">{clock(duration)}</span>
    </div>
  );
}
