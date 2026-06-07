"""
STT layer.

Live mode streams the playing video's audio to Deepgram realtime and emits
finalized, timestamped segments to the scoring window (interims go only to the
live caption ticker — too noisy to score on).

For demo mode we don't transcribe at all — we replay the precomputed run. This
module also provides a `CaptionTrack` that replays the authored captions as if
they were finalized STT segments, so the live-scoring path can be exercised
end-to-end against the bundled clip without a Deepgram key.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Segment:
    t: float
    text: str
    speaker: str = ""
    final: bool = True


class CaptionTrack:
    """Replays authored captions as finalized STT segments, keyed to the clock."""

    def __init__(self, captions_path: str | Path):
        data = json.loads(Path(captions_path).read_text())
        self.segs = [Segment(c["t"], c["text"], c.get("speaker", "")) for c in data]

    def due(self, prev_t: float, t: float) -> list[Segment]:
        return [s for s in self.segs if prev_t < s.t <= t]

    def window(self, t: float, lookback: float = 40.0) -> str:
        """The last ~lookback seconds of finalized text — what the scorer reads."""
        chosen = [s for s in self.segs if t - lookback <= s.t <= t]
        return " ".join(s.text for s in chosen)


class DeepgramStream:
    """
    Thin placeholder for the Deepgram realtime client. The real implementation
    opens a websocket to wss://api.deepgram.com/v1/listen, pushes PCM frames
    from the video's audio track, and yields interim/final transcripts. Kept as
    an interface so the live path is wired without requiring a key to run demos.
    """

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key

    @property
    def live(self) -> bool:
        return bool(self.api_key)
