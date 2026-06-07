"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useTell } from "@/lib/store";
import TopBar from "@/components/TopBar";
import VideoStage from "@/components/VideoStage";
import HeroGauge from "@/components/HeroGauge";
import DivergenceFlag from "@/components/DivergenceFlag";
import TapeChart from "@/components/TapeChart";
import WhyFeed from "@/components/WhyFeed";
import SubMeters from "@/components/SubMeters";
import Transport from "@/components/Transport";
import LeadBadge from "@/components/LeadBadge";
import Panel from "@/components/Panel";

function Terminal() {
  const params = useSearchParams();
  const id = params.get("s") || "fomc_2026_03";
  const status = useTell((s) => s.status);
  const load = useTell((s) => s.load);

  useEffect(() => {
    load(id);
  }, [id, load]);

  return (
    <main className="vignette relative flex h-screen flex-col gap-2.5 p-3">
      <TopBar />

      {/* MIDDLE: video + hero/flag */}
      <div className="flex min-h-0 flex-[1.15] gap-2.5">
        <Panel pad={false} className="flex-[1.32] overflow-hidden">
          <VideoStage />
        </Panel>

        <div className="flex flex-[1] flex-col gap-2.5">
          <Panel className="relative flex flex-1 items-center justify-center overflow-hidden">
            <div className="absolute left-3 top-2.5 text-[10px] tracking-[0.28em] text-muted">
              TELL · LIVE ESTIMATE
            </div>
            <HeroGauge />
          </Panel>
          <DivergenceFlag />
        </div>
      </div>

      {/* TAPE */}
      <Panel pad={false} className="relative flex min-h-0 flex-[0.66] flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-2.5">
          <div className="flex items-center gap-4">
            <span className="text-[11px] tracking-[0.28em] text-muted">
              THE TAPE
            </span>
            <span className="flex items-center gap-1.5 text-[11px]">
              <span className="inline-block h-[3px] w-5 rounded bg-tell shadow-tell" />
              <span className="text-white/80 font-medium">TELL</span>
            </span>
            <span className="flex items-center gap-1.5 text-[11px]">
              <span className="inline-block h-[3px] w-5 rounded bg-market" />
              <span className="text-muted">Market</span>
            </span>
          </div>
          <SubMeters />
        </div>
        <div className="relative min-h-0 flex-1">
          <LeadBadge />
          <TapeChart />
        </div>
      </Panel>

      {/* WHY FEED */}
      <Panel pad={false} className="flex min-h-0 flex-[0.52] flex-col overflow-hidden">
        <WhyFeed />
      </Panel>

      {/* TRANSPORT + honesty footer */}
      <div className="flex items-center gap-5">
        <div className="flex-1">
          <Transport />
        </div>
        <span className="hidden md:block text-[10px] text-muted/55 tracking-wide whitespace-nowrap">
          Model: live LLM reading of the event. Informational, not trading advice.
        </span>
      </div>

      {status === "loading" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink-900/80">
          <span className="text-tell text-sm tracking-[0.3em] animate-pulse2">
            INITIALIZING TERMINAL…
          </span>
        </div>
      )}
    </main>
  );
}

export default function TerminalPage() {
  return (
    <Suspense fallback={<div className="h-screen" />}>
      <Terminal />
    </Suspense>
  );
}
