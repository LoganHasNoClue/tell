"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTell } from "@/lib/store";

export default function LeadBadge() {
  const proven = useTell((s) => s.leadProven);
  const leadTimeS = useTell((s) => s.leadTimeS);
  const level = useTell((s) => s.leadLevel);

  const show = proven && leadTimeS != null && leadTimeS > 0;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -10, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2"
        >
          <div className="flex items-center gap-2 rounded-full border border-tell/40 bg-black/80 px-4 py-1.5 shadow-tell backdrop-blur">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00E08A" strokeWidth="2.5">
              <path d="M13 2 L3 14 h7 l-1 8 L19 10 h-7 z" />
            </svg>
            <span className="text-[12px] font-semibold tracking-wide text-white">
              TELL read it{" "}
              <span className="mono tnum text-tell text-glow">
                {leadTimeS}s
              </span>{" "}
              before the market
            </span>
            <span className="mono text-[10px] text-muted">
              @ {Math.round(level * 100)}%
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
