"use client";

import { useEffect, useRef } from "react";
import { useTell } from "@/lib/store";

const PAD = { top: 16, right: 52, bottom: 22, left: 14 };

export default function TapeChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mode = useTell((s) => s.config?.mode ?? "fed");
  const off = useTell((s) => s.config?.video_offset ?? 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    // auto-ranging Y domain: eases toward the data's min/max so any real
    // scenario (0.03–0.30 or 0.45–0.85) renders centered, trading-terminal style.
    let dlo = mode === "fed" ? 0.45 : 0.3;
    let dhi = mode === "fed" ? 0.85 : 0.72;
    let domainInit = false;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap!.clientWidth;
      const h = wrap!.clientHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    function draw() {
      const st = useTell.getState();
      const series = st.series;
      const duration = st.duration || 120;
      const w = wrap!.clientWidth;
      const h = wrap!.clientHeight;
      ctx.clearRect(0, 0, w, h);

      const x0 = PAD.left;
      const x1 = w - PAD.right;
      const y0 = PAD.top;
      const y1 = h - PAD.bottom;

      // auto-range: ease the domain toward the data's extents (+padding)
      if (series.length >= 2) {
        let mn = 1;
        let mx = 0;
        for (const pt of series) {
          mn = Math.min(mn, pt.our, pt.market);
          mx = Math.max(mx, pt.our, pt.market);
        }
        let tlo = mn - 0.05;
        let thi = mx + 0.05;
        if (thi - tlo < 0.18) {
          const mid = (tlo + thi) / 2;
          tlo = mid - 0.09;
          thi = mid + 0.09;
        }
        tlo = Math.max(0, tlo);
        thi = Math.min(1, thi);
        if (!domainInit) {
          dlo = tlo;
          dhi = thi;
          domainInit = true;
        } else {
          dlo += (tlo - dlo) * 0.08;
          dhi += (thi - dhi) * 0.08;
        }
      }
      const lo = dlo;
      const hi = dhi;

      const X = (t: number) => x0 + (t / duration) * (x1 - x0);
      const Y = (p: number) =>
        y1 - ((p - lo) / (hi - lo)) * (y1 - y0);

      // ---- grid ----
      ctx.lineWidth = 1;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      const step = hi - lo > 0.4 ? 0.1 : 0.05;
      for (let p = Math.ceil(lo / step) * step; p <= hi + 1e-9; p += step) {
        const y = Y(p);
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.32)";
        ctx.textAlign = "left";
        ctx.fillText(`${Math.round(p * 100)}`, x1 + 8, y);
      }
      // vertical time ticks
      for (let t = 0; t <= duration; t += 20) {
        const x = X(t);
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.stroke();
      }

      if (series.length < 2) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // TELL only exists once the speech starts (scenario t >= video_offset)
      const tell = off > 0 ? series.filter((p) => p.t >= off) : series;

      // ---- divergence gap shading (only where TELL exists) ----
      if (tell.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(X(tell[0].t), Y(tell[0].our));
        for (const pt of tell) ctx.lineTo(X(pt.t), Y(pt.our));
        for (let i = tell.length - 1; i >= 0; i--)
          ctx.lineTo(X(tell[i].t), Y(tell[i].market));
        ctx.closePath();
        const lastT = tell[tell.length - 1];
        ctx.fillStyle = lastT.our >= lastT.market
          ? "rgba(0,224,138,0.10)"
          : "rgba(255,77,94,0.09)";
        ctx.fill();
      }

      // ---- market line (muted) — full timeline ----
      ctx.lineJoin = "round";
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#8A8F98";
      ctx.setLineDash([]);
      ctx.beginPath();
      series.forEach((pt, i) =>
        i ? ctx.lineTo(X(pt.t), Y(pt.market)) : ctx.moveTo(X(pt.t), Y(pt.market))
      );
      ctx.stroke();

      // ---- TELL line (accent, glow) ----
      if (tell.length >= 2) {
        ctx.save();
        ctx.shadowColor = "rgba(0,224,138,0.55)";
        ctx.shadowBlur = 14;
        ctx.lineWidth = 2.8;
        ctx.strokeStyle = "#00E08A";
        ctx.beginPath();
        tell.forEach((pt, i) =>
          i ? ctx.lineTo(X(pt.t), Y(pt.our)) : ctx.moveTo(X(pt.t), Y(pt.our))
        );
        ctx.stroke();
        ctx.restore();
      }

      // ---- playhead + dots ----
      const last = series[series.length - 1];
      const px = X(last.t);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, y0);
      ctx.lineTo(px, y1);
      ctx.stroke();

      // market dot
      ctx.fillStyle = "#8A8F98";
      ctx.beginPath();
      ctx.arc(px, Y(last.market), 3, 0, Math.PI * 2);
      ctx.fill();

      // TELL dot (glowing) — only once the read has begun
      if (last.t >= off) {
        ctx.save();
        ctx.shadowColor = "rgba(0,224,138,0.9)";
        ctx.shadowBlur = 16;
        ctx.fillStyle = "#00E08A";
        ctx.beginPath();
        ctx.arc(px, Y(last.our), 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(px, Y(last.our), 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [mode, off]);

  return (
    <div ref={wrapRef} className="absolute inset-0 gridtex">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
