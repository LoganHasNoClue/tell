export function pct(x: number, d = 0): string {
  return `${(x * 100).toFixed(d)}%`;
}

export function pctNum(x: number, d = 0): string {
  return (x * 100).toFixed(d);
}

export function signedPts(x: number): string {
  const v = Math.round(x * 100);
  return `${v >= 0 ? "+" : ""}${v}`;
}

export function signedPctDelta(x: number, d = 0): string {
  const v = x * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}

/** video-time seconds -> mm:ss for the scrubber */
export function clock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** map video time onto a faux broadcast wall clock (starts 14:00:00) */
const BASE = 14 * 3600;
export function wall(t: number): string {
  const total = BASE + Math.floor(t);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function wallShort(t: number): string {
  const total = BASE + Math.floor(t);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${(14).toString()}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")}`;
}
