"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useFC } from "@/lib/fc";

export default function FCStage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const registerVideo = useFC((s) => s.registerVideo);
  const config = useFC((s) => s.config);
  const caption = useFC((s) => s.caption);
  const analyzing = useFC((s) => s.analyzing);
  const playing = useFC((s) => s.playing);
  const live = useFC((s) => s.live);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    registerVideo(videoRef.current);
    return () => registerVideo(null);
  }, [registerVideo, config?.id]);

  return (
    <div className="vignette relative aspect-video w-full overflow-hidden rounded-[28px] bg-black hairline">
      {config && (
        <video
          ref={videoRef}
          src={config.video}
          muted={muted}
          playsInline
          preload="auto"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {/* top chrome — minimal */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between p-4">
        <div className="glass flex items-center gap-2 rounded-full px-3 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--red)] blink" />
          <span className="text-[10px] font-semibold tracking-[0.22em] text-white/90">
            LIVE
          </span>
        </div>
        <button
          onClick={() => {
            const n = !muted;
            setMuted(n);
            if (videoRef.current) videoRef.current.muted = n;
          }}
          className="glass flex h-8 w-8 items-center justify-center rounded-full transition active:scale-95"
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            </svg>
          )}
        </button>
      </div>

      {/* analyzing indicator */}
      <AnimatePresence>
        {analyzing && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute left-4 top-16"
          >
            <div className="glass flex items-center gap-2 overflow-hidden rounded-full px-3 py-1.5">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--blue)] opacity-60 soft-pulse" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--blue)]" />
              </span>
              <span className="text-[11px] font-medium tracking-wide text-white/85">
                {live ? "Querying Moss…" : "Checking claim…"}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* live transcript lower-third */}
      <div className="absolute bottom-0 left-0 right-0 p-4">
        <div className="glass-strong relative overflow-hidden rounded-2xl px-4 py-3">
          {analyzing && (
            <div className="pointer-events-none absolute inset-0">
              <div className="scan-shimmer absolute inset-y-0 w-1/3 bg-white/[0.06]" />
            </div>
          )}
          <div className="relative flex items-center gap-2">
            <span className="text-[9px] font-semibold tracking-[0.24em] text-white/45">
              TRANSCRIPT
            </span>
            {!playing && (
              <span className="text-[9px] tracking-[0.16em] text-white/30">· paused</span>
            )}
          </div>
          <div className="relative mt-1 line-clamp-2 h-[44px] overflow-hidden text-[15px] leading-snug text-white/90">
            {(caption.length > 150 ? "…" + caption.slice(-150) : caption) || " "}
          </div>
        </div>
      </div>
    </div>
  );
}
