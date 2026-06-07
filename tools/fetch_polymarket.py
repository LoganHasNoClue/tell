#!/usr/bin/env python3
"""
TELL market snapshot — pull a REAL Polymarket odds series, time-aligned to a clip.

Uses Polymarket's public Gamma API (market metadata) + CLOB prices-history
(1-minute historical prices). Writes market_odds.csv with `t` in CLIP SECONDS
(t=0 == the clip's anchor wall-clock time), so it overlays honestly on the video.

NOTE (verified 2026-06): endpoints are
  - https://gamma-api.polymarket.com/events?slug=<slug>          (market metadata + clobTokenIds)
  - https://clob.polymarket.com/prices-history?market=<tokenId>&startTs=&endTs=&fidelity=<min>
Polymarket reuses slugs across months and rotates them — always pass the exact
historical slug (e.g. fed-interest-rates-january-2025) or a token id directly.

Examples
--------
# Jan-2025 "25 bps cut" odds during the Dec 18 2024 presser, aligned to 2:30pm ET
python tools/fetch_polymarket.py \
    --slug fed-interest-rates-january-2025 --bucket "25 bps" \
    --anchor 2024-12-18T19:30:00Z --dur 200 \
    --out frontend/public/scenarios/<id>/market_odds.csv
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def _get(url: str, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def resolve_token(slug: str, bucket: str) -> tuple[str, str]:
    """Return (yes_token_id, question) for the market in `slug` matching `bucket`."""
    data = _get(f"{GAMMA}/events?slug={urllib.parse.quote(slug)}")
    if not data:
        raise SystemExit(f"no event for slug {slug!r}")
    ev = data[0]
    bl = bucket.lower()
    for m in ev.get("markets", []):
        if bl in m.get("question", "").lower():
            return json.loads(m["clobTokenIds"])[0], m["question"]
    qs = [m.get("question") for m in ev.get("markets", [])]
    raise SystemExit(f"bucket {bucket!r} not found in {slug!r}. options:\n  " + "\n  ".join(qs))


def parse_anchor(s: str) -> int:
    s = s.replace("Z", "+00:00")
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp())


def fetch_raw(token: str, start_unix: int, end_unix: int, fidelity: int) -> list[tuple[int, float]]:
    """Raw (unix_ts, price) points in [start, end], sorted ascending."""
    url = (
        f"{CLOB}/prices-history?market={token}"
        f"&startTs={int(start_unix)}&endTs={int(end_unix)}&fidelity={fidelity}"
    )
    hist = _get(url).get("history", [])
    raw = sorted((int(h["t"]), float(h["p"])) for h in hist)
    return raw


def fetch_series(token: str, anchor_unix: int, dur: float, fidelity: int) -> list[tuple[float, float]]:
    # grab a little before the anchor so t=0 has a value to forward-fill from
    pad = 120
    start = anchor_unix - pad
    end = anchor_unix + int(dur) + pad
    url = (
        f"{CLOB}/prices-history?market={token}"
        f"&startTs={start}&endTs={end}&fidelity={fidelity}"
    )
    hist = _get(url).get("history", [])
    if not hist:
        raise SystemExit("no price history in that window (check token/anchor/dur)")
    # map to clip seconds, keep within [0, dur], forward-filled onto a dense grid
    raw = [((h["t"] - anchor_unix), float(h["p"])) for h in hist]
    raw.sort()

    def val_at(ts: float) -> float:
        last = raw[0][1]
        for t, p in raw:
            if t <= ts:
                last = p
            else:
                break
        return last

    rows = []
    t = 0.0
    while t <= dur + 1e-6:
        rows.append((round(t, 2), round(val_at(t), 4)))
        t += 1.0
    return rows


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--token", help="CLOB token id (YES side)")
    g.add_argument("--slug", help="Gamma event slug (use with --bucket)")
    ap.add_argument("--bucket", default="25 bps", help="market question substring, e.g. '25 bps'")
    ap.add_argument("--anchor", required=True, help="ISO datetime of clip t=0 (e.g. 2024-12-18T19:30:00Z)")
    ap.add_argument("--dur", type=float, required=True, help="clip duration seconds")
    ap.add_argument("--fidelity", type=int, default=1, help="resolution in minutes")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.slug:
        token, q = resolve_token(args.slug, args.bucket)
        print(f"resolved: {q!r}\n  token {token}")
    else:
        token = args.token

    anchor = parse_anchor(args.anchor)
    rows = fetch_series(token, anchor, args.dur, args.fidelity)
    ps = [p for _, p in rows]
    print(f"  {len(rows)} rows  min={min(ps):.3f} max={max(ps):.3f} move={max(ps)-min(ps):.3f}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "market_prob"])
        for t, p in rows:
            w.writerow([t, p])
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
