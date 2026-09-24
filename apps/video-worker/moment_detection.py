import os
import re
import subprocess
import tempfile

import numpy as np
import soundfile as sf

from schemas import MomentCandidate

WINDOW_SECONDS = 0.5
STEP_SECONDS = 0.25
SCENE_THRESHOLD = 0.4

SHOWINFO_RE = re.compile(r"pts_time:([\d.]+)")
SCENE_SCORE_RE = re.compile(r"lavfi\.scene_score=([\d.]+)")


def detect_audio_peaks(audio_path: str) -> list[MomentCandidate]:
    # NOTE: discovered while wiring this into the /analyze route (Task 3),
    # which calls this on the same file passed to detect_scene_changes --
    # i.e. a real video container (mp4/AAC), not a bare WAV. `soundfile`
    # wraps libsndfile, which has no MP4/AAC decoder at all (confirmed via
    # `sf.available_formats()` on libsndfile 1.2.0: WAV/FLAC/OGG/etc only,
    # no MP4), so `sf.read(audio_path)` unconditionally raised
    # `LibsndfileError: Format not recognised` for any video input. Route
    # the input through ffmpeg first to extract/convert to a mono WAV --
    # this is a no-op for a WAV fixture (still passes the existing
    # `short_clip_with_peak.wav` test) and makes real video containers work.
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", audio_path, "-vn", "-ac", "1", wav_path],
            capture_output=True,
            text=True,
            check=True,
        )
        data, sample_rate = sf.read(wav_path)
    finally:
        os.remove(wav_path)

    if data.ndim > 1:
        data = data.mean(axis=1)

    window_size = int(WINDOW_SECONDS * sample_rate)
    step_size = int(STEP_SECONDS * sample_rate)

    rms_values: list[tuple[int, float]] = []
    for start in range(0, len(data) - window_size, step_size):
        window = data[start : start + window_size]
        rms = float(np.sqrt(np.mean(window**2)))
        timestamp_ms = int((start / sample_rate) * 1000)
        rms_values.append((timestamp_ms, rms))

    if not rms_values:
        return []

    rms_array = np.array([v for _, v in rms_values])
    threshold = np.percentile(rms_array, 85)
    max_rms = float(rms_array.max()) or 1.0

    candidates = [
        MomentCandidate(timestamp_ms=ts, score=min(rms / max_rms, 1.0), detection_type="audio_peak")
        for ts, rms in rms_values
        if rms >= threshold
    ]
    return candidates


def detect_scene_changes(video_path: str) -> list[MomentCandidate]:
    # NOTE: an earlier version of this function used the `showinfo` filter
    # and expected `pts_time` and `lavfi.scene_score` on the same stderr
    # line. Verified against real ffmpeg (7.1.5): `showinfo` never prints
    # `lavfi.scene_score` at all, so that version silently always returned
    # an empty list. `metadata=print` is the filter that actually exposes
    # the score, and it prints `pts_time` on one line and
    # `lavfi.scene_score=...` on the NEXT line -- paired here by order, not
    # by co-occurrence on one line.
    result = subprocess.run(
        [
            "ffmpeg",
            "-i",
            video_path,
            "-vf",
            f"select='gt(scene,{SCENE_THRESHOLD})',metadata=print",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    candidates = []
    pending_pts_ms: int | None = None
    for line in result.stderr.splitlines():
        pts_match = SHOWINFO_RE.search(line)
        if pts_match:
            pending_pts_ms = int(float(pts_match.group(1)) * 1000)
            continue
        score_match = SCENE_SCORE_RE.search(line)
        if score_match and pending_pts_ms is not None:
            candidates.append(
                MomentCandidate(
                    timestamp_ms=pending_pts_ms,
                    score=min(float(score_match.group(1)), 1.0),
                    detection_type="scene_change",
                )
            )
            pending_pts_ms = None
    return candidates
