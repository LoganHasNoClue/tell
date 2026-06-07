"use client";

import { motion } from "framer-motion";
import type { Claim } from "@/lib/fc";

const STYLE: Record<string, { color: string; label: string; icon: string }> = {
  false: { color: "var(--red)", label: "FALSE", icon: "✕" },
  misleading: { color: "var(--amber)", label: "MISLEADING", icon: "!" },
  true: { color: "var(--green)", label: "TRUE", icon: "✓" },
};

export default function VerdictPopup({
  claim,
  onClose,
  compact = false,
}: {
  claim: Claim;
  onClose?: () => void;
  compact?: boolean;
}) {
  const s = STYLE[claim.verdict] ?? STYLE.misleading;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 28, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 28, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 340, damping: 26 }}
      className="glass-strong relative w-full overflow-hidden rounded-2xl"
    >
      {/* solid left accent bar (no gradient) */}
      <div className="absolute left-0 top-0 h-full w-1" style={{ backgroundColor: s.color }} />
      <div className={compact ? "py-2.5 pl-4 pr-3" : "py-3.5 pl-5 pr-4"}>
        <div className="flex items-center gap-2">
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-black"
            style={{ backgroundColor: s.color }}
          >
            {s.icon}
          </span>
          <span className="text-[11px] font-bold tracking-[0.18em]" style={{ color: s.color }}>
            {s.label}
          </span>
          {claim.topic && (
            <span className="text-[10px] tracking-[0.12em] text-white/35 uppercase">
              {claim.topic}
            </span>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="ml-auto text-white/30 transition hover:text-white/70"
              aria-label="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className={`mt-1.5 font-medium text-white ${compact ? "text-[13px]" : "text-[14px]"}`}>
          &ldquo;{claim.claim}&rdquo;
        </div>

        {claim.correction && (
          <div className={`mt-1.5 leading-snug text-white/65 ${compact ? "text-[12px]" : "text-[13px]"}`}>
            {claim.correction}
          </div>
        )}

        {claim.source && (
          <div className="mt-2 flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/35">
              <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <span className="text-[10px] tracking-wide text-white/40">{claim.source}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
