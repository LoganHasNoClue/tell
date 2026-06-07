"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFC } from "@/lib/fc";

const STYLE: Record<string, { color: string; label: string }> = {
  false: { color: "var(--red)", label: "FALSE" },
  misleading: { color: "var(--amber)", label: "MISLEADING" },
  true: { color: "var(--green)", label: "TRUE" },
};

export default function VerdictFeed() {
  const log = useFC((s) => s.log);
  const shown = log.filter((c) => ["false", "misleading", "true"].includes(c.verdict));

  return (
    <div className="glass flex min-h-0 flex-1 flex-col rounded-2xl">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <span className="text-[11px] font-semibold tracking-[0.22em] text-white/55">
          LIVE LOG
        </span>
        <span className="text-[10px] tracking-wide text-white/35">{shown.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        <AnimatePresence initial={false}>
          {shown.map((c) => {
            const s = STYLE[c.verdict];
            return (
              <motion.div
                key={c.i}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="mb-2 overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02]"
              >
                <div className="border-l-2 px-3 py-2.5" style={{ borderColor: s.color }}>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold tracking-[0.16em]" style={{ color: s.color }}>
                      {s.label}
                    </span>
                    {c.topic && (
                      <span className="text-[9px] uppercase tracking-[0.12em] text-white/35">
                        {c.topic}
                      </span>
                    )}
                    {c.confidence ? (
                      <span className="ml-auto mono text-[9px] text-white/30">
                        {Math.round(c.confidence * 100)}%
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-1 text-[13px] leading-snug text-white/90">
                    &ldquo;{c.claim}&rdquo;
                  </div>

                  {c.correction && c.verdict !== "true" && (
                    <div className="mt-1 text-[12px] leading-snug text-white/55">
                      {c.correction}
                    </div>
                  )}

                  {(c.source || c.via) && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {c.source && (
                        <span className="flex items-center gap-1 text-[10px] text-white/40">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                          </svg>
                          {c.source}
                        </span>
                      )}
                      {c.via === "moss" && c.moss_ms != null && (
                        <span className="ml-auto text-[9px] tracking-wide text-[var(--green)]/70">
                          Moss · {c.moss_ms}ms
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {shown.length === 0 && (
          <div className="flex h-full items-center justify-center px-4 py-10 text-center">
            <span className="text-[12px] text-white/30 soft-pulse">
              listening for claims to verify…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
