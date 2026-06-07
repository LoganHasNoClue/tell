"use client";

/**
 * Buzzer: plays the sped-up "wrong answer" sound effect (/buzzer.mp3), decoded
 * once into an AudioBuffer on init() so playback has ZERO latency (no fetch on
 * fire). Falls back to a synthesized tone if the file can't be decoded.
 * init() must run on a user gesture (the Start button) to unlock audio.
 */
export class Buzzer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;

  init() {
    if (!this.ctx) {
      const AC = (window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      });
      this.ctx = new (AC.AudioContext || AC.webkitAudioContext!)();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (!this.buffer && !this.loading) this.loading = this.load();
  }

  private async load() {
    try {
      const res = await fetch("/buzzer.mp3", { cache: "force-cache" });
      const arr = await res.arrayBuffer();
      this.buffer = await this.ctx!.decodeAudioData(arr);
    } catch (e) {
      console.warn("[buzzer] sample load failed; using synth fallback", e);
    }
  }

  play() {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    if (ctx.state === "suspended") ctx.resume();
    if (this.buffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      const g = ctx.createGain();
      g.gain.value = 1.0;
      src.connect(g);
      g.connect(ctx.destination);
      src.start();
      return;
    }
    this.synth();
  }

  private synth(durationMs = 600) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const dur = durationMs / 1000;
    const master = ctx.createGain();
    master.connect(ctx.destination);
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.95, now + 0.008);
    master.gain.setValueAtTime(0.95, now + dur - 0.06);
    master.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    for (const [type, freq, gain] of [
      ["square", 185, 0.5],
      ["square", 233, 0.5],
      ["sawtooth", 92.5, 0.4],
    ] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, now);
      o.frequency.exponentialRampToValueAtTime(freq * 0.8, now + dur);
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(master);
      o.start(now);
      o.stop(now + dur + 0.02);
    }
  }
}
