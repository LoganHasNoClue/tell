"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFC } from "@/lib/fc";

const DOT: Record<string, string> = {
  false: "var(--red)",
  misleading: "var(--amber)",
  true: "var(--green)",
};

export default function VerdictFeed() {
  const log = useFC((s) => s.log);
  // show flagged + true (skip unverified/opinion noise)
  const shown = log.filter((c) => ["false", "misleading", "true"].includes(c.verdict));

  return (
    <div className="glass flex min-h-0 flex-1 flex-col rounded-2xl">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <span className="text-[11px] font-semibold tracking-[0.22em] text-white/55">
          LIVE LOG
        </span>
        <span className="text-[10px] tracking-wide text-white/35">{shown.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <AnimatePresence initial={false}>
          {shown.map((c) => (
            <motion.div
              key={c.i}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="flex gap-2.5 rounded-xl px-2.5 py-2"
            >
              <span
                className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: DOT[c.verdict] }}
              />
              <div className="min-w-0">
                <div className="truncate text-[12.5px] text-white/85">
                  &ldquo;{c.claim}&rdquo;
                </div>
                {c.correction && c.verdict !== "true" && (
                  <div className="truncate text-[11px] text-white/45">{c.correction}</div>
                )}
              </div>
            </motion.div>
          ))}
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
