"use client";

import { AnimatePresence } from "framer-motion";
import { useFC } from "@/lib/fc";
import VerdictPopup from "./VerdictPopup";

/** Transient flagged-claim popups that float over the top-right of the video. */
export default function VerdictStack() {
  const popups = useFC((s) => s.popups);
  const dismiss = useFC((s) => s.dismissPopup);

  return (
    <div className="pointer-events-none absolute right-4 top-16 z-10 flex w-[320px] flex-col gap-2.5">
      <AnimatePresence initial={false}>
        {popups.map((p) => (
          <div key={p.key} className="pointer-events-auto">
            <VerdictPopup claim={p.claim} onClose={() => dismiss(p.key)} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
