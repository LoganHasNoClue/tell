"use client";

import { motion, useSpring } from "framer-motion";
import { useEffect } from "react";
import { useTell } from "@/lib/store";

function Dial({
  value,
  left,
  right,
  title,
}: {
  value: number; // -1..1
  left: string;
  right: string;
  title: string;
}) {
  // map -1..1 to -60deg..60deg
  const angle = useSpring(value * 60, { stiffness: 120, damping: 16 });
  useEffect(() => {
    angle.set(value * 60);
  }, [value, angle]);
  const dovish = value < 0;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative h-[58px] w-[110px] overflow-hidden">
        <svg viewBox="0 0 110 60" className="h-full w-full">
          <defs>
            <linearGradient id="dialg" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3DDCFF" />
              <stop offset="50%" stopColor="#6B7280" />
              <stop offset="100%" stopColor="#FF4D5E" />
            </linearGradient>
          </defs>
          <path
            d="M 12 54 A 43 43 0 0 1 98 54"
            fill="none"
            stroke="url(#dialg)"
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.55"
          />
          {/* ticks */}
          {[-60, -30, 0, 30, 60].map((a) => {
            const rad = ((a - 90) * Math.PI) / 180;
            const x1 = 55 + 38 * Math.cos(rad);
            const y1 = 54 + 38 * Math.sin(rad);
            const x2 = 55 + 44 * Math.cos(rad);
            const y2 = 54 + 44 * Math.sin(rad);
            return (
              <line
                key={a}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="rgba(255,255,255,0.22)"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
        <motion.div
          className="absolute left-1/2 bottom-[6px] h-[40px] w-[2px] origin-bottom"
          style={{
            rotate: angle,
            x: "-50%",
            background: dovish ? "#3DDCFF" : "#FF8088",
            boxShadow: `0 0 10px ${dovish ? "#3DDCFF" : "#FF4D5E"}`,
          }}
        />
        <div className="absolute left-1/2 bottom-[3px] h-2 w-2 -translate-x-1/2 rounded-full bg-white/80" />
      </div>
      <div className="flex w-[124px] items-center justify-between">
        <span className="text-[8px] tracking-wider text-cyan-300/70">{left}</span>
        <span className="text-[8px] tracking-[0.14em] text-muted/80">{title}</span>
        <span className="text-[8px] tracking-wider text-down/70">{right}</span>
      </div>
    </div>
  );
}

function Meter({
  value,
  title,
  low,
  high,
}: {
  value: number; // 0..1
  title: string;
  low: string;
  high: string;
}) {
  const w = useSpring(value, { stiffness: 120, damping: 18 });
  useEffect(() => {
    w.set(value);
  }, [value, w]);
  const hot = value > 0.55;
  return (
    <div className="flex w-[150px] flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] tracking-[0.18em] text-muted">{title}</span>
        <span
          className={`mono tnum text-[11px] font-semibold ${
            hot ? "text-amber-300" : "text-white/70"
          }`}
        >
          {Math.round(value * 100)}
        </span>
      </div>
      <div className="relative h-[7px] w-full overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className="absolute inset-y-0 left-0 w-full rounded-full"
          style={{
            scaleX: w,
            originX: 0,
            background: hot
              ? "linear-gradient(90deg,#F0B23A,#FF8A3D)"
              : "linear-gradient(90deg,#2BD98A,#00E08A)",
            boxShadow: hot ? "0 0 12px rgba(240,150,60,0.5)" : "0 0 12px rgba(0,224,138,0.4)",
          }}
        />
        <div className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/5" />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[8px] tracking-wider text-muted/60">{low}</span>
        <span className="text-[8px] tracking-wider text-muted/60">{high}</span>
      </div>
    </div>
  );
}

export default function SubMeters() {
  const sub = useTell((s) => s.frame?.subsignals);
  const meters = useTell((s) => s.config?.submeters ?? []);
  if (!sub) return null;

  return (
    <div className="flex items-center gap-7">
      {meters.includes("hawk_dove") && sub.hawk_dove != null && (
        <Dial value={sub.hawk_dove} left="DOVISH" right="HAWKISH" title="TONE" />
      )}
      {meters.includes("momentum") && sub.momentum != null && (
        <Dial value={sub.momentum} left="RIVAL" right="HOOL" title="MOMENTUM" />
      )}
      {meters.includes("hedging") && sub.hedging != null && (
        <Meter value={sub.hedging} title="HEDGING" low="COMMITTAL" high="EVASIVE" />
      )}
      {meters.includes("dodge") && sub.hedging != null && (
        <Meter value={sub.hedging} title="DODGE" low="DIRECT" high="DODGING" />
      )}
    </div>
  );
}
