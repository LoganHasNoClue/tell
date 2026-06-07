"use client";

import { useFC } from "@/lib/fc";

function Stat({
  label,
  value,
  color,
  big = false,
}: {
  label: string;
  value: number;
  color?: string;
  big?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span
        className={`mono tnum font-semibold leading-none ${big ? "text-[40px]" : "text-[28px]"}`}
        style={{ color: color ?? "#fff" }}
      >
        {value}
      </span>
      <span className="mt-1 text-[10px] font-medium tracking-[0.14em] text-white/40 uppercase">
        {label}
      </span>
    </div>
  );
}

export default function CounterCard() {
  const c = useFC((s) => s.counter);
  const mode = useFC((s) => s.mode);

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-[0.22em] text-white/55">
          FACT-CHECK
        </span>
        <span className="flex items-center gap-1.5 text-[10px] tracking-wide text-white/40">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--green)] blink" />
          retrieval: {mode || "…"}
        </span>
      </div>

      <div className="mt-4 flex items-end gap-6">
        <Stat label="checked" value={c.checked} big />
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="glass rounded-xl px-3 py-2.5">
          <Stat label="false" value={c.false} color="var(--red)" />
        </div>
        <div className="glass rounded-xl px-3 py-2.5">
          <Stat label="misleading" value={c.misleading} color="var(--amber)" />
        </div>
        <div className="glass rounded-xl px-3 py-2.5">
          <Stat label="true" value={c.true} color="var(--green)" />
        </div>
      </div>
    </div>
  );
}
