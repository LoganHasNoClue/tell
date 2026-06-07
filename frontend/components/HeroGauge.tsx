"use client";

import { useEffect, useRef } from "react";
import { motion, useSpring, useMotionValueEvent } from "framer-motion";
import { useTell } from "@/lib/store";

const R = 132;
const CIRC = 2 * Math.PI * R;
const GAP = 0.26; // fraction of ring left open at the bottom
const ARC = CIRC * (1 - GAP);

export default function HeroGauge() {
  const our = useTell((s) => s.frame?.our_prob ?? 0);
  const delta = useTell((s) => s.frame?.delta ?? 0);
  const label = useTell((s) => s.config?.hero_label ?? "P(OUT)");

  const numRef = useRef<HTMLSpanElement>(null);
  const spring = useSpring(our, { stiffness: 90, damping: 18, mass: 0.7 });
  const offset = useSpring(ARC * (1 - our), { stiffness: 90, damping: 18, mass: 0.7 });

  useEffect(() => {
    spring.set(our);
    offset.set(ARC * (1 - our));
  }, [our, spring, offset]);

  useMotionValueEvent(spring, "change", (v) => {
    if (numRef.current) numRef.current.textContent = Math.round(v * 100).toString();
  });

  const up = delta >= 0;
  const deltaPts = Math.round(Math.abs(delta) * 100);
  const showDelta = deltaPts >= 1;

  return (
    <div className="relative flex flex-col items-center justify-center select-none">
      <svg
        width={320}
        height={320}
        viewBox="0 0 320 320"
        className="overflow-visible"
        style={{ transform: "rotate(135deg)" }}
      >
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="arcgrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00E08A" />
            <stop offset="100%" stopColor="#33ffae" />
          </linearGradient>
        </defs>
        {/* track */}
        <circle
          cx="160"
          cy="160"
          r={R}
          fill="none"
          stroke="rgba(255,255,255,0.07)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${ARC} ${CIRC}`}
        />
        {/* tick marks */}
        {Array.from({ length: 11 }).map((_, i) => {
          const frac = (i / 10) * (1 - GAP);
          const ang = frac * 2 * Math.PI;
          const x1 = 160 + (R + 12) * Math.cos(ang);
          const y1 = 160 + (R + 12) * Math.sin(ang);
          const x2 = 160 + (R + 18) * Math.cos(ang);
          const y2 = 160 + (R + 18) * Math.sin(ang);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="2"
            />
          );
        })}
        {/* value arc */}
        <motion.circle
          cx="160"
          cy="160"
          r={R}
          fill="none"
          stroke="url(#arcgrad)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${ARC} ${CIRC}`}
          style={{ strokeDashoffset: offset }}
          filter="url(#glow)"
        />
      </svg>

      {/* center readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[12px] tracking-[0.32em] text-muted font-medium mb-1">
          {label}
        </div>
        <div className="flex items-start tnum mono leading-none text-glow">
          <span ref={numRef} className="text-[112px] font-semibold text-white">
            {Math.round(our * 100)}
          </span>
          <span className="text-[44px] font-medium text-white/55 mt-3 ml-1">%</span>
        </div>
        <div className="h-7 mt-1">
          {showDelta && (
            <motion.div
              key={`${up}-${deltaPts}`}
              initial={{ opacity: 0, y: up ? 6 : -6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[15px] font-semibold mono tnum ${
                up
                  ? "text-up bg-[#2BD98A]/10"
                  : "text-down bg-[#FF4D5E]/10"
              }`}
            >
              <span className="text-[13px]">{up ? "▲" : "▼"}</span>
              {up ? "+" : "−"}
              {deltaPts}%
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
