"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Buzzer } from "@/lib/buzzer";

const API = process.env.NEXT_PUBLIC_TELL_API || "http://localhost:8000";

interface LogEntry { id: number; label: string; verdict: "true" | "false"; correction: string; }
interface Interrupt { label: string; correction: string; }

// generic words that aren't real claim values (avoid false buzzes)
const STOP = new Set([
  "the", "a", "an", "my", "this", "that", "here", "there", "home", "work",
  "school", "college", "university", "gym", "store", "place", "company",
  "startup", "business", "it", "them", "us", "you", "people", "everyone",
]);

function cleanValue(v: string): string | null {
  const s = v.trim().replace(/[.?!,]+$/, "");
  const first = s.split(/\s+/)[0];
  if (s.length < 2 || STOP.has(s.toLowerCase()) || STOP.has(first.toLowerCase())) return null;
  return s;
}

// fast-path extraction of identity claims -> instant (0ms client / ~4ms Moss) buzzer
function extractClaims(chunk: string): { field: string; value: string }[] {
  const t = " " + chunk.toLowerCase() + " ";
  const out: { field: string; value: string }[] = [];
  let m: RegExpExecArray | null;
  const push = (re: RegExp, field: string) => {
    while ((m = re.exec(t))) {
      const v = cleanValue(m[1]);
      if (v) out.push({ field, value: v });
    }
  };
  push(/(?:my name is|name's|name is|call me|i go by|i'm called|this is)\s+([a-z][a-z'-]{1,20})/g, "name");
  push(/\bi(?:'m| am)\s+(\d{1,3})(?:\s*(?:years old|year old|years|yo))?\b/g, "age");
  push(/\bi (?:was born in|grew up in)\s+([a-z][a-z .'-]{2,28})/g, "birthplace");
  push(/\bi(?:'m| am)\s+from\s+([a-z][a-z .'-]{2,28})/g, "birthplace");
  push(/\bi (?:went to|go to|studied at|study at|attend|graduated from|am a student at)\s+([a-z][a-z .'-]{2,38})/g, "university");
  push(/\bmy (?:university|school|college) is\s+([a-z][a-z .'-]{2,38})/g, "university");
  push(/\bi (?:founded|co-?founded|started|built|created|run|own)\s+([a-z0-9][a-z0-9 .'-]{1,38})/g, "company");
  push(/\bi(?:'m| am)\s+the\s+(?:founder|ceo|co-?founder)\s+of\s+([a-z0-9][a-z0-9 .'-]{1,38})/g, "company");
  push(/\bmy (?:company|startup) is\s+([a-z0-9][a-z0-9 .'-]{1,38})/g, "company");
  push(/\bi work (?:at|for)\s+([a-z0-9][a-z0-9 .'-]{2,38})/g, "company");
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
  const [allFacts, setAllFacts] = useState<{ field?: string; value?: string; text: string; topic?: string }[]>([]);
  const [factsOpen, setFactsOpen] = useState(false);
  const [mossOn, setMossOn] = useState(false);
  const [level, setLevel] = useState(0); // live mic input level (0..1)
  const [roast, setRoast] = useState(false); // voice-agent roast mode

  const recRef = useRef<any>(null);
  const buzzerRef = useRef<Buzzer | null>(null);
  const finalRef = useRef("");
  const cooldownRef = useRef<Record<string, number>>({});
  const judgedRef = useRef<Set<string>>(new Set());
  const lastBuzzRef = useRef(0);
  const logId = useRef(1);
  const interruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const judgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterRaf = useRef(0);
  const roastRef = useRef(false);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const lastResultRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) setSupported(false);
    fetch(`${API}/api/selffacts`)
      .then((r) => r.json())
      .then((d) => {
        const map: Record<string, string> = {};
        (d.fields || []).forEach((f: any) => f.field && (map[f.field] = f.value));
        setFacts(map);
        setAllFacts(d.facts || []);
        setMossOn(!!d.using_moss);
      })
      .catch(() => {});
    // preload TTS voices for the roast agent
    const loadVoices = () => { voicesRef.current = window.speechSynthesis?.getVoices() || []; };
    loadVoices();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  useEffect(() => { roastRef.current = roast; }, [roast]);

  const speak = useCallback((text: string) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.08;
      u.pitch = 1.0;
      u.volume = 1.0;
      const vs = voicesRef.current.length ? voicesRef.current : synth.getVoices();
      const pick =
        vs.find((v) => /daniel/i.test(v.name)) ||
        vs.find((v) => /google uk english male|google us english/i.test(v.name)) ||
        vs.find((v) => /samantha|alex|aaron/i.test(v.name)) ||
        vs.find((v) => v.lang?.startsWith("en"));
      if (pick) u.voice = pick;
      synth.cancel();
      synth.speak(u);
    } catch {
      /* TTS optional */
    }
  }, []);

  const doRoast = useCallback(async (claim: string, correction: string) => {
    try {
      const r = await fetch(`${API}/api/roast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim, correction }),
      });
      const d = await r.json();
      if (d.line) speak(d.line);
    } catch {
      speak("yeah, that's not true. nice try.");
    }
  }, [speak]);

  const fireFalse = useCallback((correction: string, label: string) => {
    if (Date.now() - lastBuzzRef.current < 1800) return; // dedup across paths
    lastBuzzRef.current = Date.now();
    buzzerRef.current?.play();
    if (roastRef.current) doRoast(label, correction); // voice agent talks back
    setInterrupt({ label, correction });
    setCatches((c) => c + 1);
    setLog((l) => [{ id: logId.current++, label, verdict: "false" as const, correction }, ...l].slice(0, 30));
    if (interruptTimer.current) clearTimeout(interruptTimer.current);
    interruptTimer.current = setTimeout(() => setInterrupt(null), 2600);
  }, [doRoast]);

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

  // live mic VU meter (separate stream) so the user can SEE it's hearing them
  const setupMeter = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new AC();
      meterCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        meterRaf.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter is optional — recognition still runs */
    }
  }, []);

  const start = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    buzzerRef.current = buzzerRef.current || new Buzzer();
    buzzerRef.current.init();
    setupMeter();

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    finalRef.current = "";
    judgedRef.current = new Set();

    rec.onresult = (e: any) => {
      lastResultRef.current = Date.now();
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
      // general judge on interim too (debounced) so non-identity claims don't
      // wait for the sentence-end pause
      const interim = interimChunk.trim();
      if (interim.length > 10) {
        if (judgeTimer.current) clearTimeout(judgeTimer.current);
        judgeTimer.current = setTimeout(() => judgeSentence(interim), 280);
      }
    };
    rec.onerror = (e: any) => {
      // permission errors are fatal; everything else (no-speech, network,
      // audio-capture, aborted) recovers via the onend restart below.
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        recRef.current = null;
        setListening(false);
      }
    };
    rec.onend = () => {
      // Chrome ends recognition periodically (and after silence). Restart it
      // immediately so it never stops hearing you mid-session.
      if (recRef.current) {
        try {
          rec.start();
        } catch {
          setTimeout(() => {
            try {
              if (recRef.current) rec.start();
            } catch {
              /* ignore */
            }
          }, 200);
        }
      }
    };

    recRef.current = rec;
    rec.start();
    lastResultRef.current = Date.now();
    // backstop watchdog: if recognition silently dies (no results for a while),
    // restart it. start() throws harmlessly if it's actually still running.
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    watchdogRef.current = setInterval(() => {
      if (recRef.current && Date.now() - lastResultRef.current > 8000) {
        try { recRef.current.start(); } catch { /* already running */ }
      }
    }, 4000);
    setListening(true);
    setTranscript("");
    setLog([]);
    setCatches(0);
  }, [processFast, judgeSentence, setupMeter]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    // teardown the VU meter
    if (meterRaf.current) cancelAnimationFrame(meterRaf.current);
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    meterCtxRef.current?.close().catch(() => {});
    meterCtxRef.current = null;
    setLevel(0);
    setListening(false);
    setInterrupt(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return (
    <main className="vignette relative flex h-screen flex-col items-center px-6 py-6">
      <header className="flex w-full max-w-3xl items-center justify-between">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-[20px] font-bold tracking-[0.18em] text-white">TELL</Link>
          <span className="text-[12px] tracking-[0.2em] text-white/45">TRUTH MIC</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setRoast((r) => !r)}
            className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 transition active:scale-95"
            title="Roast mode: a voice agent talks back with attitude when you lie"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={roast ? "var(--amber)" : "rgba(255,255,255,0.5)"} strokeWidth="2">
              <path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9 9 0 0 1 0 14" />
            </svg>
            <span className="text-[10px] font-semibold tracking-[0.16em]" style={{ color: roast ? "var(--amber)" : "rgba(255,255,255,0.6)" }}>
              ROAST {roast ? "ON" : "OFF"}
            </span>
          </button>
          <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: mossOn ? "var(--green)" : "rgba(255,255,255,0.4)" }} />
            <span className="text-[10px] font-medium tracking-[0.16em] text-white/60">{mossOn ? "MOSS LIVE" : "MOSS (local)"}</span>
          </span>
        </div>
      </header>

      <div className="relative mt-6 flex justify-center">
        <div className="relative">
          <button
            onClick={() => setFactsOpen((o) => !o)}
            className="glass flex items-center gap-2 rounded-full px-4 py-1.5 transition active:scale-95"
          >
            <span className="text-[11px] tracking-[0.18em] text-white/45">KNOWS</span>
            <span className="text-[12px] text-white/85">{allFacts.length} facts about you</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2"
              style={{ transform: factsOpen ? "rotate(180deg)" : "none", transition: "transform 150ms" }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <AnimatePresence>
            {factsOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="glass-strong absolute left-1/2 z-30 mt-2 max-h-[52vh] w-[min(90vw,640px)] -translate-x-1/2 overflow-y-auto rounded-2xl p-2"
              >
                {allFacts.map((f, i) => (
                  <div key={i} className="flex gap-3 border-b border-white/[0.05] px-3 py-2 text-[13px] last:border-0">
                    {f.field ? (
                      <>
                        <span className="w-28 shrink-0 text-white/45">{f.field}</span>
                        <span className="text-white">{f.value}</span>
                      </>
                    ) : (
                      <span className="leading-snug text-white/80">{f.text}</span>
                    )}
                  </div>
                ))}
                {allFacts.length === 0 && (
                  <div className="px-3 py-3 text-[12px] text-white/40">connect backend to load facts…</div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
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

            {/* live mic VU meter — visible feedback that it's hearing you */}
            <div className="flex w-72 items-center gap-2.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2">
                <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
              </svg>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75"
                  style={{ width: `${Math.round(level * 100)}%`, backgroundColor: level > 0.05 ? "var(--green)" : "rgba(255,255,255,0.3)" }}
                />
              </div>
              <span className="w-24 text-[10px] tracking-wide" style={{ color: level > 0.04 ? "var(--green)" : "rgba(255,255,255,0.35)" }}>
                {level > 0.04 ? "hearing you" : "silent…"}
              </span>
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
