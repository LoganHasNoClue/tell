"use client";

/**
 * A harsh "ERRT" game-show buzzer, synthesized with the Web Audio API so it
 * fires with ZERO load latency (no asset fetch). Must be init()'d on a user
 * gesture (the Start button) so the browser lets it play.
 */
export class Buzzer {
  private ctx: AudioContext | null = null;

  init() {
    if (!this.ctx) {
      const AC =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
      this.ctx = new (AC.AudioContext || AC.webkitAudioContext!)();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  play(durationMs = 700) {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const dur = durationMs / 1000;

    const master = ctx.createGain();
    master.connect(ctx.destination);
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.95, now + 0.008);
    master.gain.setValueAtTime(0.95, now + dur - 0.06);
    master.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    // detuned squares (harsh) + a low saw (body); slight downward pitch = "errt"
    const voices: [OscillatorType, number, number][] = [
      ["square", 185, 0.5],
      ["square", 233, 0.5],
      ["sawtooth", 92.5, 0.4],
    ];
    for (const [type, freq, gain] of voices) {
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
