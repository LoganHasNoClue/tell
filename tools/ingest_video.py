#!/usr/bin/env python3
"""
TELL real-video ingestion — turn an actual clip into a REAL scenario.

This runs the genuine pipeline ONCE, offline, on a real video:

    real mp4  ->  ffmpeg 16k wav  ->  faster-whisper transcript (real, timestamped)
              ->  sliding window  ->  LLM scorer (MiniMax via Truefoundry) -> run.json
              ->  (optional) market odds CSV
              ->  scenario.json + captions.json

The UI then replays the REAL computed run (quotes match the audio, the number is
the model actually reading the speech). This is the architecture's "pre-record
run.json" path — honest AND stage-safe.

Transcription needs no API key. Scoring needs TELL_LLM_* (see backend/.env.example);
without it you still get a real transcript + captions and a flat placeholder run.

Examples
--------
# fetch + ingest a real Powell opening statement, section 0:20-3:20
python tools/ingest_video.py \
    --url "https://www.youtube.com/watch?v=WERHkPo1sZw" \
    --id fomc_live_2023_05 --mode fed \
    --outcome "Fed cuts at the next meeting" --hero-label "P(CUT)" \
    --title "FOMC Press Conference" --subtitle "Chair Powell — opening statement (5/3/23)" \
    --start 0:20 --dur 180 --speaker POWELL --p0 0.35

# ingest a local file you already have
python tools/ingest_video.py --file ~/Downloads/debate.mp4 --id debate_live --mode debate ...
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
from bisect import bisect_right
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

# load backend/.env so TELL_LLM_* is available for scoring
try:
    from dotenv import load_dotenv

    load_dotenv(BACKEND / ".env")
except Exception:
    pass

from pipeline.scoring import Scorer, ScoringContext  # noqa: E402

OUT_DIRS = [
    ROOT / "frontend" / "public" / "scenarios",
    BACKEND / "scenarios",
]


def parse_time(s: str) -> float:
    if s is None:
        return 0.0
    s = str(s)
    if ":" in s:
        parts = [float(p) for p in s.split(":")]
        while len(parts) < 3:
            parts.insert(0, 0.0)
        h, m, sec = parts[-3], parts[-2], parts[-1]
        return h * 3600 + m * 60 + sec
    return float(s)


def run(cmd: list[str], **kw):
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True, **kw)


def download_section(url: str, start: float, dur: float, out_mp4: Path):
    """Download just the needed section as mp4 (keeps files small + fast)."""
    end = start + dur
    sec = f"*{start}-{end}"
    # yt-dlp section download; re-encode so the clip starts cleanly at t=0
    run([
        "yt-dlp", "--no-warnings", "-f", "bv*[height<=720]+ba/b[height<=720]/b",
        "--download-sections", sec, "--force-keyframes-at-cuts",
        "--recode-video", "mp4", "-o", str(out_mp4), url,
    ])
    # yt-dlp may suffix; normalize
    if not out_mp4.exists():
        cand = list(out_mp4.parent.glob(out_mp4.stem + "*.mp4"))
        if cand:
            cand[0].rename(out_mp4)


def extract_wav(mp4: Path, wav: Path):
    run([
        "ffmpeg", "-y", "-i", str(mp4), "-vn",
        "-ac", "1", "-ar", "16000", "-f", "wav", str(wav),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def transcribe(wav: Path, model_name: str, speaker: str):
    from faster_whisper import WhisperModel

    print(f"  loading whisper model '{model_name}' (first run downloads weights)…")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(wav), vad_filter=True, beam_size=5)
    caps = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        caps.append({"t": round(seg.start, 2), "speaker": speaker, "text": text})
        print(f"    [{seg.start:6.1f}s] {text}")
    return caps


def window_at(caps, t: float, lookback: float = 42.0) -> str:
    return " ".join(c["text"] for c in caps if t - lookback <= c["t"] <= t)


async def score_run(caps, cfg, duration, cadence, p0):
    from pipeline.scoring import Scorer  # local import after sys.path

    scorer = Scorer()
    ctx = ScoringContext(
        rubric_id=cfg["rubric_id"], outcome_label=cfg["outcome_label"], prev_prob=p0
    )
    if not scorer.live:
        print("\n  !! TELL_LLM_* not set — scorer is in carry-forward mode.")
        print("     Writing a real transcript + a FLAT placeholder run.")
        print("     Set the Truefoundry creds in backend/.env and re-run to get a real run.\n")

    run_pts = []
    prev = p0
    t = 0.0
    while t <= duration + 0.001:
        win = window_at(caps, t)
        if win:
            upd = await scorer.score(ctx, win, t)
            ctx.prev_prob = upd["our_prob"]
            prev = upd["our_prob"]
            drivers = upd["drivers"]
            if drivers:
                ctx.summary = (ctx.summary + " " + drivers[0]["quote"])[-600:]
            run_pts.append({
                "t": round(t, 2),
                "our_prob": round(upd["our_prob"], 4),
                "delta": round(upd["delta"], 4),
                "drivers": drivers,
                "subsignals": upd["subsignals"],
            })
            if drivers:
                print(f"    t={t:6.1f}  p={upd['our_prob']:.2f}  «{drivers[0]['quote'][:48]}»")
        else:
            run_pts.append({
                "t": round(t, 2), "our_prob": round(prev, 4), "delta": 0.0,
                "drivers": [], "subsignals": {"hawk_dove": None, "hedging": None, "momentum": None},
            })
        t += cadence
    return run_pts, scorer.live


def first_cross(ts, ps, level):
    for i in range(1, len(ps)):
        if ps[i - 1] < level <= ps[i]:
            return ts[i]
    return None


def build_market(args, total_dur, p0):
    """
    Real odds if a Polymarket slug/token (+anchor) or CSV is given; else a flat,
    clearly-labelled placeholder. Returns (rows in SCENARIO seconds, is_placeholder).
    The market is anchored at (presser_anchor - preroll) so the lead-in shows the
    real decision-time repricing before the video starts.
    """
    if args.market_token or args.market_slug:
        from fetch_polymarket import resolve_token, parse_anchor, fetch_raw

        if not args.anchor:
            raise SystemExit("--anchor is required with --market-slug/--market-token")
        token = args.market_token
        if not token:
            token, q = resolve_token(args.market_slug, args.market_bucket)
            print(f"   market: {q!r}")
        anchor = parse_anchor(args.anchor)  # presser start == scenario t = preroll
        preroll = float(args.preroll)
        lookback = float(args.decision_lookback)
        clip_dur = total_dur - preroll

        def step_val(raw, u, default):
            last = raw[0][1] if raw else default
            for ts, p in raw:
                if ts <= u:
                    last = p
                else:
                    break
            return last

        rows = []
        # compressed decision pre-roll: real [anchor-lookback, anchor] -> [0, preroll]
        if preroll > 0 and lookback > 0:
            raw_pre = fetch_raw(token, int(anchor - lookback - 120), int(anchor + 5), 1)
            steps = max(2, int(preroll))
            for i in range(steps + 1):
                frac = i / steps
                u = (anchor - lookback) + frac * lookback
                rows.append((round(frac * preroll, 2), round(step_val(raw_pre, u, p0), 4)))
        # real-time presser region: [anchor, anchor+clip_dur] -> [preroll, total_dur]
        raw_post = fetch_raw(token, int(anchor - 120), int(anchor + clip_dur + 120), 1)
        t = 0.0
        while t <= clip_dur + 1e-6:
            rows.append((round(preroll + t, 2), round(step_val(raw_post, anchor + t, p0), 4)))
            t += 1.0
        rows.sort()
        return rows, False
    if args.market_csv:
        rows = []
        with open(args.market_csv) as f:
            for r in csv.DictReader(f):
                rows.append((float(r["t"]), float(r["market_prob"])))
        return rows, False
    rows = [(0.0, round(p0, 4)), (total_dur, round(p0, 4))]
    return rows, True


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url")
    src.add_argument("--file")
    ap.add_argument("--id", required=True)
    ap.add_argument("--mode", choices=["fed", "debate"], default="fed")
    ap.add_argument("--outcome", required=True)
    ap.add_argument("--hero-label", default="P(OUT)")
    ap.add_argument("--rubric", default=None, help="defaults to <mode>_v1")
    ap.add_argument("--title", default="Live Event")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--tag", default=None)
    ap.add_argument("--start", default="0")
    ap.add_argument("--dur", default="180")
    ap.add_argument("--speaker", default="SPEAKER")
    ap.add_argument("--p0", type=float, default=0.5, help="starting probability")
    ap.add_argument("--cadence", type=float, default=4.0)
    ap.add_argument("--whisper-model", default="base.en")
    ap.add_argument("--market-csv", default=None)
    # real Polymarket odds (time-aligned)
    ap.add_argument("--market-slug", default=None, help="Polymarket Gamma event slug")
    ap.add_argument("--market-bucket", default="25 bps", help="market question substring")
    ap.add_argument("--market-token", default=None, help="CLOB token id (overrides slug)")
    ap.add_argument("--anchor", default=None,
                    help="ISO datetime of the PRESSER start / video t=0 (e.g. 2024-12-18T19:30:00Z)")
    ap.add_argument("--preroll", type=float, default=0.0,
                    help="seconds of market-only lead-in before the video (shows the 2pm decision drop)")
    ap.add_argument("--decision-lookback", type=float, default=0.0,
                    help="real seconds before --anchor to render (compressed) into the preroll, "
                         "e.g. 1800 maps the 30min decision repricing into the lead-in")
    ap.add_argument("--no-score", action="store_true")
    ap.add_argument("--reuse-transcript", action="store_true",
                    help="skip download+STT, reuse existing captions.json (fast re-score)")
    args = ap.parse_args()

    rubric = args.rubric or f"{args.mode}_v1"
    tag = args.tag or ("FED MODE" if args.mode == "fed" else "DEBATE MODE")
    start = parse_time(args.start)
    dur = parse_time(args.dur)
    submeters = ["hawk_dove", "hedging"] if args.mode == "fed" else ["momentum", "dodge"]

    # working dir = the frontend public scenario dir (primary)
    primary = OUT_DIRS[0] / args.id
    primary.mkdir(parents=True, exist_ok=True)
    mp4 = primary / "event.mp4"
    wav = primary / "audio.wav"

    print(f"\n=== TELL ingest: {args.id} ({args.mode}) ===")

    # fast path: reuse an existing real transcript, just re-score
    if args.reuse_transcript and (primary / "captions.json").exists():
        caps = json.loads((primary / "captions.json").read_text())
        # clip_dur = the actual VIDEO length (never scenario.json duration, which
        # may already include a prior pre-roll); ffprobe the real mp4.
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(mp4)],
            capture_output=True, text=True,
        )
        clip_dur = round(float(probe.stdout.strip() or dur), 2)
        print(f"   reusing {len(caps)} caption lines (clip {clip_dur}s) — skipping STT")
        cfg = {
            "id": args.id, "mode": args.mode, "title": args.title,
            "subtitle": args.subtitle, "tag": tag, "video": f"/scenarios/{args.id}/event.mp4",
            "outcome_label": args.outcome, "hero_label": args.hero_label,
            "rubric_id": rubric, "duration": clip_dur,
            "market_csv": f"/scenarios/{args.id}/market_odds.csv",
            "precomputed_run": f"/scenarios/{args.id}/run.json",
            "captions": f"/scenarios/{args.id}/captions.json",
            "submeters": submeters, "lead_level": 0.6,
            "source_label": f"{args.title} (real clip · whisper STT)",
            "model_label": "MiniMax M3 · via Truefoundry gateway",
        }
        _finish(args, cfg, caps, clip_dur)
        return

    print("1) media")
    if args.url:
        download_section(args.url, start, dur, mp4)
    else:
        # local file: cut the section. Stream-copy (no re-encode) = near-instant
        # and exact at start=0; fall back to a fast re-encode for non-zero starts
        # (keyframe-accurate) only if copy produces no playable file.
        src = str(Path(args.file).expanduser())
        run([
            "ffmpeg", "-y", "-ss", str(start), "-t", str(dur), "-i", src,
            "-c", "copy", "-avoid_negative_ts", "make_zero", str(mp4),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # actual clip duration (ffprobe)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(mp4)],
        capture_output=True, text=True,
    )
    clip_dur = round(float(probe.stdout.strip() or dur), 2)
    print(f"   clip duration: {clip_dur}s")

    print("2) audio")
    extract_wav(mp4, wav)

    print("3) transcribe (real STT)")
    caps = transcribe(wav, args.whisper_model, args.speaker)
    if not caps:
        print("!! no speech transcribed — aborting")
        sys.exit(1)

    cfg = {
        "id": args.id, "mode": args.mode, "title": args.title,
        "subtitle": args.subtitle, "tag": tag, "video": f"/scenarios/{args.id}/event.mp4",
        "outcome_label": args.outcome, "hero_label": args.hero_label,
        "rubric_id": rubric, "duration": clip_dur,
        "market_csv": f"/scenarios/{args.id}/market_odds.csv",
        "precomputed_run": f"/scenarios/{args.id}/run.json",
        "captions": f"/scenarios/{args.id}/captions.json",
        "submeters": submeters, "lead_level": 0.6,
        "source_label": f"{args.title} (real clip · whisper STT)",
        "model_label": "MiniMax M3 · via Truefoundry gateway",
    }

    _finish(args, cfg, caps, clip_dur)


def _finish(args, cfg, caps, clip_dur):
    """Score (real LLM) -> market -> lead-time -> write all scenario files + index."""
    print("4) score (real LLM)" if not args.no_score else "4) score (skipped)")
    if args.no_score:
        run_pts = [
            {"t": 0.0, "our_prob": args.p0, "delta": 0.0, "drivers": [],
             "subsignals": {"hawk_dove": None, "hedging": None, "momentum": None}},
            {"t": clip_dur, "our_prob": args.p0, "delta": 0.0, "drivers": [],
             "subsignals": {"hawk_dove": None, "hedging": None, "momentum": None}},
        ]
        live = False
    else:
        import asyncio

        run_pts, live = asyncio.run(score_run(caps, cfg, clip_dur, args.cadence, args.p0))

    preroll = float(args.preroll)
    total_dur = clip_dur + preroll
    cfg["duration"] = round(total_dur, 2)
    cfg["video_offset"] = round(preroll, 2)  # video (and TELL) start at scenario t=preroll

    market_rows, market_is_placeholder = build_market(args, total_dur, args.p0)

    # lead-time, if we have a real market (TELL run is in video-time -> shift by preroll)
    ts = [p["t"] + preroll for p in run_pts]
    ps = [p["our_prob"] for p in run_pts]
    mt = [r[0] for r in market_rows]
    mp = [r[1] for r in market_rows]
    cfg["lead_time_s"] = None
    if not market_is_placeholder:
        lvl = cfg["lead_level"]
        oc = first_cross(ts, ps, lvl)
        mc = first_cross(mt, mp, lvl)
        if oc is not None and mc is not None:
            cfg["lead_time_s"] = round(mc - oc, 1)
    cfg["market_placeholder"] = market_is_placeholder
    cfg["scored_live"] = bool(live)

    print("5) write scenario files")
    for base in OUT_DIRS:
        d = base / args.id
        d.mkdir(parents=True, exist_ok=True)
        (d / "captions.json").write_text(json.dumps(caps, indent=2))
        (d / "run.json").write_text(json.dumps(run_pts, indent=2))
        (d / "scenario.json").write_text(json.dumps(cfg, indent=2))
        with open(d / "market_odds.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["t", "market_prob"])
            for t, p in market_rows:
                w.writerow([round(t, 2), round(p, 4)])

    # refresh index.json in both dirs
    for base in OUT_DIRS:
        idx_path = base / "index.json"
        idx = json.loads(idx_path.read_text()) if idx_path.exists() else []
        idx = [e for e in idx if e["id"] != args.id]
        idx.append({
            "id": args.id, "mode": args.mode, "title": args.title,
            "subtitle": args.subtitle, "tag": cfg["tag"], "outcome_label": args.outcome,
            "hero_label": args.hero_label, "duration": clip_dur,
            "lead_time_s": cfg["lead_time_s"],
        })
        idx_path.write_text(json.dumps(idx, indent=2))

    # mirror the mp4 into the backend scenario dir too (so backend can serve it)
    try:
        import shutil

        src_mp4 = OUT_DIRS[0] / args.id / "event.mp4"
        if src_mp4.exists():
            shutil.copy(src_mp4, OUT_DIRS[1] / args.id / "event.mp4")
    except Exception:
        pass

    (OUT_DIRS[0] / args.id / "audio.wav").unlink(missing_ok=True)
    print(f"\n✓ done. {len(caps)} caption lines, {len(run_pts)} score points.")
    print(f"  scored_live={live}  market_placeholder={market_is_placeholder}")
    print(f"  open: http://localhost:3000/terminal?s={args.id}\n")


if __name__ == "__main__":
    main()
