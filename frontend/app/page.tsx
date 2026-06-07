"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useFC } from "@/lib/fc";
import FCStage from "@/components/fc/FCStage";
import VerdictStack from "@/components/fc/VerdictStack";
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
          <button
            onClick={() => setLive(!live)}
            className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 transition active:scale-95"
            title={live ? "Live: verifying each claim against the backend in real time" : "Replay: showing the precomputed verification run"}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: live ? "var(--green)" : "rgba(255,255,255,0.4)" }}
            />
            <span className="text-[10px] font-semibold tracking-[0.16em] text-white/70">
              {live ? "LIVE" : "REPLAY"}
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
            <VerdictStack />
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
