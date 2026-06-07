"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTell } from "@/lib/store";

export default function DivergenceFlag() {
  const frame = useTell((s) => s.frame);
  const t = useTell((s) => s.t);
  const off = useTell((s) => s.config?.video_offset ?? 0);
  const started = t >= off;
  const diverging = (frame?.diverging ?? false) && started;
  const lead = frame?.lead ?? 0;
  const our = frame?.our_prob ?? 0;
  const market = frame?.market_prob ?? 0;
  // TELL "leads" whenever it has diverged from the market — in EITHER direction.
  // up = TELL reads higher than the market; down = TELL reads lower (moved first).
  const up = lead >= 0;
  const pts = Math.abs(Math.round(lead * 100));

  return (
    <div className="h-[88px] flex items-center justify-center">
      <AnimatePresence>
        {diverging && (
          <motion.div
            initial={{ opacity: 0, scale: 0.86, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: -6 }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
            className="relative w-full overflow-hidden rounded-xl border border-tell/40 bg-tell/[0.08] px-5 py-3 shadow-flag"
          >
            {/* sweep shimmer */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="absolute inset-y-0 w-1/3 bg-tell/10 blur-xl animate-sweep" />
            </div>
            <div className="relative flex items-center justify-between">
              <div>
                <div className="text-[11px] tracking-[0.3em] font-bold text-tell">
                  DIVERGENCE
                </div>
                <div className="mt-0.5 text-[20px] font-bold text-white leading-none">
                  TELL LEADS
                </div>
                <div className="mt-1 text-[10px] tracking-[0.16em] text-muted">
                  THE MARKET HASN&apos;T REPRICED
                </div>
              </div>
              <div className="text-right">
                <div className="mono tnum text-[40px] font-bold leading-none text-tell text-glow">
                  {up ? "▲" : "▼"}
                  {pts}
                </div>
                <div className="mono tnum text-[12px] text-muted mt-1">
                  TELL {Math.round(our * 100)}% · market {Math.round(market * 100)}%
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
