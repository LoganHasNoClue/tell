"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTell } from "@/lib/store";
import { wallShort } from "@/lib/format";

export default function WhyFeed() {
  const why = useTell((s) => s.why);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
        <span className="text-[11px] tracking-[0.28em] text-tell font-semibold">
          WHY ▸
        </span>
        <span className="text-[11px] tracking-[0.2em] text-muted">
          THE RECEIPTS
        </span>
        <span className="ml-auto text-[10px] text-muted/70 tracking-wide">
          verbatim · model-scored
        </span>
      </div>
      <div className="relative flex-1 overflow-hidden px-2">
        <AnimatePresence initial={false}>
          {why.map((e, idx) => {
            const up = e.effect >= 0;
            return (
              <motion.div
                key={e.id}
                layout
                initial={{ opacity: 0, y: -14, scaleY: 0.6 }}
                animate={{
                  opacity: idx > 4 ? 0.35 : 1,
                  y: 0,
                  scaleY: 1,
                  backgroundColor:
                    idx === 0
                      ? ["rgba(0,224,138,0.20)", "rgba(0,224,138,0)"]
                      : "rgba(0,224,138,0)",
                }}
                transition={{
                  layout: { duration: 0.32, ease: "easeOut" },
                  backgroundColor: { duration: 0.7, ease: "easeOut" },
                  default: { duration: 0.28, ease: "easeOut" },
                }}
                className="flex items-center gap-3 rounded-md px-2.5 py-2 border-b border-white/[0.04]"
              >
                <span
                  className={`mono tnum text-[15px] font-semibold w-14 text-right shrink-0 ${
                    up ? "text-up" : "text-down"
                  }`}
                >
                  {up ? "+" : "−"}
                  {Math.abs(Math.round(e.effect * 100))}%
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] text-white/90 font-medium leading-tight">
                    &ldquo;{e.quote}&rdquo;
                  </div>
                  <div className="truncate text-[11px] text-muted leading-tight mt-0.5">
                    {e.why}
                  </div>
                </div>
                <span className="mono text-[11px] text-muted/70 shrink-0 tnum">
                  {wallShort(e.t)}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {why.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <span className="text-[12px] text-muted/50 tracking-wide animate-pulse2">
              listening for the moment that moves the number…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
