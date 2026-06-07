// Streams the playing video's audio as raw PCM frames to the main thread.
// Buffers ~85ms per message to keep postMessage volume sane.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this._buf.push(ch.slice(0));
      this._n += ch.length;
      if (this._n >= 4096) {
        const out = new Float32Array(this._n);
        let o = 0;
        for (const b of this._buf) {
          out.set(b, o);
          o += b.length;
        }
        this.port.postMessage(out);
        this._buf = [];
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
