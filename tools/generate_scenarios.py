#!/usr/bin/env python3
"""
TELL scenario generator.

Authors the precomputed demo data for each scenario:
  - run.json        : timestamped ScoreUpdates (our_prob, delta, drivers, subsignals)
  - market_odds.csv : dense t,market_prob series (the "market line"), time-aligned
  - captions.json   : continuous transcript captions for the video lower-third
  - scenario.json   : the scenario config the UI loads

Design goals (see 02_DESIGN_SPEC.md §5 — the money moment):
  * TELL reads dovish nuance early and pulls AHEAD of the market.
  * A clean down-tick on a hedge ("we remain data-dependent" -> -6%).
  * The market digests the same nuance ~14s later -> "TELL led by 14s".
  * Numbers are tasteful; the line separation is unmistakable from 10 feet.

The market line is, honestly, a *delayed + attenuated + smoothed* version of
our read — that is exactly the thesis: the market repriced the nuance slowly.
Outputs are deterministic (no randomness) so the demo is identical every run.
"""

import json
import os
import csv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIRS = [
    os.path.join(ROOT, "frontend", "public", "scenarios"),
    os.path.join(ROOT, "backend", "scenarios"),
]

DT = 0.5  # sampling cadence for smooth lines


def clamp(x, lo=0.02, hi=0.98):
    return max(lo, min(hi, x))


def ease(t):
    # smoothstep-ish easing for prob transitions
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def build_prob_track(p0, events, duration):
    """
    events: list of dicts with t, effect, ramp(optional, seconds the move takes).
    Returns a function prob(t) that ramps from one cumulative level to the next.
    """
    # cumulative targets over time
    keyed = sorted(events, key=lambda e: e["t"])
    segments = []  # (t_start, t_end, level_start, level_end)
    level = p0
    prev_t = 0.0
    segments.append((0.0, keyed[0]["t"] if keyed else duration, p0, p0))
    for i, e in enumerate(keyed):
        ramp = e.get("ramp", 2.5)
        start = e["t"]
        end = e["t"] + ramp
        new_level = clamp(level + e["effect"])
        segments.append((start, end, level, new_level))
        # hold until next event
        next_t = keyed[i + 1]["t"] if i + 1 < len(keyed) else duration + 5
        segments.append((end, next_t, new_level, new_level))
        level = new_level

    def prob(t):
        for (s, e, ls, le) in segments:
            if s <= t < e:
                if e - s <= 1e-6:
                    return le
                return ls + (le - ls) * ease((t - s) / (e - s))
        return level

    return prob


def ema_track(prob_fn, duration, alpha=0.06):
    """Strongly-smoothed running version of prob (how a slow market would track)."""
    vals = {}
    cur = prob_fn(0.0)
    t = 0.0
    while t <= duration + 0.001:
        cur = cur + alpha * (prob_fn(t) - cur)
        vals[round(t, 3)] = cur
        t += DT
    return vals


def first_cross(sample_fn, level, duration, going_up=True):
    t = 0.0
    prev = sample_fn(0.0)
    while t <= duration:
        v = sample_fn(t)
        if going_up and prev < level <= v:
            return round(t, 1)
        if (not going_up) and prev > level >= v:
            return round(t, 1)
        prev = v
        t += DT
    return None


def write_scenario(scn):
    sid = scn["id"]
    duration = scn["duration"]
    p0 = scn["p0"]
    events = scn["events"]
    captions = scn["captions"]
    lag = scn["market_lag"]

    prob_fn = build_prob_track(p0, events, duration)

    # ---- run.json : ScoreUpdates at each sample tick (dense -> smooth line) ----
    run = []
    t = 0.0
    prev_p = prob_fn(0.0)
    # map event time -> driver payload
    ev_by_t = {round(e["t"], 1): e for e in events}
    while t <= duration + 0.001:
        p = clamp(round(prob_fn(t), 4))
        delta = round(p - prev_p, 4)
        sub = scn["subsignal_fn"](t)
        update = {
            "t": round(t, 2),
            "our_prob": p,
            "delta": delta,
            "drivers": [],
            "subsignals": sub,
        }
        key = round(t, 1)
        if key in ev_by_t and ev_by_t[key].get("quote"):
            e = ev_by_t[key]
            update["drivers"] = [{
                "quote": e["quote"],
                "effect": round(e["effect"], 3),
                "why": e["why"],
            }]
        run.append(update)
        prev_p = p
        t += DT

    # ---- market_odds.csv : delayed + attenuated + smoothed read ----
    smooth = ema_track(prob_fn, duration, alpha=0.05)

    def smooth_at(tt):
        return smooth.get(round(max(0.0, tt), 3), smooth[round(0.0, 3)])

    k = scn.get("market_gain", 0.9)
    base = scn.get("market_base", p0)

    def market_at(tt):
        src = smooth_at(tt - lag)
        return clamp(base + k * (src - base))

    market_rows = []
    t = 0.0
    while t <= duration + 0.001:
        market_rows.append((round(t, 2), round(market_at(t), 4)))
        t += DT

    # ---- lead-time stat (the credibility number) ----
    level = scn["lead_level"]
    our_cross = first_cross(prob_fn, level, duration, going_up=True)
    mkt_cross = first_cross(market_at, level, duration, going_up=True)
    lead_time = None
    if our_cross is not None and mkt_cross is not None:
        lead_time = round(mkt_cross - our_cross, 1)

    # ---- scenario.json (UI config) ----
    config = {
        "id": sid,
        "mode": scn["mode"],
        "title": scn["title"],
        "subtitle": scn["subtitle"],
        "tag": scn["tag"],
        "video": f"/scenarios/{sid}/event.mp4",
        "outcome_label": scn["outcome_label"],
        "hero_label": scn["hero_label"],
        "rubric_id": scn["rubric_id"],
        "duration": duration,
        "market_csv": f"/scenarios/{sid}/market_odds.csv",
        "precomputed_run": f"/scenarios/{sid}/run.json",
        "captions": f"/scenarios/{sid}/captions.json",
        "submeters": scn["submeters"],
        "lead_time_s": lead_time,
        "lead_level": level,
        "source_label": scn["source_label"],
        "model_label": "MiniMax M3 · via Truefoundry gateway",
    }

    for base_dir in OUT_DIRS:
        d = os.path.join(base_dir, sid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "run.json"), "w") as f:
            json.dump(run, f, indent=2)
        with open(os.path.join(d, "captions.json"), "w") as f:
            json.dump(captions, f, indent=2)
        with open(os.path.join(d, "scenario.json"), "w") as f:
            json.dump(config, f, indent=2)
        with open(os.path.join(d, "market_odds.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["t", "market_prob"])
            for row in market_rows:
                w.writerow(row)

    print(f"  {sid}: {len(run)} updates, lead-time @ {level:.0%} = {lead_time}s")
    return config


# ---------------------------------------------------------------------------
# FED SCENARIO — Powell presser. Outcome: "Fed cuts at this meeting" -> P(CUT)
# Dovish language raises P(cut); hedging lowers commitment.
# ---------------------------------------------------------------------------

FED_EVENTS = [
    {"t": 13.0, "effect": +0.030, "ramp": 3.0,
     "quote": "the labor market has shown clear signs of softening",
     "why": "dovish; cooling jobs raise cut odds"},
    {"t": 22.0, "effect": +0.045, "ramp": 3.0,
     "quote": "downside risks to employment have risen in recent months",
     "why": "dovish; tilts the committee toward easing"},
    {"t": 31.0, "effect": +0.035, "ramp": 3.0,
     "quote": "we are prepared to adjust the stance of policy as appropriate",
     "why": "signals readiness to move"},
    {"t": 40.0, "effect": +0.040, "ramp": 3.0,
     "quote": "the time to support the labor market is now, not later",
     "why": "strong dovish; urgency to ease"},
    {"t": 52.0, "effect": -0.060, "ramp": 2.5,
     "quote": "we remain data-dependent and will move carefully",
     "why": "hedge; lowers commitment to a cut"},
    {"t": 61.0, "effect": -0.020, "ramp": 2.5,
     "quote": "I would not want to prejudge the outcome of this meeting",
     "why": "dodge; weak directional signal"},
    {"t": 74.0, "effect": +0.030, "ramp": 3.0,
     "quote": "if the labor market were to weaken further, we would respond",
     "why": "reaction function tilts dovish"},
    {"t": 88.0, "effect": +0.045, "ramp": 3.0,
     "quote": "a number on the committee saw a cut as appropriate today",
     "why": "near-explicit; many favor a cut"},
    {"t": 104.0, "effect": +0.020, "ramp": 3.0,
     "quote": "we are attentive to the risks on both sides of our mandate",
     "why": "balanced, mild dovish lean"},
]


def fed_subsignals(t):
    # hawk_dove: -1 dovish .. +1 hawkish ; hedging: 0 committal .. 1 evasive
    hd = -0.25
    hg = 0.25
    if t >= 22:
        hd = -0.45
    if t >= 40:
        hd = -0.6
    if 50 <= t < 70:
        hd = -0.35
        hg = 0.72  # the hedging stretch
    if t >= 74:
        hd = -0.5
        hg = 0.45
    if t >= 88:
        hd = -0.62
        hg = 0.3
    return {"hawk_dove": round(hd, 2), "hedging": round(hg, 2), "momentum": None}


FED_CAPTIONS = [
    {"t": 2, "speaker": "POWELL", "text": "Good afternoon. Let me start with an assessment of the economy."},
    {"t": 9, "speaker": "POWELL", "text": "Recent data point to a labor market that has come into better balance."},
    {"t": 13, "speaker": "POWELL", "text": "Indeed, the labor market has shown clear signs of softening."},
    {"t": 19, "speaker": "POWELL", "text": "Hiring has slowed and the unemployment rate has ticked up."},
    {"t": 22, "speaker": "POWELL", "text": "Downside risks to employment have risen in recent months."},
    {"t": 28, "speaker": "POWELL", "text": "Inflation has eased substantially from its peak toward our two percent goal."},
    {"t": 31, "speaker": "POWELL", "text": "We are prepared to adjust the stance of policy as appropriate."},
    {"t": 37, "speaker": "REPORTER", "text": "Mr. Chair — is the committee behind the curve on jobs?"},
    {"t": 40, "speaker": "POWELL", "text": "I'll say this plainly: the time to support the labor market is now, not later."},
    {"t": 47, "speaker": "POWELL", "text": "We do not want to wait for material weakening to become the baseline."},
    {"t": 52, "speaker": "POWELL", "text": "That said, we remain data-dependent and will move carefully."},
    {"t": 58, "speaker": "POWELL", "text": "Policy is not on a preset course."},
    {"t": 61, "speaker": "POWELL", "text": "I would not want to prejudge the outcome of this meeting."},
    {"t": 67, "speaker": "REPORTER", "text": "But if the jobs numbers deteriorate from here?"},
    {"t": 74, "speaker": "POWELL", "text": "If the labor market were to weaken further, we would respond."},
    {"t": 81, "speaker": "POWELL", "text": "Our tools are well positioned to act, and we will use them."},
    {"t": 88, "speaker": "POWELL", "text": "I can tell you a number on the committee saw a cut as appropriate today."},
    {"t": 96, "speaker": "POWELL", "text": "The discussion reflected real concern about the employment side of the mandate."},
    {"t": 104, "speaker": "POWELL", "text": "We are attentive to the risks on both sides of our mandate."},
    {"t": 111, "speaker": "POWELL", "text": "And we are committed to returning inflation to target over time."},
    {"t": 117, "speaker": "POWELL", "text": "Thank you. I'll take a few more questions."},
]

FED = {
    "id": "fomc_2026_03",
    "mode": "fed",
    "title": "FOMC Press Conference",
    "subtitle": "Chair Powell — opening remarks & Q&A",
    "tag": "FED MODE",
    "outcome_label": "Fed cuts at this meeting",
    "hero_label": "P(CUT)",
    "rubric_id": "fed_v1",
    "duration": 120,
    "p0": 0.60,
    "market_base": 0.60,
    "market_gain": 0.92,
    "market_lag": 14.0,
    "lead_level": 0.68,
    "submeters": ["hawk_dove", "hedging"],
    "source_label": "FOMC press conference (replay)",
    "events": FED_EVENTS,
    "subsignal_fn": fed_subsignals,
    "captions": FED_CAPTIONS,
}


# ---------------------------------------------------------------------------
# DEBATE SCENARIO — same engine, new rubric.
# Outcome: "Htoo wins the nomination" -> P(WIN). momentum: -1 (rival) .. +1 (Hool)
# ---------------------------------------------------------------------------

DEBATE_EVENTS = [
    {"t": 12.0, "effect": +0.040, "ramp": 3.0,
     "quote": "I was the only one on this stage who opposed that bailout from day one",
     "why": "clean direct hit; lands a contrast"},
    {"t": 21.0, "effect": +0.035, "ramp": 3.0,
     "quote": "my opponent voted for it twice, then pretended he didn't",
     "why": "puts rival on the defensive"},
    {"t": 30.0, "effect": +0.045, "ramp": 3.0,
     "quote": "I'll give you a straight answer: yes, on day one, I would sign it",
     "why": "directness; commands the moment"},
    {"t": 44.0, "effect": -0.055, "ramp": 2.5,
     "quote": "well, that's a complicated question and it depends on many factors",
     "why": "dodge; visibly evasive"},
    {"t": 53.0, "effect": -0.020, "ramp": 2.5,
     "quote": "I think we need to study this carefully before committing",
     "why": "hedging; cedes momentum"},
    {"t": 66.0, "effect": +0.030, "ramp": 3.0,
     "quote": "let me be clear about exactly where I stand on this",
     "why": "recovers command of the room"},
    {"t": 80.0, "effect": +0.050, "ramp": 3.0,
     "quote": "you've had twelve years to fix this and you did nothing",
     "why": "applause line; crowd erupts"},
    {"t": 96.0, "effect": +0.025, "ramp": 3.0,
     "quote": "I'm not here to make promises, I'm here to make decisions",
     "why": "memorable close; lands"},
]


def debate_subsignals(t):
    # momentum: -1 rival .. +1 our candidate ; dodge: 0 direct .. 1 evasive
    m = 0.15
    d = 0.2
    if t >= 12:
        m = 0.4
    if t >= 30:
        m = 0.55
    if 42 <= t < 62:
        m = 0.1
        d = 0.75  # the dodge stretch
    if t >= 66:
        m = 0.4
        d = 0.35
    if t >= 80:
        m = 0.7
        d = 0.2
    return {"hawk_dove": None, "hedging": round(d, 2), "momentum": round(m, 2)}


DEBATE_CAPTIONS = [
    {"t": 2, "speaker": "MODERATOR", "text": "Senator, the first question goes to you. Thirty seconds."},
    {"t": 6, "speaker": "HOOL", "text": "Thank you. Let's talk about the record, because the record matters."},
    {"t": 12, "speaker": "HOOL", "text": "I was the only one on this stage who opposed that bailout from day one."},
    {"t": 18, "speaker": "HOOL", "text": "Not after the polls moved — from day one."},
    {"t": 21, "speaker": "HOOL", "text": "My opponent voted for it twice, then pretended he didn't."},
    {"t": 27, "speaker": "MODERATOR", "text": "Would you sign the relief bill as written? Yes or no."},
    {"t": 30, "speaker": "HOOL", "text": "I'll give you a straight answer: yes, on day one, I would sign it."},
    {"t": 37, "speaker": "RIVAL", "text": "That's easy to say when you've never had to govern."},
    {"t": 41, "speaker": "MODERATOR", "text": "Senator — same question to you. Would you sign it?"},
    {"t": 44, "speaker": "RIVAL", "text": "Well, that's a complicated question and it depends on many factors."},
    {"t": 50, "speaker": "MODERATOR", "text": "Is that a yes or a no?"},
    {"t": 53, "speaker": "RIVAL", "text": "I think we need to study this carefully before committing."},
    {"t": 60, "speaker": "HOOL", "text": "And there it is — the same dodge we've heard for years."},
    {"t": 66, "speaker": "HOOL", "text": "Let me be clear about exactly where I stand on this."},
    {"t": 72, "speaker": "HOOL", "text": "Working families don't get to say 'it's complicated' when rent is due."},
    {"t": 80, "speaker": "HOOL", "text": "You've had twelve years to fix this and you did nothing."},
    {"t": 87, "speaker": "MODERATOR", "text": "[crowd applause] — order, please, let's have order."},
    {"t": 96, "speaker": "HOOL", "text": "I'm not here to make promises, I'm here to make decisions."},
    {"t": 103, "speaker": "HOOL", "text": "And on day one, those decisions start with the people in this room."},
    {"t": 110, "speaker": "MODERATOR", "text": "We'll take a short break and return with closing statements."},
]

DEBATE = {
    "id": "debate_2026_primary",
    "mode": "debate",
    "title": "Primary Debate — Night One",
    "subtitle": "Sen. Hool vs. the field — live exchange",
    "tag": "DEBATE MODE",
    "outcome_label": "Hool wins the nomination",
    "hero_label": "P(WIN)",
    "rubric_id": "debate_v1",
    "duration": 115,
    "p0": 0.46,
    "market_base": 0.46,
    "market_gain": 0.95,
    "market_lag": 12.0,
    "lead_level": 0.55,
    "submeters": ["momentum", "dodge"],
    "source_label": "Primary debate broadcast (replay)",
    "events": DEBATE_EVENTS,
    "subsignal_fn": debate_subsignals,
    "captions": DEBATE_CAPTIONS,
}


if __name__ == "__main__":
    print("Generating TELL scenarios...")
    index = []
    for scn in (FED, DEBATE):
        cfg = write_scenario(scn)
        index.append({
            "id": cfg["id"], "mode": cfg["mode"], "title": cfg["title"],
            "subtitle": cfg["subtitle"], "tag": cfg["tag"],
            "outcome_label": cfg["outcome_label"], "hero_label": cfg["hero_label"],
            "duration": cfg["duration"], "lead_time_s": cfg["lead_time_s"],
        })
    for base_dir in OUT_DIRS:
        os.makedirs(base_dir, exist_ok=True)
        with open(os.path.join(base_dir, "index.json"), "w") as f:
            json.dump(index, f, indent=2)
    print("Done. Index written to both frontend/public and backend.")
