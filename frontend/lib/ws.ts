import type { StateFrame } from "./types";

export interface TellSocketHandlers {
  onMeta?: (meta: any) => void;
  onFrame?: (frame: StateFrame) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (e: unknown) => void;
}

/**
 * Thin client for the backend StateFrame stream (the "real pipeline" path).
 * The UI default is the local replay engine — this is opt-in via the LIVE
 * toggle / NEXT_PUBLIC_TELL_WS, and any failure falls back to local cleanly.
 */
export class TellSocket {
  private ws: WebSocket | null = null;
  constructor(
    private url: string,
    private scenario: string,
    private mode: "demo" | "live",
    private h: TellSocketHandlers
  ) {}

  connect() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.h.onError?.(e);
      return;
    }
    this.ws.onopen = () => {
      this.ws?.send(
        JSON.stringify({ scenario: this.scenario, mode: this.mode })
      );
      this.h.onOpen?.();
    };
    this.ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "meta") this.h.onMeta?.(msg);
      else if (msg.type === "frame") this.h.onFrame?.(msg as StateFrame);
    };
    this.ws.onclose = () => this.h.onClose?.();
    this.ws.onerror = (e) => this.h.onError?.(e);
  }

  send(cmd: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(cmd));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
