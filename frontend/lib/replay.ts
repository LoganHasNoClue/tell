import type { LoadedScenario } from "./scenarios";
import type { StateFrame, Driver, Caption, SubSignals } from "./types";

const DIVERGE_THRESHOLD = 0.05;

function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}

/**
 * Drives a precomputed scenario off a single clock `t` (seconds).
 *
 * - our_prob / market_prob / subsignals are interpolated for buttery lines.
 * - drivers fire exactly once as the clock passes each ScoreUpdate that carries
 *   them — that is the "the moment it heard the word, the screen reacted" beat.
 * - lead-time: we know when TELL crossed the level and when the market did; the
 *   "TELL led by Xs" verdict unlocks the instant the market finally crosses.
 *
 * This is the offline-safe demo engine. The exact same StateFrame shape arrives
 * from the backend WebSocket in live mode, so the UI never knows the difference.
 */
export class ReplayEngine {
  private s: LoadedScenario;
  private firedDriverIdx = new Set<number>();
  private ourCrossT: number | null = null;
  private marketCrossT: number | null = null;
  readonly leadLevel: number;
  /** video (and TELL) start at this scenario time; captions/run are in video-time */
  readonly offset: number;

  constructor(scenario: LoadedScenario) {
    this.s = scenario;
    this.leadLevel = scenario.config.lead_level;
    this.offset = scenario.config.video_offset ?? 0;
    this.computeCrossings();
  }

  private computeCrossings() {
    const level = this.leadLevel;
    // first upward crossing of TELL
    for (let i = 1; i < this.s.run.length; i++) {
      if (this.s.run[i - 1].our_prob < level && this.s.run[i].our_prob >= level) {
        this.ourCrossT = this.s.run[i].t;
        break;
      }
    }
    // first upward crossing of market
    for (let i = 1; i < this.s.market.length; i++) {
      if (this.s.market[i - 1].p < level && this.s.market[i].p >= level) {
        this.marketCrossT = this.s.market[i].t;
        break;
      }
    }
  }

  get leadTimeS(): number | null {
    if (this.ourCrossT == null || this.marketCrossT == null) return null;
    return Math.round((this.marketCrossT - this.ourCrossT) * 10) / 10;
  }

  /** Whether the "TELL led by Xs" verdict should be visible at clock t. */
  leadProven(t: number): boolean {
    return this.marketCrossT != null && t >= this.marketCrossT;
  }

  get duration() {
    return this.s.config.duration;
  }

  private interp<T>(
    arr: { t: number }[],
    t: number,
    pick: (i: number) => number
  ): number {
    if (arr.length === 0) return 0;
    if (t <= arr[0].t) return pick(0);
    if (t >= arr[arr.length - 1].t) return pick(arr.length - 1);
    // binary search
    let lo = 0;
    let hi = arr.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const span = arr[hi].t - arr[lo].t || 1;
    const f = (t - arr[lo].t) / span;
    return lerp(pick(lo), pick(hi), f);
  }

  private sampleSub(t: number): SubSignals {
    const run = this.s.run;
    // nearest-preceding (step) for sub-signals reads cleaner than interpolated
    let idx = 0;
    for (let i = 0; i < run.length; i++) {
      if (run[i].t <= t) idx = i;
      else break;
    }
    return run[idx]?.subsignals ?? { hawk_dove: null, hedging: null, momentum: null };
  }

  /** Current caption (lower-third) at time t. Null before the video starts. */
  caption(t: number): Caption | null {
    const vt = t - this.offset;
    if (vt < -0.05) return null;
    const c = this.s.captions;
    let cur: Caption | null = null;
    for (const cap of c) {
      if (cap.t <= vt + 0.05) cur = cap;
      else break;
    }
    return cur;
  }

  /** Build the StateFrame for clock time t. (run/subsignals are in video-time) */
  frame(t: number): StateFrame {
    const vt = t - this.offset;
    const our = this.interp(this.s.run, vt, (i) => this.s.run[i].our_prob);
    const market = this.interp(this.s.market, t, (i) => this.s.market[i].p);
    const lead = our - market;
    // local delta over a 2s window for the hero arrow
    const prev = this.interp(this.s.run, vt - 2, (i) => this.s.run[i].our_prob);
    return {
      t,
      our_prob: our,
      market_prob: market,
      lead,
      diverging: Math.abs(lead) >= DIVERGE_THRESHOLD,
      delta: our - prev,
      drivers: [],
      subsignals: this.sampleSub(vt),
      outcome_label: this.s.config.outcome_label,
    };
  }

  /**
   * Returns drivers that newly fired between the previous clock and now.
   * Call once per tick with monotonically increasing t.
   */
  driversBetween(prevT: number, t: number): { t: number; driver: Driver }[] {
    const vPrev = prevT - this.offset;
    const vT = t - this.offset;
    const out: { t: number; driver: Driver }[] = [];
    for (let i = 0; i < this.s.run.length; i++) {
      const u = this.s.run[i];
      if (u.t <= vT && u.t > vPrev && u.drivers.length > 0 && !this.firedDriverIdx.has(i)) {
        this.firedDriverIdx.add(i);
        // surface drivers at scenario time so the WHY feed timestamp matches the clock
        for (const d of u.drivers) out.push({ t: u.t + this.offset, driver: d });
      }
    }
    return out;
  }

  /** Reset fired-driver memory (on seek-back / restart). */
  resetFrom(t: number) {
    const vt = t - this.offset;
    this.firedDriverIdx.clear();
    for (let i = 0; i < this.s.run.length; i++) {
      if (this.s.run[i].t <= vt && this.s.run[i].drivers.length > 0) {
        this.firedDriverIdx.add(i);
      }
    }
  }
}

export { DIVERGE_THRESHOLD };
