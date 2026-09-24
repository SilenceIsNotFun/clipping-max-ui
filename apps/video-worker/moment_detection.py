import re
import subprocess

import numpy as np
import soundfile as sf

from schemas import MomentCandidate

WINDOW_SECONDS = 0.5
STEP_SECONDS = 0.25
SCENE_THRESHOLD = 0.4

SHOWINFO_RE = re.compile(r"pts_time:([\d.]+)")
SCENE_SCORE_RE = re.compile(r"lavfi\.scene_score=([\d.]+)")


def detect_audio_peaks(audio_path: str) -> list[MomentCandidate]:
    data, sample_rate = sf.read(audio_path)
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
    result = subprocess.run(
        [
            "ffmpeg",
            "-i",
            video_path,
            "-vf",
            f"select='gt(scene,{SCENE_THRESHOLD})',showinfo",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    candidates = []
    for line in result.stderr.splitlines():
        if "pts_time" not in line or "lavfi.scene_score" not in line:
            continue
        pts_match = SHOWINFO_RE.search(line)
        score_match = SCENE_SCORE_RE.search(line)
        if not pts_match or not score_match:
            continue
        candidates.append(
            MomentCandidate(
                timestamp_ms=int(float(pts_match.group(1)) * 1000),
                score=min(float(score_match.group(1)), 1.0),
                detection_type="scene_change",
            )
        )
    return candidates
