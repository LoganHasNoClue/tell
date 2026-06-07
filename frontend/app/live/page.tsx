"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Buzzer } from "@/lib/buzzer";

const API = process.env.NEXT_PUBLIC_TELL_API || "http://localhost:8000";
const CHIP_FIELDS = ["name", "age", "birthplace", "university", "company"];

interface LogEntry { id: number; label: string; verdict: "true" | "false"; correction: string; }
interface Interrupt { label: string; correction: string; }

// conservative fast-path extraction of identity claims (instant buzzer)
function extractClaims(chunk: string): { field: string; value: string }[] {
  const t = " " + chunk.toLowerCase() + " ";
  const out: { field: string; value: string }[] = [];
  let m: RegExpExecArray | null;
  const push = (re: RegExp, field: string) => {
    while ((m = re.exec(t))) out.push({ field, value: m[1].trim() });
  };
  push(/(?:my name is|name's|name is|call me|i go by|this is)\s+([a-z][a-z'-]{2,20})/g, "name");
  push(/\bi(?:'m| am)\s+(\d{1,3})(?:\s*(?:years old|year old|years|yo))?\b/g, "age");
  push(/\bi (?:was born in|grew up in)\s+([a-z][a-z .'-]{2,28})/g, "birthplace");
  push(/\bi(?:'m| am)?\s*from\s+([a-z][a-z .'-]{2,28})/g, "birthplace");
  push(/\bi (?:study at|attend|graduated from)\s+([a-z][a-z .'-]{2,38})/g, "university");
  push(/\bmy (?:university|school|college) is\s+([a-z][a-z .'-]{2,38})/g, "university");
  push(/\bi (?:founded|co-?founded|started a company called)\s+([a-z0-9][a-z0-9 .'-]{1,38})/g, "company");
  push(/\bmy (?:company|startup) is\s+([a-z0-9][a-z0-9 .'-]{1,38})/g, "company");
  return out;
}

function valuesMatch(said: string, known: string): boolean {
  const a = said.trim().toLowerCase().replace(/[.?!,]+$/, "");
  const b = known.trim().toLowerCase();
  if (!a) return true;
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
  const judgedRef = useRef<Set<string>>(new Set());
  const lastBuzzRef = useRef(0);
  const logId = useRef(1);
  const interruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) setSupported(false);
    fetch(`${API}/api/selffacts`)
      .then((r) => r.json())
      .then((d) => {
        const map: Record<string, string> = {};
        (d.fields || []).forEach((f: any) => f.field && (map[f.field] = f.value));
        setFacts(map);
        setMossOn(!!d.using_moss);
      })
      .catch(() => {});
  }, []);

  const fireFalse = useCallback((correction: string, label: string) => {
    if (Date.now() - lastBuzzRef.current < 1800) return; // dedup across paths
    lastBuzzRef.current = Date.now();
    buzzerRef.current?.play();
    setInterrupt({ label, correction });
    setCatches((c) => c + 1);
    setLog((l) => [{ id: logId.current++, label, verdict: "false" as const, correction }, ...l].slice(0, 30));
    if (interruptTimer.current) clearTimeout(interruptTimer.current);
    interruptTimer.current = setTimeout(() => setInterrupt(null), 2600);
  }, []);

  // INSTANT path: identity field mismatch (client-cached facts) + Moss confirm
  const processFast = useCallback(
    async (field: string, value: string, chunk: string) => {
      const last = cooldownRef.current[field] || 0;
      if (Date.now() - last < 2500) return;
      cooldownRef.current[field] = Date.now();

      const known = facts[field];
      if (known && !valuesMatch(value, known)) {
        fireFalse(`Your ${field} is ${known}, not ${value}.`, `${field}: ${value}`);
      }
      setMossPulse((p) => p + 1);
      try {
        const r = await fetch(`${API}/api/selfcheck`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ field, value, text: chunk }),
        });
        const v = await r.json();
        if (v.verdict === "false") fireFalse(v.correction || `That's not your ${field}.`, `${field}: ${value}`);
      } catch {
        /* offline: client check covered known fields */
      }
    },
    [facts, fireFalse]
  );

  // GENERAL path: judge any finished sentence against the dossier (Moss + LLM)
  const judgeSentence = useCallback(async (text: string) => {
    const key = text.toLowerCase().trim();
    if (key.length < 6 || judgedRef.current.has(key)) return;
    judgedRef.current.add(key);
    setMossPulse((p) => p + 1);
    try {
      const r = await fetch(`${API}/api/selfjudge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const v = await r.json();
      if (v.verdict === "false") {
        fireFalse(v.correction || "That statement is false.", v.claim || text);
      } else if (v.verdict === "true") {
        setLog((l) => [{ id: logId.current++, label: v.claim || text, verdict: "true" as const, correction: "" }, ...l].slice(0, 30));
      }
    } catch {
      /* backend offline */
    }
  }, [fireFalse]);

  const start = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    buzzerRef.current = buzzerRef.current || new Buzzer();
    buzzerRef.current.init();

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    finalRef.current = "";
    judgedRef.current = new Set();

    rec.onresult = (e: any) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) {
        finalRef.current += finalChunk + " ";
        judgeSentence(finalChunk.trim()); // general judge AFTER the sentence is spoken
      }
      setTranscript((finalRef.current + interimChunk).slice(-360));
      const chunk = `${finalChunk} ${interimChunk}`.trim();
      if (chunk) for (const c of extractClaims(chunk)) processFast(c.field, c.value, chunk); // instant identity path
    };
    rec.onend = () => {
      if (recRef.current) { try { rec.start(); } catch { /* ignore */ } }
    };

    recRef.current = rec;
    rec.start();
    setListening(true);
    setTranscript("");
    setLog([]);
    setCatches(0);
  }, [processFast, judgeSentence]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
    setListening(false);
    setInterrupt(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const chips = CHIP_FIELDS.filter((f) => facts[f]);

  return (
    <main className="vignette relative flex h-screen flex-col items-center px-6 py-6">
      <header className="flex w-full max-w-3xl items-center justify-between">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-[20px] font-bold tracking-[0.18em] text-white">TELL</Link>
          <span className="text-[12px] tracking-[0.2em] text-white/45">TRUTH MIC</span>
        </div>
        <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: mossOn ? "var(--green)" : "rgba(255,255,255,0.4)" }} />
          <span className="text-[10px] font-medium tracking-[0.16em] text-white/60">{mossOn ? "MOSS LIVE" : "MOSS (local)"}</span>
        </span>
      </header>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <span className="text-[11px] tracking-[0.18em] text-white/40">KNOWS</span>
        {chips.map((f) => (
          <span key={f} className="glass rounded-full px-3 py-1 text-[12px] text-white/75">
            {f}: <span className="text-white">{facts[f]}</span>
          </span>
        ))}
        <span className="glass rounded-full px-3 py-1 text-[12px] text-white/45">+ {Math.max(0, Object.keys(facts).length - chips.length)} more facts</span>
      </div>

      <div className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8">
        {!listening ? (
          <button onClick={start} className="glass-strong group flex flex-col items-center gap-4 rounded-[32px] px-16 py-12 transition active:scale-[0.98]">
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-black">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-wide text-white">Start listening</span>
            <span className="max-w-xs text-center text-[12px] leading-relaxed text-white/45">
              Talk about yourself. Say anything false — the wrong name, school, company, age —
              and TELL buzzes you the moment you say it.
            </span>
          </button>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3.5 w-3.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--red)] opacity-60 soft-pulse" />
                <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-[var(--red)]" />
              </span>
              <span className="text-[12px] font-semibold tracking-[0.2em] text-white/70">LISTENING</span>
              <span key={mossPulse} className="glass rounded-full px-2.5 py-1 text-[10px] tracking-wide text-[var(--green)]">⟳ Moss retrieving</span>
            </div>
            <div className="min-h-[120px] w-full max-w-2xl text-center">
              <p className="text-[26px] font-medium leading-snug text-white/90">
                {transcript || <span className="text-white/30">…</span>}
              </p>
            </div>
            <button onClick={stop} className="glass rounded-full px-5 py-2 text-[13px] font-medium text-white/80 transition active:scale-95">Stop</button>
          </>
        )}
        {!supported && (
          <div className="glass rounded-2xl px-5 py-3 text-[13px] text-[var(--amber)]">
            Live speech needs Chrome (or Safari). This browser doesn&apos;t support the Web Speech API.
          </div>
        )}
      </div>

      <div className="flex w-full max-w-3xl items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="mono tnum text-[22px] font-bold" style={{ color: catches ? "var(--red)" : "#fff" }}>{catches}</span>
          <span className="text-[11px] tracking-[0.16em] text-white/45">FALSEHOODS CAUGHT</span>
        </div>
        <div className="flex max-w-[62%] gap-2 overflow-hidden">
          <AnimatePresence initial={false}>
            {log.slice(0, 3).map((e) => (
              <motion.span key={e.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="glass flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[11px]"
                style={{ color: e.verdict === "false" ? "var(--red)" : "var(--green)" }}
                title={e.correction}>
                {e.verdict === "false" ? "✕" : "✓"} {e.label.slice(0, 34)}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {interrupt && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.08 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center"
            style={{ backgroundColor: "rgba(255,69,58,0.16)" }}>
            <motion.div initial={{ scale: 0.7 }} animate={{ scale: [0.7, 1.06, 1] }} transition={{ duration: 0.25 }} className="flex flex-col items-center">
              <div className="flex h-28 w-28 items-center justify-center rounded-full" style={{ backgroundColor: "var(--red)" }}>
                <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </div>
              <div className="mono mt-6 text-[64px] font-bold tracking-[0.1em] text-[var(--red)]">ERRT</div>
              <div className="mt-2 text-[22px] font-semibold text-white">That&apos;s false.</div>
              <div className="mt-1 max-w-xl text-[18px] text-white/85">{interrupt.correction}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
