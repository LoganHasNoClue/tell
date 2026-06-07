"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useFC } from "@/lib/fc";
import FCStage from "@/components/fc/FCStage";
import CounterCard from "@/components/fc/CounterCard";
import VerdictFeed from "@/components/fc/VerdictFeed";
import FCTransport from "@/components/fc/FCTransport";

function MossMark() {
  return (
    <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12h8M12 8v8" />
      </svg>
      <span className="text-[10px] font-medium tracking-[0.16em] text-white/60">
        RETRIEVAL BY MOSS
      </span>
    </span>
  );
}

function Page() {
  const params = useSearchParams();
  const id = params.get("s") || "debate_biden_2024";
  const status = useFC((s) => s.status);
  const config = useFC((s) => s.config);
  const load = useFC((s) => s.load);
  const live = useFC((s) => s.live);
  const setLive = useFC((s) => s.setLive);

  useEffect(() => {
    load(id);
  }, [id, load]);

  return (
    <main className="flex h-screen flex-col px-6 py-5">
      {/* header */}
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <span className="text-[20px] font-bold tracking-[0.18em] text-white">TELL</span>
          <span className="text-[12px] tracking-[0.2em] text-white/45">
            LIVE FACT-CHECK
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="hidden text-[12px] text-white/45 sm:block">
            {config?.subtitle}
          </span>
          <a
            href="/live"
            className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 transition active:scale-95"
            title="Live mic — fact-check yourself in real time"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
            </svg>
            <span className="text-[10px] font-semibold tracking-[0.16em] text-white/70">
              MIC
            </span>
          </a>
          <button
            onClick={() => setLive(!live)}
            className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 transition active:scale-95"
            title={live
              ? "LIVE — real data: transcribing the audio and checking each claim in real time"
              : "DEMO — precomputed run: replays the saved verification, synced to the video (no live calls)"}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: live ? "var(--green)" : "var(--amber)" }}
            />
            <span className="text-[10px] font-semibold tracking-[0.16em] text-white/70">
              {live ? "LIVE" : "DEMO"}
            </span>
          </button>
          <MossMark />
        </div>
      </header>

      {/* main: video (left) + intelligence (right) */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
        <div className="flex min-h-0 flex-col gap-4">
          <div className="relative">
            <FCStage />
          </div>
          <FCTransport />
        </div>

        <aside className="flex min-h-0 flex-col gap-4">
          <CounterCard />
          <VerdictFeed />
        </aside>
      </div>

      {/* honesty footer */}
      <footer className="mt-3 flex items-center justify-between text-[10px] tracking-wide text-white/30">
        <span>
          Claims verified live against a ground-truth fact base · retrieval by Moss ·
          judgment by LLM. Informational.
        </span>
        <span className="mono">{config?.title}</span>
      </footer>

      {status === "loading" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70">
          <span className="text-[13px] tracking-[0.3em] text-white/70 soft-pulse">
            LOADING…
          </span>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80">
          <span className="text-[13px] tracking-wide text-[var(--red)]">
            Failed to load scenario — run: python tools/run_factcheck.py {id}
          </span>
        </div>
      )}
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="h-screen" />}>
      <Page />
    </Suspense>
  );
}
