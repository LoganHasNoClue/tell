"use client";

import Link from "next/link";
import { useTell } from "@/lib/store";

export default function TopBar() {
  const config = useTell((s) => s.config);
  const source = useTell((s) => s.source);
  const connectBackend = useTell((s) => s.connectBackend);
  const disconnectBackend = useTell((s) => s.disconnectBackend);

  return (
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="group flex items-center gap-2.5"
          title="Back to scenarios"
        >
          <span className="text-[22px] font-bold tracking-[0.2em] text-white">
            TELL
          </span>
          <span className="hidden sm:block text-[11px] text-muted/80 tracking-wide border-l border-white/10 pl-2.5">
            read the room before the market does
          </span>
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-md border border-white/10 bg-ink-700 px-3 py-1.5">
          <span className="text-[10px] font-bold tracking-[0.22em] text-tell">
            {config?.tag}
          </span>
          <span className="text-white/30">·</span>
          <span className="text-[12px] text-white/85 font-medium">
            &ldquo;{config?.outcome_label}&rdquo;
          </span>
        </div>
        <button
          onClick={() =>
            source === "demo" ? connectBackend() : disconnectBackend()
          }
          className="flex items-center gap-1.5 rounded-md border border-white/10 bg-ink-700 px-2.5 py-1.5 transition hover:border-white/25"
          title={
            source === "demo"
              ? `Local replay (offline-safe). Click to connect the live backend pipeline. ${config?.model_label ?? ""}`
              : `Streaming from backend pipeline. Click to return to offline demo. ${config?.model_label ?? ""}`
          }
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              source === "demo" ? "bg-tell" : "bg-amber-400"
            } liveblink`}
          />
          <span className="text-[10px] font-semibold tracking-[0.2em] text-white/70">
            {source === "demo" ? "DEMO" : "LIVE"}
          </span>
        </button>
      </div>
    </div>
  );
}
