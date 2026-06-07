"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Buzzer } from "@/lib/buzzer";

const API = process.env.NEXT_PUBLIC_TELL_API || "http://localhost:8000";

interface LogEntry {
  id: number;
  field: string;
  said: string;
  verdict: "true" | "false";
  correction: string;
  via?: string;
}

interface Interrupt {
  field: string;
  said: string;
  expected: string;
}

// pull simple self-claims out of speech, fast.
function extractClaims(chunk: string): { field: string; value: string }[] {
  const t = chunk.toLowerCase();
  const out: { field: string; value: string }[] = [];
  let m: RegExpExecArray | null;

  const reName = /(?:my name is|name's|name is|call me|i go by|this is)\s+([a-z][a-z'-]{2,20})/g;
  while ((m = reName.exec(t))) out.push({ field: "name", value: m[1] });

  const reAge = /\bi(?:'m| am)\s+(\d{1,3})(?:\s*(?:years old|year old|years|yo))?\b/g;
  while ((m = reAge.exec(t))) out.push({ field: "age", value: m[1] });

  const reLoc = /\bi(?:'m| am)?\s*(?:from|live in|based in)\s+([a-z][a-z .'-]{2,30})/g;
  while ((m = reLoc.exec(t))) out.push({ field: "location", value: m[1].trim() });

  const reEmp = /\bi work (?:at|for)\s+([a-z][a-z .'-]{2,30})/g;
  while ((m = reEmp.exec(t))) out.push({ field: "employer", value: m[1].trim() });

  return out;
}

function valuesMatch(said: string, known: string): boolean {
  const a = said.trim().toLowerCase();
  const b = known.trim().toLowerCase();
  return a === b || b.includes(a) || a.includes(b);
}

export default function LivePage() {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [interrupt, setInterrupt] = useState<Interrupt | null>(null);
  const [catches, setCatches] = useState(0);
  const [mossPulse, setMossPulse] = useState(0);
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [mossOn, setMossOn] = useState(false);

  const recRef = useRef<any>(null);
  const buzzerRef = useRef<Buzzer | null>(null);
  const finalRef = useRef("");
  const cooldownRef = useRef<Record<string, number>>({});
  const logId = useRef(1);
  const interruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) setSupported(false);
    fetch(`${API}/api/selffacts`)
      .then((r) => r.json())
      .then((d) => {
        const map: Record<string, string> = {};
        (d.fields || []).forEach((f: any) => (map[f.field] = f.value));
        setFacts(map);
        setMossOn(!!d.using_moss);
      })
      .catch(() => {});
  }, []);

  const fireFalse = useCallback((field: string, said: string, expected: string) => {
    buzzerRef.current?.play();
    setInterrupt({ field, said, expected });
    setCatches((c) => c + 1);
    setLog((l) => [
      { id: logId.current++, field, said, verdict: "false" as const, correction: `Your ${field} is ${expected}, not ${said}.`, via: "moss" },
      ...l,
    ].slice(0, 30));
    if (interruptTimer.current) clearTimeout(interruptTimer.current);
    interruptTimer.current = setTimeout(() => setInterrupt(null), 2600);
  }, []);

  const processClaim = useCallback(
    async (field: string, value: string, chunk: string) => {
      const last = cooldownRef.current[field] || 0;
      if (Date.now() - last < 2500) return; // collapse interim partials
      cooldownRef.current[field] = Date.now();

      // INSTANT client-side check against the cached (Moss-indexed) facts
      const known = facts[field];
      let alreadyFired = false;
      if (known && !valuesMatch(value, known)) {
        fireFalse(field, value, known);
        alreadyFired = true;
      }

      // Moss live retrieval + authoritative confirmation (also catches fuzzy)
      setMossPulse((p) => p + 1);
      try {
        const r = await fetch(`${API}/api/selfcheck`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ field, value, text: chunk }),
        });
        const v = await r.json();
        if (v.verdict === "false" && !alreadyFired) {
          fireFalse(field, value, v.expected || known || "?");
        } else if (v.verdict === "true") {
          setLog((l) => [
            { id: logId.current++, field, said: value, verdict: "true" as const, correction: "", via: v.via },
            ...l,
          ].slice(0, 30));
        }
      } catch {
        /* offline: client-side check already handled known fields */
      }
    },
    [facts, fireFalse]
  );

  const start = useCallback(() => {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    buzzerRef.current = buzzerRef.current || new Buzzer();
    buzzerRef.current.init(); // unlock audio on this user gesture

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    finalRef.current = "";

    rec.onresult = (e: any) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) finalRef.current += finalChunk + " ";
      setTranscript((finalRef.current + interimChunk).slice(-400));
      const chunk = `${finalChunk} ${interimChunk}`.trim();
      if (chunk) for (const c of extractClaims(chunk)) processClaim(c.field, c.value, chunk);
    };
    rec.onerror = () => {};
    rec.onend = () => {
      if (recRef.current) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }
    };

    recRef.current = rec;
    rec.start();
    setListening(true);
    setTranscript("");
    setLog([]);
    setCatches(0);
  }, [processClaim]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    setListening(false);
    setInterrupt(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return (
    <main className="vignette relative flex h-screen flex-col items-center px-6 py-6">
      {/* header */}
      <header className="flex w-full max-w-3xl items-center justify-between">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-[20px] font-bold tracking-[0.18em] text-white">
            TELL
          </Link>
          <span className="text-[12px] tracking-[0.2em] text-white/45">TRUTH MIC</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: mossOn ? "var(--green)" : "rgba(255,255,255,0.4)" }}
            />
            <span className="text-[10px] font-medium tracking-[0.16em] text-white/60">
              {mossOn ? "MOSS LIVE" : "MOSS (local)"}
            </span>
          </span>
        </div>
      </header>

      {/* known facts */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <span className="text-[11px] tracking-[0.18em] text-white/40">KNOWS</span>
        {Object.entries(facts).map(([f, v]) => (
          <span key={f} className="glass rounded-full px-3 py-1 text-[12px] text-white/75">
            {f}: <span className="text-white">{v}</span>
          </span>
        ))}
        {Object.keys(facts).length === 0 && (
          <span className="text-[12px] text-white/30">connect backend to load facts…</span>
        )}
      </div>

      {/* center: mic + transcript */}
      <div className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8">
        {!listening ? (
          <button
            onClick={start}
            className="glass-strong group flex flex-col items-center gap-4 rounded-[32px] px-16 py-12 transition active:scale-[0.98]"
          >
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-black">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-wide text-white">
              Start listening
            </span>
            <span className="max-w-xs text-center text-[12px] leading-relaxed text-white/45">
              Speak about yourself. If you say something false — say the wrong name —
              TELL will catch it instantly.
            </span>
          </button>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3.5 w-3.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--red)] opacity-60 soft-pulse" />
                <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-[var(--red)]" />
              </span>
              <span className="text-[12px] font-semibold tracking-[0.2em] text-white/70">
                LISTENING
              </span>
              <span
                key={mossPulse}
                className="glass rounded-full px-2.5 py-1 text-[10px] tracking-wide text-[var(--green)]"
              >
                ⟳ Moss retrieving
              </span>
            </div>

            <div className="min-h-[120px] w-full max-w-2xl text-center">
              <p className="text-[26px] font-medium leading-snug text-white/90">
                {transcript || <span className="text-white/30">…</span>}
              </p>
            </div>

            <button
              onClick={stop}
              className="glass rounded-full px-5 py-2 text-[13px] font-medium text-white/80 transition active:scale-95"
            >
              Stop
            </button>
          </>
        )}

        {!supported && (
          <div className="glass rounded-2xl px-5 py-3 text-[13px] text-[var(--amber)]">
            Live speech needs Chrome (or Safari). This browser doesn&apos;t support the
            Web Speech API.
          </div>
        )}
      </div>

      {/* bottom: catches + log */}
      <div className="flex w-full max-w-3xl items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="mono tnum text-[22px] font-bold" style={{ color: catches ? "var(--red)" : "#fff" }}>
            {catches}
          </span>
          <span className="text-[11px] tracking-[0.16em] text-white/45">FALSEHOODS CAUGHT</span>
        </div>
        <div className="flex max-w-[60%] gap-2 overflow-hidden">
          <AnimatePresence initial={false}>
            {log.slice(0, 4).map((e) => (
              <motion.span
                key={e.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="glass flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[11px]"
                style={{ color: e.verdict === "false" ? "var(--red)" : "var(--green)" }}
              >
                {e.verdict === "false" ? "✕" : "✓"} {e.field}: {e.said}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* THE INTERRUPT — giant red flash + ERRT */}
      <AnimatePresence>
        {interrupt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.08 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center"
            style={{ backgroundColor: "rgba(255,69,58,0.16)" }}
          >
            <motion.div
              initial={{ scale: 0.7 }}
              animate={{ scale: [0.7, 1.06, 1] }}
              transition={{ duration: 0.25 }}
              className="flex flex-col items-center"
            >
              <div
                className="flex h-28 w-28 items-center justify-center rounded-full"
                style={{ backgroundColor: "var(--red)" }}
              >
                <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </div>
              <div className="mono mt-6 text-[64px] font-bold tracking-[0.1em] text-[var(--red)]">
                ERRT
              </div>
              <div className="mt-2 text-[22px] font-semibold text-white">
                That&apos;s false.
              </div>
              <div className="mt-1 text-[18px] text-white/80">
                Your {interrupt.field} is{" "}
                <span className="font-bold text-white">{interrupt.expected}</span>, not{" "}
                <span className="font-bold text-[var(--red)]">{interrupt.said}</span>.
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
