# Video Content Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `video-worker` service and supporting `api`/`web-ui` features so an operator can turn a campaign's `content_plan` into a rendered vertical video: upload footage/music, get automatic moment-suggestion markers, assign footage to segments with a chosen layout template (plain, gameplay+facecam split, gameplay-only crop, or cinematic letterbox) and optional title text, generate synced TTS voiceover with word-level captions, preview, iterate, and finalize.

**Architecture:** `video-worker` (new Python FastAPI service) owns all heavy media processing — moment detection, TTS, forced alignment, and ffmpeg rendering — and is stateless per request, communicating results back to `api` via HTTP callbacks so long-running work never blocks an HTTP response. `api` (Node/Express, extended) owns all persistence (five new SQLite tables) and orchestration/validation; it never touches ffmpeg directly. `web-ui` (Next.js, extended) adds asset upload, a segment-assignment page with a timeline scrubber and crop-drawing canvas, and a preview/finalize page.

**Tech Stack:** Python 3.11 + FastAPI + ffmpeg (via `subprocess`) + Piper (TTS) + faster-whisper (forced alignment) + soundfile/numpy (RMS moment detection), Node.js + Express + better-sqlite3 + multer (existing, extended), Next.js + `<canvas>` for crop drawing + native `<video>` for scrubbing (existing, extended).

**Spec:** `docs/superpowers/specs/2026-09-22-video-content-generation-design.md`

## Global Constraints

- No auto-download of footage from public links — upload is always manual (spec: "Tidak termasuk").
- No auto-trim from moment detection — detection only produces advisory markers; `trim_start`/`trim_end` are always operator-set (spec: "Tidak termasuk").
- No generative text-to-video — only editing of uploaded footage (spec: "Tidak termasuk").
- No bundled/licensed music library — music is always operator-uploaded (spec: "Tidak termasuk").
- No auto-publish to external platforms (spec: "Tidak termasuk").
- Single operator only — no auth, no roles (spec: "Tidak termasuk").
- Only 4 built-in layout templates for MVP: `standard`, `gameplay_facecam_split`, `gameplay_full_focus`, `cinematic_letterbox` — no custom template authoring (spec: "Tidak termasuk").
- Output canvas is always vertical 1080x1920 (9:16).
- `video-worker` is a separate service from `ai-worker`, sharing the same SQLite DB (via `api`) and a new `video-assets` Docker volume.
- Environment additions: `VIDEO_ASSETS_DIR=/app/video-assets`, `VIDEO_WORKER_URL=http://video-worker:8100` (used by `api`), `API_INTERNAL_CALLBACK_URL=http://api:4000/api/internal` (used by `video-worker`), `PIPER_VOICES_DIR=/app/voices`.
- TTS engine: Piper. Forced alignment: faster-whisper. Moment detection: ffmpeg `astats`/RMS windows for audio peaks, ffmpeg scene-detection filter for scene changes — CPU-only heuristics, no heavy ML model.

---

## File Structure

```
apps/video-worker/
  main.py                  # FastAPI app: /health, /analyze, /render
  schemas.py                 # pydantic request/response models
  ffmpeg_utils.py              # probe_duration, run_ffmpeg, trim/concat/mux command builders
  moment_detection.py            # detect_audio_peaks, detect_scene_changes
  tts.py                           # generate_tts (Piper wrapper)
  alignment.py                      # align_words (faster-whisper wrapper)
  layout.py                          # build_segment_filter (crop/split/letterbox + title text per layout_template)
  render.py                            # orchestrates the full per-segment + concat render pipeline
  requirements.txt
  Dockerfile
  tests/
    test_ffmpeg_utils.py
    test_moment_detection.py
    test_tts.py
    test_alignment.py
    test_layout.py
    test_render.py
    test_main.py
    fixtures/
      short_clip.mp4          # ~2s clip, two solid-color halves (top/bottom) for crop verification
      short_clip_with_peak.wav # ~3s audio with one loud spike
      short_music.mp3

apps/api/
  src/
    db.ts                      # MODIFY: add video_assets, moment_candidates, segment_assignments, render_jobs, caption_words tables
    types.ts                     # MODIFY: add VideoAsset, MomentCandidate, SegmentAssignment, RenderJob, CaptionWord
    services/
      videoWorkerClient.ts        # analyzeAsset(), submitRender()
      pdfExport.ts                  # (existing, untouched)
      aiWorkerClient.ts               # (existing, untouched)
    routes/
      assets.ts                        # upload/list assets, list moment candidates
      segments.ts                        # PUT segment assignments
      render.ts                            # submit render, get status, finalize
      internal.ts                            # analysis-complete + render-complete callbacks from video-worker
      campaigns.ts                             # (existing, untouched)
  tests/
    assets.test.ts
    segments.test.ts
    render.test.ts
    internal.test.ts
    fixtures/short_clip.mp4

apps/web-ui/
  lib/apiClient.ts              # MODIFY: add asset/segment/render/moment functions and types
  components/
    AssetUpload.tsx
    AssetList.tsx
    TimelineScrubber.tsx          # video player + timeline with moment_candidates markers + in/out point setting
    CropCanvas.tsx                  # <canvas> overlay for drawing crop_gameplay_rect / crop_facecam_rect
    SegmentEditor.tsx                 # per-segment form: asset picker, TimelineScrubber, layout_template select, CropCanvas, title_text input
    RenderPreview.tsx                   # video player + re-render controls + finalize button
  app/campaigns/[id]/
    assets/page.tsx
    segments/page.tsx
    preview/[jobId]/page.tsx

docker/
  docker-compose.yml            # MODIFY: add video-worker service + video-assets volume
```

Rationale: `video-worker`'s five Python modules split by concern (ffmpeg primitives, moment detection, TTS, alignment, layout math) so each is independently testable without invoking real ffmpeg/Piper/whisper in most tests — only `render.py` and `test_main.py` integrate them together. `api`'s new routes are split by resource (`assets`, `segments`, `render`, `internal`) rather than piled into `campaigns.ts`, since `campaigns.ts` already handles Sub-proyek 1's BRD flow and mixing concerns there would make it too large. `web-ui` components split `TimelineScrubber` (playback + markers + trim) from `CropCanvas` (drawing rectangles) since they're independently reusable and independently testable-by-hand.

---

### Task 1: `video-worker` scaffold + ffmpeg primitives

**Files:**
- Create: `apps/video-worker/requirements.txt`
- Create: `apps/video-worker/Dockerfile`
- Create: `apps/video-worker/main.py`
- Create: `apps/video-worker/schemas.py`
- Create: `apps/video-worker/ffmpeg_utils.py`
- Create: `apps/video-worker/tests/test_ffmpeg_utils.py`
- Create: `apps/video-worker/tests/fixtures/short_clip.mp4`
- Modify: `docker/docker-compose.yml`

**Interfaces:**
- Consumes: nothing new (standalone service).
- Produces: `probe_duration(file_path: str) -> float` (seconds), `run_ffmpeg(args: list[str]) -> None` (raises `subprocess.CalledProcessError` on failure), `build_trim_args(input_path: str, start: float, end: float, output_path: str) -> list[str]`, `build_concat_args(input_paths: list[str], output_path: str) -> list[str]`. Tasks 3, 7, 8 depend on these four function names and signatures.

- [ ] **Step 1: Scaffold service and compose entry**

`apps/video-worker/requirements.txt`:
```
fastapi==0.115.0
uvicorn[standard]==0.30.6
pydantic==2.9.2
requests==2.32.3
soundfile==0.12.1
numpy==2.1.1
faster-whisper==1.0.3
piper-tts==1.8.0
pytest==8.3.3
httpx==0.27.2
```

`apps/video-worker/Dockerfile`:
```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
```

`apps/video-worker/main.py`:
```python
from fastapi import FastAPI

app = FastAPI(title="contentrewardfarm-video-worker")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
```

Add to `docker/docker-compose.yml` (inside `services:`):
```yaml
  video-worker:
    build: ../apps/video-worker
    ports:
      - "8100:8100"
    environment:
      - API_INTERNAL_CALLBACK_URL=http://api:4000/api/internal
      - PIPER_VOICES_DIR=/app/voices
    volumes:
      - video-assets:/app/video-assets
      - piper-voices:/app/voices
```

Add to `api` service's `environment` and `volumes` in `docker/docker-compose.yml`:
```yaml
      - VIDEO_ASSETS_DIR=/app/video-assets
      - VIDEO_WORKER_URL=http://video-worker:8100
```
```yaml
      - video-assets:/app/video-assets
```

Add to the top-level `volumes:` block in `docker/docker-compose.yml`:
```yaml
  video-assets:
  piper-voices:
```

Generate the fixture (run once):
```bash
ffmpeg -y -f lavfi -i "color=c=red:s=320x180[top]; color=c=blue:s=320x180[bottom]; [top][bottom]vstack" -f lavfi -i "anullsrc=r=44100:cl=stereo" -c:v libx264 -c:a aac -t 2 -shortest apps/video-worker/tests/fixtures/short_clip.mp4
```

- [ ] **Step 2: Write failing tests for ffmpeg primitives**

`apps/video-worker/tests/test_ffmpeg_utils.py`:
```python
import os
import subprocess

import pytest

from ffmpeg_utils import build_concat_args, build_trim_args, probe_duration, run_ffmpeg

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
CLIP = os.path.join(FIXTURES, "short_clip.mp4")


def test_probe_duration_returns_seconds():
    duration = probe_duration(CLIP)
    assert 1.8 < duration < 2.2


def test_build_trim_args_produces_valid_command(tmp_path):
    output = str(tmp_path / "trimmed.mp4")
    args = build_trim_args(CLIP, 0.0, 1.0, output)
    run_ffmpeg(args)
    assert os.path.exists(output)
    assert 0.8 < probe_duration(output) < 1.2


def test_build_concat_args_produces_valid_command(tmp_path):
    trimmed1 = str(tmp_path / "a.mp4")
    trimmed2 = str(tmp_path / "b.mp4")
    run_ffmpeg(build_trim_args(CLIP, 0.0, 1.0, trimmed1))
    run_ffmpeg(build_trim_args(CLIP, 1.0, 2.0, trimmed2))

    output = str(tmp_path / "combined.mp4")
    args = build_concat_args([trimmed1, trimmed2], output)
    run_ffmpeg(args)
    assert os.path.exists(output)
    assert 1.8 < probe_duration(output) < 2.2


def test_run_ffmpeg_raises_on_bad_input(tmp_path):
    with pytest.raises(subprocess.CalledProcessError):
        run_ffmpeg(["ffmpeg", "-y", "-i", "/nonexistent.mp4", str(tmp_path / "out.mp4")])
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_ffmpeg_utils.py -v`
Expected: `ModuleNotFoundError: No module named 'ffmpeg_utils'`.

- [ ] **Step 4: Implement ffmpeg primitives**

`apps/video-worker/ffmpeg_utils.py`:
```python
import json
import subprocess


def probe_duration(file_path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            file_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def run_ffmpeg(args: list[str]) -> None:
    subprocess.run(args, capture_output=True, text=True, check=True)


def build_trim_args(input_path: str, start: float, end: float, output_path: str) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-ss",
        str(start),
        "-to",
        str(end),
        "-i",
        input_path,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        output_path,
    ]


def build_concat_args(input_paths: list[str], output_path: str) -> list[str]:
    filter_inputs = "".join(f"[{i}:v][{i}:a]" for i in range(len(input_paths)))
    filter_complex = f"{filter_inputs}concat=n={len(input_paths)}:v=1:a=1[outv][outa]"
    args = ["ffmpeg", "-y"]
    for path in input_paths:
        args += ["-i", path]
    args += [
        "-filter_complex",
        filter_complex,
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        output_path,
    ]
    return args
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_ffmpeg_utils.py -v`
Expected: all 4 tests PASS. (Requires `ffmpeg`/`ffprobe` installed locally, or run inside the built `video-worker` container.)

- [ ] **Step 6: Verify compose config is valid and service boots**

Run: `docker compose -f docker/docker-compose.yml config -q`
Expected: no errors.

Run: `docker compose -f docker/docker-compose.yml up --build -d video-worker`
Expected: `curl localhost:8100/health` → `{"status":"ok"}`.

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 7: Commit**

```bash
git add apps/video-worker docker/docker-compose.yml
git commit -m "feat(video-worker): scaffold service with ffmpeg trim/concat primitives"
```

---

### Task 2: `video-worker` moment detection (audio peak + scene change)

**Files:**
- Create: `apps/video-worker/moment_detection.py`
- Create: `apps/video-worker/tests/test_moment_detection.py`
- Create: `apps/video-worker/tests/fixtures/short_clip_with_peak.wav`
- Create: `apps/video-worker/tests/fixtures/cut_clip.mp4`

**Interfaces:**
- Consumes: `probe_duration` from Task 1 (not required at call time, but same module family).
- Produces: `detect_audio_peaks(video_path: str) -> list[MomentCandidate]` and `detect_scene_changes(video_path: str) -> list[MomentCandidate]`, where `MomentCandidate` (from `schemas.py`) has `timestamp_ms: int`, `score: float`, `detection_type: Literal["audio_peak", "scene_change"]`. Task 4 (`/analyze` route) depends on these two function names and the `MomentCandidate` fields.

- [ ] **Step 1: Add `MomentCandidate` schema**

`apps/video-worker/schemas.py`:
```python
from typing import Literal

from pydantic import BaseModel


class MomentCandidate(BaseModel):
    timestamp_ms: int
    score: float
    detection_type: Literal["audio_peak", "scene_change"]
```

- [ ] **Step 2: Generate audio fixture with a known peak**

Run once:
```bash
python - <<'PY'
import numpy as np
import soundfile as sf

sr = 16000
duration = 3.0
t = np.linspace(0, duration, int(sr * duration), endpoint=False)
signal = 0.02 * np.sin(2 * np.pi * 220 * t)  # quiet background tone
peak_start, peak_end = int(1.4 * sr), int(1.6 * sr)
signal[peak_start:peak_end] += 0.9 * np.sin(2 * np.pi * 440 * t[peak_start:peak_end])
sf.write("apps/video-worker/tests/fixtures/short_clip_with_peak.wav", signal, sr)
PY
```

Also generate a fixture with a genuine hard cut, for the scene-change test (`short_clip.mp4` from Task 1 is a static two-color frame held for its whole duration and never changes, so it can never trigger a scene-change detection):
```bash
ffmpeg -y -f lavfi -i "color=c=red:s=320x180:d=1" -f lavfi -i "color=c=blue:s=320x180:d=1" -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0" -c:v libx264 apps/video-worker/tests/fixtures/cut_clip.mp4
```

- [ ] **Step 3: Write failing tests**

`apps/video-worker/tests/test_moment_detection.py`:
```python
import os

from moment_detection import detect_audio_peaks, detect_scene_changes

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_detect_audio_peaks_finds_the_loud_window():
    candidates = detect_audio_peaks(os.path.join(FIXTURES, "short_clip_with_peak.wav"))
    assert len(candidates) >= 1
    top = max(candidates, key=lambda c: c.score)
    # With WINDOW_SECONDS=0.5/STEP_SECONDS=0.25 and the peak spanning 1.4-1.6s,
    # the 0.5s window with the largest overlap with the peak starts at 1.25s
    # (a 0.4s/0.5s = 40% overlap) -- not a window centered on the peak itself,
    # since windows are wider than the peak. This is deterministic given the
    # fixture and constants above, verified by direct calculation.
    assert 1200 <= top.timestamp_ms <= 1300
    assert top.detection_type == "audio_peak"
    assert 0.0 <= top.score <= 1.0


def test_detect_scene_changes_returns_list_for_short_clip():
    # short_clip.mp4 (Task 1's fixture) is a static two-color frame held for
    # its whole duration -- nothing ever changes, so it can never trigger a
    # scene-change detection. Confirm that case returns an empty list rather
    # than erroring.
    candidates = detect_scene_changes(os.path.join(FIXTURES, "short_clip.mp4"))
    assert candidates == []


def test_detect_scene_changes_finds_the_real_cut():
    candidates = detect_scene_changes(os.path.join(FIXTURES, "cut_clip.mp4"))
    assert len(candidates) >= 1
    top = candidates[0]
    assert top.detection_type == "scene_change"
    assert 0.0 <= top.score <= 1.0
    # The cut happens at the 1-second boundary between the two 1s clips.
    assert 800 <= top.timestamp_ms <= 1200
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_moment_detection.py -v`
Expected: `ModuleNotFoundError: No module named 'moment_detection'`.

- [ ] **Step 5: Implement moment detection**

`apps/video-worker/moment_detection.py`:
```python
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_moment_detection.py -v`
Expected: all 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/video-worker/moment_detection.py apps/video-worker/schemas.py apps/video-worker/tests/test_moment_detection.py apps/video-worker/tests/fixtures/short_clip_with_peak.wav apps/video-worker/tests/fixtures/cut_clip.mp4
git commit -m "feat(video-worker): detect audio-peak and scene-change moment candidates"
```

---

### Task 3: `video-worker` `/analyze` route

**Files:**
- Modify: `apps/video-worker/main.py`
- Create: `apps/video-worker/tests/test_main.py` (analyze tests only for now; render tests added in Task 8)

**Interfaces:**
- Consumes: `detect_audio_peaks`/`detect_scene_changes` from Task 2.
- Produces: `POST /analyze` accepting `{"video_asset_id": str, "file_path": str, "callback_url": str}`, responds `202` immediately, then POSTs to `callback_url` with `{"video_asset_id": str, "moment_candidates": MomentCandidate[]}` or `{"video_asset_id": str, "error": str}` on failure. Task 10 (`api` internal callback route) depends on this exact callback payload shape.

- [ ] **Step 1: Write failing test using background-task execution**

`apps/video-worker/tests/test_main.py`:
```python
import os
import time
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_analyze_returns_202_and_calls_callback_with_candidates():
    with patch("main.requests.post") as mock_post:
        resp = client.post(
            "/analyze",
            json={
                "video_asset_id": "asset-1",
                "file_path": os.path.join(FIXTURES, "short_clip.mp4"),
                "callback_url": "http://api:4000/api/internal/assets/asset-1/analysis-complete",
            },
        )
        assert resp.status_code == 202

        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

        assert mock_post.called
        _, kwargs = mock_post.call_args
        body = kwargs["json"]
        assert body["video_asset_id"] == "asset-1"
        assert "moment_candidates" in body


def test_analyze_reports_error_on_bad_file():
    with patch("main.requests.post") as mock_post:
        client.post(
            "/analyze",
            json={
                "video_asset_id": "asset-2",
                "file_path": "/nonexistent.mp4",
                "callback_url": "http://api:4000/api/internal/assets/asset-2/analysis-complete",
            },
        )
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)
        _, kwargs = mock_post.call_args
        assert "error" in kwargs["json"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py -v`
Expected: FAIL — `/analyze` returns 404.

- [ ] **Step 3: Implement the route**

`apps/video-worker/main.py`:
```python
import requests
from fastapi import BackgroundTasks, FastAPI

from moment_detection import detect_audio_peaks, detect_scene_changes

app = FastAPI(title="contentrewardfarm-video-worker")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


def _run_analysis(video_asset_id: str, file_path: str, callback_url: str) -> None:
    try:
        candidates = detect_audio_peaks(file_path) + detect_scene_changes(file_path)
        requests.post(
            callback_url,
            json={
                "video_asset_id": video_asset_id,
                "moment_candidates": [c.model_dump() for c in candidates],
            },
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        requests.post(
            callback_url,
            json={"video_asset_id": video_asset_id, "error": str(exc)},
            timeout=30,
        )


@app.post("/analyze", status_code=202)
def analyze(payload: dict, background_tasks: BackgroundTasks) -> dict:
    background_tasks.add_task(
        _run_analysis, payload["video_asset_id"], payload["file_path"], payload["callback_url"]
    )
    return {"status": "accepted"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py -v`
Expected: all 3 tests PASS. (FastAPI's `TestClient` runs `BackgroundTasks` synchronously after the response in-process, so the polling loop resolves immediately in practice; it is kept for robustness.)

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/main.py apps/video-worker/tests/test_main.py
git commit -m "feat(video-worker): expose /analyze route with async callback"
```

---

### Task 4: `video-worker` TTS wrapper (Piper)

**Files:**
- Create: `apps/video-worker/tts.py`
- Create: `apps/video-worker/tests/test_tts.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `generate_tts(text: str, voice: str, voices_dir: str, output_path: str) -> None`, writing a WAV file to `output_path`. Task 8 (render pipeline) depends on this exact signature.

- [ ] **Step 1: Write failing test**

`apps/video-worker/tests/test_tts.py`:
```python
import os
from unittest.mock import patch

from tts import generate_tts


def test_generate_tts_invokes_piper_with_expected_args(tmp_path):
    output_path = str(tmp_path / "out.wav")
    with patch("tts.subprocess.run") as mock_run:
        def fake_run(args, **kwargs):
            with open(output_path, "wb") as f:
                f.write(b"RIFF....WAVEfmt ")
            return None

        mock_run.side_effect = fake_run
        generate_tts("Halo dunia", "id_ID-voice-medium", "/app/voices", output_path)

        assert os.path.exists(output_path)
        args = mock_run.call_args[0][0]
        assert args[0] == "piper"
        assert "--model" in args
        assert "/app/voices/id_ID-voice-medium.onnx" in args
        assert "--output_file" in args
        assert output_path in args
        assert mock_run.call_args[1]["input"] == "Halo dunia"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/video-worker && python -m pytest tests/test_tts.py -v`
Expected: `ModuleNotFoundError: No module named 'tts'`.

- [ ] **Step 3: Implement the wrapper**

`apps/video-worker/tts.py`:
```python
import os
import subprocess


def generate_tts(text: str, voice: str, voices_dir: str, output_path: str) -> None:
    model_path = os.path.join(voices_dir, f"{voice}.onnx")
    subprocess.run(
        ["piper", "--model", model_path, "--output_file", output_path],
        input=text,
        text=True,
        capture_output=True,
        check=True,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/video-worker && python -m pytest tests/test_tts.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/tts.py apps/video-worker/tests/test_tts.py
git commit -m "feat(video-worker): add Piper TTS wrapper"
```

---

### Task 5: `video-worker` forced alignment wrapper (faster-whisper)

**Files:**
- Create: `apps/video-worker/alignment.py`
- Create: `apps/video-worker/tests/test_alignment.py`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (operates on any WAV file, including Task 4's TTS output).
- Produces: `align_words(audio_path: str) -> list[CaptionWord]` where `CaptionWord` (added to `schemas.py`) has `word: str`, `start_ms: int`, `end_ms: int`. Task 8 depends on this signature and `CaptionWord`'s fields.

- [ ] **Step 1: Add `CaptionWord` schema**

Add to `apps/video-worker/schemas.py`:
```python
class CaptionWord(BaseModel):
    word: str
    start_ms: int
    end_ms: int
```

- [ ] **Step 2: Write failing test using a mocked WhisperModel**

`apps/video-worker/tests/test_alignment.py`:
```python
from unittest.mock import MagicMock, patch

from alignment import align_words


def test_align_words_returns_word_timestamps():
    fake_word_1 = MagicMock(word=" hello", start=0.0, end=0.5)
    fake_word_2 = MagicMock(word=" world", start=0.5, end=1.0)
    fake_segment = MagicMock(words=[fake_word_1, fake_word_2])

    with patch("alignment.WhisperModel") as MockModel:
        instance = MockModel.return_value
        instance.transcribe.return_value = ([fake_segment], MagicMock())

        result = align_words("/tmp/audio.wav")

        assert len(result) == 2
        assert result[0].word == "hello"
        assert result[0].start_ms == 0
        assert result[0].end_ms == 500
        assert result[1].word == "world"
        assert result[1].start_ms == 500
        assert result[1].end_ms == 1000
        instance.transcribe.assert_called_once_with("/tmp/audio.wav", word_timestamps=True)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/video-worker && python -m pytest tests/test_alignment.py -v`
Expected: `ModuleNotFoundError: No module named 'alignment'`.

- [ ] **Step 4: Implement the wrapper**

`apps/video-worker/alignment.py`:
```python
from faster_whisper import WhisperModel

from schemas import CaptionWord

_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel("small", device="auto", compute_type="int8")
    return _model


def align_words(audio_path: str) -> list[CaptionWord]:
    model = _get_model()
    segments, _ = model.transcribe(audio_path, word_timestamps=True)
    words: list[CaptionWord] = []
    for segment in segments:
        for word in segment.words:
            words.append(
                CaptionWord(
                    word=word.word.strip(),
                    start_ms=int(word.start * 1000),
                    end_ms=int(word.end * 1000),
                )
            )
    return words
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/video-worker && python -m pytest tests/test_alignment.py -v`
Expected: PASS. (`WhisperModel` is mocked, so no real model download happens in this test.)

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/alignment.py apps/video-worker/schemas.py apps/video-worker/tests/test_alignment.py
git commit -m "feat(video-worker): add faster-whisper word-level forced alignment"
```

---

### Task 6: `video-worker` layout templates (crop/split/letterbox + title text)

**Files:**
- Create: `apps/video-worker/layout.py`
- Create: `apps/video-worker/tests/test_layout.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure ffmpeg filter-string builder).
- Produces: `build_segment_filter(segment: SegmentInput) -> str` where `SegmentInput` (added to `schemas.py`) has `layout_template: Literal["standard", "gameplay_facecam_split", "gameplay_full_focus", "cinematic_letterbox"]`, `crop_gameplay_rect: dict | None`, `crop_facecam_rect: dict | None`, `has_secondary: bool`, `title_text: str | None`. Returns an ffmpeg `-filter_complex` fragment string producing a single `1080x1920` output stream. Task 7 (render pipeline) depends on this signature.

- [ ] **Step 1: Add `SegmentInput` schema**

Add to `apps/video-worker/schemas.py`:
```python
from typing import Literal, Optional


class CropRect(BaseModel):
    x: float
    y: float
    width: float
    height: float


class SegmentInput(BaseModel):
    layout_template: Literal[
        "standard", "gameplay_facecam_split", "gameplay_full_focus", "cinematic_letterbox"
    ]
    crop_gameplay_rect: Optional[CropRect] = None
    crop_facecam_rect: Optional[CropRect] = None
    has_secondary: bool = False
    title_text: Optional[str] = None
```

- [ ] **Step 2: Write failing tests covering each template**

`apps/video-worker/tests/test_layout.py`:
```python
from schemas import CropRect, SegmentInput
from layout import build_segment_filter


def test_standard_layout_scales_and_crops_to_canvas():
    segment = SegmentInput(layout_template="standard")
    result = build_segment_filter(segment)
    assert "scale=1080:1920" in result
    assert "crop=1080:1920" in result


def test_gameplay_full_focus_uses_crop_gameplay_rect():
    segment = SegmentInput(
        layout_template="gameplay_full_focus",
        crop_gameplay_rect=CropRect(x=0.0, y=0.0, width=1.0, height=0.5),
    )
    result = build_segment_filter(segment)
    assert "crop=" in result
    assert "iw*1.0" in result or "iw*1.000000" in result
    assert "scale=1080:1920" in result


def test_gameplay_facecam_split_single_source_crops_both_areas():
    segment = SegmentInput(
        layout_template="gameplay_facecam_split",
        crop_gameplay_rect=CropRect(x=0.0, y=0.0, width=1.0, height=0.5),
        crop_facecam_rect=CropRect(x=0.0, y=0.5, width=1.0, height=0.5),
        has_secondary=False,
    )
    result = build_segment_filter(segment)
    assert "vstack" in result
    assert result.count("crop=") == 2


def test_gameplay_facecam_split_two_sources_skips_crop():
    segment = SegmentInput(layout_template="gameplay_facecam_split", has_secondary=True)
    result = build_segment_filter(segment)
    assert "vstack" in result
    assert "crop=" not in result


def test_cinematic_letterbox_pads_with_black_bars():
    segment = SegmentInput(layout_template="cinematic_letterbox")
    result = build_segment_filter(segment)
    assert "pad=1080:1920" in result
    assert "black" in result


def test_title_text_appends_drawtext_filter():
    segment = SegmentInput(layout_template="standard", title_text="MOMENT CLUTCH TENZ")
    result = build_segment_filter(segment)
    assert "drawtext" in result
    assert "MOMENT CLUTCH TENZ" in result


def test_no_title_text_omits_drawtext_filter():
    segment = SegmentInput(layout_template="standard", title_text=None)
    result = build_segment_filter(segment)
    assert "drawtext" not in result


def test_missing_required_crop_raises():
    import pytest

    with pytest.raises(ValueError):
        build_segment_filter(SegmentInput(layout_template="gameplay_full_focus"))
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_layout.py -v`
Expected: `ModuleNotFoundError: No module named 'layout'`.

- [ ] **Step 4: Implement the layout builder**

`apps/video-worker/layout.py`:
```python
from schemas import CropRect, SegmentInput

CANVAS_W = 1080
CANVAS_H = 1920


def _crop_expr(rect: CropRect) -> str:
    return (
        f"crop=w=iw*{rect.width}:h=ih*{rect.height}:"
        f"x=iw*{rect.x}:y=ih*{rect.y}"
    )


def _title_filter(title_text: str) -> str:
    escaped = title_text.replace("'", "\\'").replace(":", "\\:")
    return (
        f"drawtext=text='{escaped}':fontcolor=white:fontsize=64:"
        "borderw=3:bordercolor=black:x=(w-text_w)/2:y=80"
    )


def build_segment_filter(segment: SegmentInput) -> str:
    if segment.layout_template == "standard":
        filters = [f"scale={CANVAS_W}:-1", f"crop={CANVAS_W}:{CANVAS_H}"]
        chain = ",".join(filters)

    elif segment.layout_template == "gameplay_full_focus":
        if segment.has_secondary:
            chain = f"scale={CANVAS_W}:{CANVAS_H}"
        else:
            if segment.crop_gameplay_rect is None:
                raise ValueError("gameplay_full_focus requires crop_gameplay_rect")
            chain = f"{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{CANVAS_H}"

    elif segment.layout_template == "gameplay_facecam_split":
        top_h = int(CANVAS_H * 0.6)
        bottom_h = CANVAS_H - top_h
        if segment.has_secondary:
            chain = (
                f"[0:v]scale={CANVAS_W}:{top_h}[top];"
                f"[1:v]scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2"
            )
        else:
            if segment.crop_gameplay_rect is None or segment.crop_facecam_rect is None:
                raise ValueError(
                    "gameplay_facecam_split requires crop_gameplay_rect and crop_facecam_rect"
                )
            chain = (
                f"split=2[src1][src2];"
                f"[src1]{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{top_h}[top];"
                f"[src2]{_crop_expr(segment.crop_facecam_rect)},scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2"
            )

    elif segment.layout_template == "cinematic_letterbox":
        chain = (
            f"scale={CANVAS_W}:-1:force_original_aspect_ratio=decrease,"
            f"pad={CANVAS_W}:{CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black"
        )

    else:
        raise ValueError(f"unknown layout_template: {segment.layout_template}")

    if segment.title_text:
        chain = f"{chain},{_title_filter(segment.title_text)}"

    return chain
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_layout.py -v`
Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/layout.py apps/video-worker/schemas.py apps/video-worker/tests/test_layout.py
git commit -m "feat(video-worker): build ffmpeg filter graphs for 4 layout templates and title text"
```

---

### Task 7: `video-worker` render pipeline orchestration

**Files:**
- Create: `apps/video-worker/render.py`
- Create: `apps/video-worker/tests/test_render.py`

**Interfaces:**
- Consumes: `run_ffmpeg`/`probe_duration` from Task 1, `generate_tts` from Task 4, `align_words` from Task 5, `build_segment_filter` from Task 6. (Task 1's `build_concat_args` is NOT used here — it concatenates streams that both have audio, but this task's per-segment videos are intentionally audio-free (`-an`) since voiceover comes from TTS, not the source footage. This task writes its own video-only and audio-only concat helpers instead.)
- Produces: `render_video(job: RenderJobInput, work_dir: str) -> RenderResult` where `RenderJobInput` (added to `schemas.py`) has `segments: list[RenderSegmentInput]` (each with `file_path`, `secondary_file_path: str | None`, `trim_start`, `trim_end`, `order_index`, `script_text`, `layout_template`, `crop_gameplay_rect`, `crop_facecam_rect`, `title_text`), `tts_voice: str`, `voices_dir: str`, `music_path: str | None`, `output_path: str`; `RenderResult` has `output_path: str`, `caption_words: list[CaptionWord]`. Task 8 (`/render` route) depends on this signature.

- [ ] **Step 1: Add `RenderSegmentInput`/`RenderJobInput`/`RenderResult` schemas**

Add to `apps/video-worker/schemas.py`:
```python
class RenderSegmentInput(BaseModel):
    file_path: str
    secondary_file_path: Optional[str] = None
    trim_start: float
    trim_end: float
    order_index: int
    script_text: str
    layout_template: Literal[
        "standard", "gameplay_facecam_split", "gameplay_full_focus", "cinematic_letterbox"
    ]
    crop_gameplay_rect: Optional[CropRect] = None
    crop_facecam_rect: Optional[CropRect] = None
    title_text: Optional[str] = None


class RenderJobInput(BaseModel):
    segments: list[RenderSegmentInput]
    tts_voice: str
    voices_dir: str
    music_path: Optional[str] = None
    output_path: str


class RenderResult(BaseModel):
    output_path: str
    caption_words: list[CaptionWord]
```

- [ ] **Step 2: Write failing integration-style test with mocked TTS/alignment**

`apps/video-worker/tests/test_render.py`:
```python
import os
import wave
from unittest.mock import patch

from schemas import CaptionWord, RenderJobInput, RenderSegmentInput
from render import render_video

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
CLIP = os.path.join(FIXTURES, "short_clip.mp4")


def fake_generate_tts(text, voice, voices_dir, output_path):
    # Write a real, tiny, valid (silent) WAV file -- render_video's audio
    # concat step runs a real ffmpeg process against this path, so a
    # placeholder like b"RIFF" (not a decodable WAV) would fail there.
    with wave.open(output_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 1600)  # 0.1s of silence


def fake_align_words(audio_path):
    return [CaptionWord(word="hi", start_ms=0, end_ms=300)]


def test_render_video_produces_output_and_offsets_captions(tmp_path):
    job = RenderJobInput(
        segments=[
            RenderSegmentInput(
                file_path=CLIP,
                trim_start=0.0,
                trim_end=1.0,
                order_index=0,
                script_text="hi",
                layout_template="standard",
            ),
            RenderSegmentInput(
                file_path=CLIP,
                trim_start=1.0,
                trim_end=2.0,
                order_index=1,
                script_text="hi",
                layout_template="standard",
            ),
        ],
        tts_voice="id_ID-voice-medium",
        voices_dir="/app/voices",
        music_path=None,
        output_path=str(tmp_path / "final.mp4"),
    )

    with patch("render.generate_tts", side_effect=fake_generate_tts), patch(
        "render.align_words", side_effect=fake_align_words
    ), patch("render.probe_duration", return_value=1.0):
        result = render_video(job, str(tmp_path))

    assert os.path.exists(result.output_path)
    # second segment's caption words must be offset by the first segment's duration (1.0s)
    assert result.caption_words[0].start_ms == 0
    assert result.caption_words[1].start_ms == 1000
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v`
Expected: `ModuleNotFoundError: No module named 'render'`.

- [ ] **Step 4: Implement the orchestrator**

`apps/video-worker/render.py`:
```python
import os

from alignment import align_words
from ffmpeg_utils import probe_duration, run_ffmpeg
from layout import build_segment_filter
from schemas import CaptionWord, RenderJobInput, RenderResult, SegmentInput
from tts import generate_tts


def _render_single_segment(
    segment, index: int, tts_voice: str, voices_dir: str, work_dir: str
) -> tuple[str, str]:
    tts_path = os.path.join(work_dir, f"segment_{index}_tts.wav")
    generate_tts(segment.script_text, tts_voice, voices_dir, tts_path)

    segment_filter_input = SegmentInput(
        layout_template=segment.layout_template,
        crop_gameplay_rect=segment.crop_gameplay_rect,
        crop_facecam_rect=segment.crop_facecam_rect,
        has_secondary=segment.secondary_file_path is not None,
        title_text=segment.title_text,
    )
    video_filter = build_segment_filter(segment_filter_input)

    trimmed_path = os.path.join(work_dir, f"segment_{index}_video.mp4")
    # ffmpeg applies -ss/-to only to the -i that immediately follows them, so
    # each input needs its own copy of the trim window -- a single leading
    # -ss/-to (as an earlier version of this function had) silently leaves
    # every input after the first untrimmed, which breaks the two-source
    # gameplay_facecam_split case (the facecam clip would play from its own
    # start instead of the operator-selected window).
    inputs = ["-ss", str(segment.trim_start), "-to", str(segment.trim_end), "-i", segment.file_path]
    if segment.secondary_file_path:
        inputs += ["-ss", str(segment.trim_start), "-to", str(segment.trim_end), "-i", segment.secondary_file_path]

    args = ["ffmpeg", "-y"] + inputs + ["-filter_complex", video_filter, "-an", trimmed_path]
    run_ffmpeg(args)
    return trimmed_path, tts_path


def _concat_video_only(video_paths: list[str], output_path: str) -> None:
    """Concat video-only streams (segments are rendered with -an, so the
    generic av-concat in ffmpeg_utils.build_concat_args does not apply)."""
    filter_inputs = "".join(f"[{i}:v]" for i in range(len(video_paths)))
    filter_complex = f"{filter_inputs}concat=n={len(video_paths)}:v=1:a=0[outv]"
    args = ["ffmpeg", "-y"]
    for path in video_paths:
        args += ["-i", path]
    args += ["-filter_complex", filter_complex, "-map", "[outv]", output_path]
    run_ffmpeg(args)


def _concat_audio_only(audio_paths: list[str], output_path: str) -> None:
    """Concat the per-segment TTS voiceover clips into one continuous track."""
    filter_inputs = "".join(f"[{i}:a]" for i in range(len(audio_paths)))
    filter_complex = f"{filter_inputs}concat=n={len(audio_paths)}:v=0:a=1[outa]"
    args = ["ffmpeg", "-y"]
    for path in audio_paths:
        args += ["-i", path]
    args += ["-filter_complex", filter_complex, "-map", "[outa]", output_path]
    run_ffmpeg(args)


def render_video(job: RenderJobInput, work_dir: str) -> RenderResult:
    ordered_segments = sorted(job.segments, key=lambda s: s.order_index)

    video_paths: list[str] = []
    tts_paths: list[str] = []
    all_caption_words: list[CaptionWord] = []
    offset_ms = 0

    for index, segment in enumerate(ordered_segments):
        video_path, tts_path = _render_single_segment(
            segment, index, job.tts_voice, job.voices_dir, work_dir
        )
        video_paths.append(video_path)
        tts_paths.append(tts_path)

        words = align_words(tts_path)
        for word in words:
            all_caption_words.append(
                CaptionWord(
                    word=word.word,
                    start_ms=word.start_ms + offset_ms,
                    end_ms=word.end_ms + offset_ms,
                )
            )
        offset_ms += int(probe_duration(video_path) * 1000)

    concat_video = os.path.join(work_dir, "concatenated_video.mp4")
    _concat_video_only(video_paths, concat_video)

    concat_voiceover = os.path.join(work_dir, "concatenated_voiceover.wav")
    _concat_audio_only(tts_paths, concat_voiceover)

    final_output = job.output_path
    if job.music_path:
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-i",
                concat_video,
                "-i",
                concat_voiceover,
                "-i",
                job.music_path,
                "-filter_complex",
                "[2:a]volume=0.2[music];[1:a][music]amix=inputs=2:duration=first[a]",
                "-map",
                "0:v",
                "-map",
                "[a]",
                "-shortest",
                final_output,
            ]
        )
    else:
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-i",
                concat_video,
                "-i",
                concat_voiceover,
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-shortest",
                final_output,
            ]
        )

    return RenderResult(output_path=final_output, caption_words=all_caption_words)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v`
Expected: PASS. (Requires real `ffmpeg` — run inside the built `video-worker` container if not installed locally.)

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/render.py apps/video-worker/schemas.py apps/video-worker/tests/test_render.py
git commit -m "feat(video-worker): orchestrate per-segment TTS, layout, concat, and mux into render_video"
```

---

### Task 8: `video-worker` `/render` route

**Files:**
- Modify: `apps/video-worker/main.py`
- Modify: `apps/video-worker/tests/test_main.py`

**Interfaces:**
- Consumes: `render_video` from Task 7.
- Produces: `POST /render` accepting `{"job_id": str, "segments": [...], "tts_voice": str, "music_path": str | None, "callback_url": str}`, responds `202` immediately, then POSTs to `callback_url` with `{"job_id": str, "output_path": str, "caption_words": CaptionWord[]}` or `{"job_id": str, "error": str}`. Task 12 (`api` internal callback route) depends on this exact payload shape.

- [ ] **Step 1: Write failing tests**

Append to `apps/video-worker/tests/test_main.py`:
```python
def test_render_returns_202_and_calls_callback_with_output():
    with patch("main.render_video") as mock_render, patch("main.requests.post") as mock_post:
        from schemas import CaptionWord, RenderResult

        mock_render.return_value = RenderResult(
            output_path="/app/video-assets/exports/job-1.mp4",
            caption_words=[CaptionWord(word="hi", start_ms=0, end_ms=300)],
        )

        resp = client.post(
            "/render",
            json={
                "job_id": "job-1",
                "segments": [
                    {
                        "file_path": os.path.join(FIXTURES, "short_clip.mp4"),
                        "trim_start": 0.0,
                        "trim_end": 1.0,
                        "order_index": 0,
                        "script_text": "hi",
                        "layout_template": "standard",
                    }
                ],
                "tts_voice": "id_ID-voice-medium",
                "music_path": None,
                "callback_url": "http://api:4000/api/internal/render/job-1/complete",
            },
        )
        assert resp.status_code == 202

        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

        _, kwargs = mock_post.call_args
        body = kwargs["json"]
        assert body["job_id"] == "job-1"
        assert body["output_path"] == "/app/video-assets/exports/job-1.mp4"


def test_render_reports_error_on_failure():
    with patch("main.render_video", side_effect=RuntimeError("ffmpeg exploded")), patch(
        "main.requests.post"
    ) as mock_post:
        client.post(
            "/render",
            json={
                "job_id": "job-2",
                "segments": [],
                "tts_voice": "id_ID-voice-medium",
                "music_path": None,
                "callback_url": "http://api:4000/api/internal/render/job-2/complete",
            },
        )
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)
        _, kwargs = mock_post.call_args
        assert kwargs["json"]["job_id"] == "job-2"
        assert "ffmpeg exploded" in kwargs["json"]["error"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py -v`
Expected: FAIL — `/render` returns 404.

- [ ] **Step 3: Implement the route**

Add to `apps/video-worker/main.py` (replace the file to include both routes):
```python
import os
import tempfile

import requests
from fastapi import BackgroundTasks, FastAPI

from moment_detection import detect_audio_peaks, detect_scene_changes
from render import render_video
from schemas import RenderJobInput

app = FastAPI(title="contentrewardfarm-video-worker")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


def _run_analysis(video_asset_id: str, file_path: str, callback_url: str) -> None:
    try:
        candidates = detect_audio_peaks(file_path) + detect_scene_changes(file_path)
        requests.post(
            callback_url,
            json={
                "video_asset_id": video_asset_id,
                "moment_candidates": [c.model_dump() for c in candidates],
            },
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001
        requests.post(
            callback_url,
            json={"video_asset_id": video_asset_id, "error": str(exc)},
            timeout=30,
        )


@app.post("/analyze", status_code=202)
def analyze(payload: dict, background_tasks: BackgroundTasks) -> dict:
    background_tasks.add_task(
        _run_analysis, payload["video_asset_id"], payload["file_path"], payload["callback_url"]
    )
    return {"status": "accepted"}


def _run_render(job_id: str, job_input: RenderJobInput, callback_url: str) -> None:
    try:
        with tempfile.TemporaryDirectory() as work_dir:
            result = render_video(job_input, work_dir)
            requests.post(
                callback_url,
                json={
                    "job_id": job_id,
                    "output_path": result.output_path,
                    "caption_words": [w.model_dump() for w in result.caption_words],
                },
                timeout=30,
            )
    except Exception as exc:  # noqa: BLE001
        requests.post(callback_url, json={"job_id": job_id, "error": str(exc)}, timeout=30)


@app.post("/render", status_code=202)
def render(payload: dict, background_tasks: BackgroundTasks) -> dict:
    job_id = payload["job_id"]
    output_dir = os.environ.get("VIDEO_ASSETS_DIR", "/app/video-assets")
    output_path = os.path.join(output_dir, "exports", f"{job_id}.mp4")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    job_input = RenderJobInput(
        segments=payload["segments"],
        tts_voice=payload["tts_voice"],
        voices_dir=os.environ.get("PIPER_VOICES_DIR", "/app/voices"),
        music_path=payload.get("music_path"),
        output_path=output_path,
    )
    background_tasks.add_task(_run_render, job_id, job_input, payload["callback_url"])
    return {"status": "accepted"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/main.py apps/video-worker/tests/test_main.py
git commit -m "feat(video-worker): expose /render route with async callback"
```

---

### Task 9: `api` schema additions and `video-worker` HTTP client

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Create: `apps/api/src/services/videoWorkerClient.ts`
- Create: `apps/api/tests/videoWorkerClient.test.ts`
- Modify: `apps/api/tests/db.test.ts`

**Interfaces:**
- Consumes: `/analyze` and `/render` contracts from Tasks 3 and 8.
- Produces: five new tables (`video_assets`, `moment_candidates`, `segment_assignments`, `render_jobs`, `caption_words`) in `getDb`'s schema; TS types `VideoAsset`, `MomentCandidate`, `SegmentAssignment`, `RenderJob`, `CaptionWord`; `analyzeAsset(videoWorkerUrl, videoAssetId, filePath, callbackUrl): Promise<void>` and `submitRender(videoWorkerUrl, jobId, segments, ttsVoice, musicPath, callbackUrl): Promise<void>`. Tasks 10-12 depend on these table names/columns and function signatures.

- [ ] **Step 1: Write failing schema test**

Append to `apps/api/tests/db.test.ts`, inside the `describe` block:
```typescript
  it("creates the video content generation tables", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "video_assets",
        "moment_candidates",
        "segment_assignments",
        "render_jobs",
        "caption_words",
      ])
    );
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: FAIL — new table names not present.

- [ ] **Step 3: Extend schema and types**

Add to the `SCHEMA` string in `apps/api/src/db.ts` (before the closing backtick):
```sql

CREATE TABLE IF NOT EXISTS video_assets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  file_path TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moment_candidates (
  id TEXT PRIMARY KEY,
  video_asset_id TEXT NOT NULL REFERENCES video_assets(id),
  timestamp_ms INTEGER NOT NULL,
  score REAL NOT NULL,
  detection_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segment_assignments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  segment_key TEXT NOT NULL,
  video_asset_id TEXT NOT NULL REFERENCES video_assets(id),
  secondary_video_asset_id TEXT REFERENCES video_assets(id),
  trim_start REAL NOT NULL,
  trim_end REAL NOT NULL,
  order_index INTEGER NOT NULL,
  layout_template TEXT NOT NULL,
  crop_gameplay_rect TEXT,
  crop_facecam_rect TEXT,
  title_text TEXT
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL,
  tts_voice TEXT NOT NULL,
  music_asset_id TEXT REFERENCES video_assets(id),
  output_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS caption_words (
  id TEXT PRIMARY KEY,
  render_job_id TEXT NOT NULL REFERENCES render_jobs(id),
  word TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
```

Add to `apps/api/src/types.ts`:
```typescript
export interface VideoAsset {
  id: string;
  campaign_id: string;
  file_path: string;
  asset_type: "footage" | "music";
  duration_seconds: number;
  analysis_status: "pending" | "done" | "failed";
  created_at: string;
}

export interface MomentCandidate {
  id: string;
  video_asset_id: string;
  timestamp_ms: number;
  score: number;
  detection_type: "audio_peak" | "scene_change";
  created_at: string;
}

export type LayoutTemplate =
  | "standard"
  | "gameplay_facecam_split"
  | "gameplay_full_focus"
  | "cinematic_letterbox";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SegmentAssignment {
  id: string;
  campaign_id: string;
  segment_key: string;
  video_asset_id: string;
  secondary_video_asset_id: string | null;
  trim_start: number;
  trim_end: number;
  order_index: number;
  layout_template: LayoutTemplate;
  crop_gameplay_rect: string | null; // JSON-encoded CropRect
  crop_facecam_rect: string | null; // JSON-encoded CropRect
  title_text: string | null;
}

export type RenderJobStatus = "queued" | "rendering" | "ready_for_preview" | "final" | "failed";

export interface RenderJob {
  id: string;
  campaign_id: string;
  status: RenderJobStatus;
  tts_voice: string;
  music_asset_id: string | null;
  output_path: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CaptionWord {
  id: string;
  render_job_id: string;
  word: string;
  start_ms: number;
  end_ms: number;
}
```

- [ ] **Step 4: Run schema test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write failing test for the video-worker client**

`apps/api/tests/videoWorkerClient.test.ts`:
```typescript
import { analyzeAsset, submitRender } from "../src/services/videoWorkerClient";

describe("videoWorkerClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("analyzeAsset posts to /analyze with callback_url", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await analyzeAsset(
      "http://video-worker:8100",
      "asset-1",
      "/video-assets/a.mp4",
      "http://api:4000/api/internal/assets/asset-1/analysis-complete"
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://video-worker:8100/analyze",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          video_asset_id: "asset-1",
          file_path: "/video-assets/a.mp4",
          callback_url: "http://api:4000/api/internal/assets/asset-1/analysis-complete",
        }),
      })
    );
  });

  it("submitRender posts to /render with segments and callback_url", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await submitRender(
      "http://video-worker:8100",
      "job-1",
      [{ file_path: "/a.mp4", trim_start: 0, trim_end: 1, order_index: 0, script_text: "hi", layout_template: "standard" }],
      "id_ID-voice-medium",
      null,
      "http://api:4000/api/internal/render/job-1/complete"
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://video-worker:8100/render",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when video-worker responds with non-ok status", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    await expect(
      analyzeAsset("http://video-worker:8100", "asset-1", "/a.mp4", "http://cb")
    ).rejects.toThrow("video-worker /analyze failed with status 500");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: FAIL — `Cannot find module '../src/services/videoWorkerClient'`.

- [ ] **Step 7: Implement the client**

`apps/api/src/services/videoWorkerClient.ts`:
```typescript
export interface RenderSegmentPayload {
  file_path: string;
  secondary_file_path?: string;
  trim_start: number;
  trim_end: number;
  order_index: number;
  script_text: string;
  layout_template: string;
  crop_gameplay_rect?: Record<string, number>;
  crop_facecam_rect?: Record<string, number>;
  title_text?: string;
}

export async function analyzeAsset(
  videoWorkerUrl: string,
  videoAssetId: string,
  filePath: string,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_asset_id: videoAssetId, file_path: filePath, callback_url: callbackUrl }),
  });
  if (!res.ok) throw new Error(`video-worker /analyze failed with status ${res.status}`);
}

export async function submitRender(
  videoWorkerUrl: string,
  jobId: string,
  segments: RenderSegmentPayload[],
  ttsVoice: string,
  musicPath: string | null,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      segments,
      tts_voice: ttsVoice,
      music_path: musicPath,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /render failed with status ${res.status}`);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/src/services/videoWorkerClient.ts apps/api/tests/db.test.ts apps/api/tests/videoWorkerClient.test.ts
git commit -m "feat(api): add video content tables and video-worker HTTP client"
```

---

### Task 10: `api` asset upload/list routes + analysis callback

**Files:**
- Create: `apps/api/src/routes/assets.ts`
- Create: `apps/api/src/routes/internal.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/assets.test.ts`
- Create: `apps/api/tests/internal.test.ts`
- Create: `apps/api/tests/fixtures/short_clip.mp4` (copy from `apps/video-worker/tests/fixtures/short_clip.mp4`)

**Interfaces:**
- Consumes: `getDb` from Task 9's schema, `analyzeAsset` from Task 9's client.
- Produces: `POST /api/campaigns/:id/assets`, `GET /api/campaigns/:id/assets`, `GET /api/campaigns/:id/assets/:assetId/moments`, and internal `POST /api/internal/assets/:assetId/analysis-complete`. Task 13/14 (web-ui) depend on the first three response shapes.

- [ ] **Step 1: Write failing tests**

`apps/api/tests/assets.test.ts`:
```typescript
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { resetDbCacheForTests } from "../src/db";

jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
}));

describe("asset routes", () => {
  let dataDir: string;
  let campaignId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    process.env.UPLOAD_DIR = uploadDir;
    process.env.DATA_DIR = dataDir;
    process.env.DB_PATH = path.join(dataDir, "app.db");
    process.env.VIDEO_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "video-assets-"));
    process.env.VIDEO_WORKER_URL = "http://video-worker:8100";
    process.env.API_INTERNAL_CALLBACK_URL = "http://api:4000/api/internal";
    jest.clearAllMocks();

    const { getDb } = require("../src/db");
    const db = getDb(process.env.DB_PATH);
    campaignId = "campaign-1";
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test Campaign", "planned", "/uploads/brd.pdf", now, now);
  });

  it("uploads a footage asset and triggers analysis", async () => {
    const { analyzeAsset } = require("../src/services/videoWorkerClient");
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.asset_type).toBe("footage");
    expect(res.body.analysis_status).toBe("pending");
    expect(analyzeAsset).toHaveBeenCalledTimes(1);
  });

  it("lists assets for a campaign", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    await request(app).post(`/api/campaigns/${campaignId}/assets`).field("asset_type", "footage").attach("file", fixture);

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("rejects upload with unreadable/zero-duration file", async () => {
    const app = createApp();
    const badFile = path.join(os.tmpdir(), "bad.mp4");
    fs.writeFileSync(badFile, "not a real video");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", badFile);

    expect(res.status).toBe(400);
  });
});
```

`apps/api/tests/internal.test.ts`:
```typescript
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

describe("internal analysis-complete callback", () => {
  let dbPath: string;
  let assetId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("campaign-1", "Test", "planned", "/x.pdf", now, now);
    assetId = "asset-1";
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, "campaign-1", "/video-assets/a.mp4", "footage", 2.0, "pending", now);
  });

  it("stores moment candidates and marks analysis done", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({
        video_asset_id: assetId,
        moment_candidates: [{ timestamp_ms: 1500, score: 0.9, detection_type: "audio_peak" }],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(assetId) as any;
    expect(asset.analysis_status).toBe("done");
    const candidates = db.prepare("SELECT * FROM moment_candidates WHERE video_asset_id = ?").all(assetId);
    expect(candidates).toHaveLength(1);
  });

  it("marks analysis failed when video-worker reports an error", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({ video_asset_id: assetId, error: "corrupt file" });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(assetId) as any;
    expect(asset.analysis_status).toBe("failed");
  });
});
```

Create the fixture: `cp apps/video-worker/tests/fixtures/short_clip.mp4 apps/api/tests/fixtures/short_clip.mp4`

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/assets.test.ts tests/internal.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Implement routes**

`apps/api/src/routes/assets.ts`:
```typescript
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import express, { Router } from "express";
import multer from "multer";
import { getDb } from "../db";
import { analyzeAsset } from "../services/videoWorkerClient";

function probeDurationSeconds(filePath: string): number {
  try {
    const output = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    const duration = parseFloat(output.toString().trim());
    return Number.isFinite(duration) ? duration : 0;
  } catch {
    return 0;
  }
}

export function createAssetsRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const videoAssetsDir = process.env.VIDEO_ASSETS_DIR ?? "/app/video-assets";
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const videoWorkerUrl = process.env.VIDEO_WORKER_URL ?? "http://video-worker:8100";
  const callbackBase = process.env.API_INTERNAL_CALLBACK_URL ?? "http://api:4000/api/internal";
  fs.mkdirSync(videoAssetsDir, { recursive: true });

  const upload = multer({ dest: videoAssetsDir });

  router.post("/", upload.single("file"), async (req, res) => {
    const db = getDb(dbPath);
    const file = req.file;
    const campaignId = req.params.id;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const assetType = req.body.asset_type === "music" ? "music" : "footage";
    const duration = probeDurationSeconds(file.path);
    if (duration <= 0) {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: "file is not a readable audio/video file" });
      return;
    }

    const finalPath = path.join(videoAssetsDir, `${file.filename}${path.extname(file.originalname)}`);
    fs.renameSync(file.path, finalPath);

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, campaignId, finalPath, assetType, duration, assetType === "footage" ? "pending" : "done", now);

    if (assetType === "footage") {
      await analyzeAsset(videoWorkerUrl, id, finalPath, `${callbackBase}/assets/${id}/analysis-complete`);
    }

    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(id);
    res.status(201).json(asset);
  });

  router.get("/", (req, res) => {
    const db = getDb(dbPath);
    const assets = db
      .prepare("SELECT * FROM video_assets WHERE campaign_id = ? ORDER BY created_at ASC")
      .all(req.params.id);
    res.json(assets);
  });

  router.get("/:assetId/moments", (req, res) => {
    const db = getDb(dbPath);
    const moments = db
      .prepare("SELECT * FROM moment_candidates WHERE video_asset_id = ? ORDER BY timestamp_ms ASC")
      .all(req.params.assetId);
    res.json(moments);
  });

  return router;
}
```

`apps/api/src/routes/internal.ts`:
```typescript
import { randomUUID } from "crypto";
import express, { Router } from "express";
import { getDb } from "../db";

export function createInternalRouter(): Router {
  const router = express.Router();
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";

  router.post("/assets/:assetId/analysis-complete", (req, res) => {
    const db = getDb(dbPath);
    const { assetId } = req.params;
    const now = new Date().toISOString();

    if (req.body.error) {
      db.prepare("UPDATE video_assets SET analysis_status = ? WHERE id = ?").run("failed", assetId);
      res.json({ status: "recorded" });
      return;
    }

    const candidates = (req.body.moment_candidates ?? []) as Array<{
      timestamp_ms: number;
      score: number;
      detection_type: string;
    }>;
    const insert = db.prepare(
      `INSERT INTO moment_candidates (id, video_asset_id, timestamp_ms, score, detection_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows: typeof candidates) => {
      for (const c of rows) {
        insert.run(randomUUID(), assetId, c.timestamp_ms, c.score, c.detection_type, now);
      }
    });
    insertMany(candidates);

    db.prepare("UPDATE video_assets SET analysis_status = ? WHERE id = ?").run("done", assetId);
    res.json({ status: "recorded" });
  });

  return router;
}
```

Modify `apps/api/src/server.ts`:
```typescript
import express from "express";
import { createCampaignsRouter } from "./routes/campaigns";
import { createAssetsRouter } from "./routes/assets";
import { createInternalRouter } from "./routes/internal";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/campaigns", createCampaignsRouter());
  app.use("/api/campaigns/:id/assets", createAssetsRouter());
  app.use("/api/internal", createInternalRouter());

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`api listening on ${port}`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/assets.test.ts tests/internal.test.ts`
Expected: all 5 tests PASS. (Requires `ffprobe` on PATH; install `ffmpeg` locally or run inside a container that has it — the existing `apps/api/Dockerfile` will need `ffmpeg` added, done in Task 14's deployment step.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/assets.ts apps/api/src/routes/internal.ts apps/api/src/server.ts apps/api/tests/assets.test.ts apps/api/tests/internal.test.ts apps/api/tests/fixtures/short_clip.mp4
git commit -m "feat(api): add asset upload/list routes and analysis-complete callback"
```

---

### Task 11: `api` segment assignment route with validation

**Files:**
- Create: `apps/api/src/routes/segments.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/segments.test.ts`

**Interfaces:**
- Consumes: `getDb` from Task 9, `content_plan` shape from Sub-proyek 1's `plans` table (`content_plan` JSON with segment keys as top-level object keys, e.g. `{"hook": {...}, "body": {...}, "cta": {...}}`).
- Produces: `PUT /api/campaigns/:id/segments` replacing all `segment_assignments` for a campaign after validating every `content_plan` segment key is present and crop rects exist where required. Task 12 depends on `segment_assignments` rows this route writes.

- [ ] **Step 1: Write failing tests**

`apps/api/tests/segments.test.ts`:
```typescript
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

describe("segment assignment route", () => {
  let dbPath: string;
  let campaignId: string;
  let assetId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    campaignId = "campaign-1";
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test", "planned", "/x.pdf", now, now);
    db.prepare(
      `INSERT INTO plans (id, campaign_id, strategy_summary, requirements_checklist, content_plan, opportunity_score, pdf_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "plan-1",
      campaignId,
      "s",
      "[]",
      JSON.stringify({ hook: { script: "hi" }, body: { script: "yo" } }),
      50,
      null,
      now
    );
    assetId = "asset-1";
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, campaignId, "/video-assets/a.mp4", "footage", 5.0, "done", now);
  });

  it("saves segment assignments covering all content_plan segments", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          {
            segment_key: "hook",
            video_asset_id: assetId,
            trim_start: 0,
            trim_end: 2,
            order_index: 0,
            layout_template: "standard",
          },
          {
            segment_key: "body",
            video_asset_id: assetId,
            trim_start: 2,
            trim_end: 4,
            order_index: 1,
            layout_template: "standard",
          },
        ],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM segment_assignments WHERE campaign_id = ?").all(campaignId);
    expect(rows).toHaveLength(2);
  });

  it("rejects when a content_plan segment is missing", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          { segment_key: "hook", video_asset_id: assetId, trim_start: 0, trim_end: 2, order_index: 0, layout_template: "standard" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.missing_segments).toEqual(["body"]);
  });

  it("rejects gameplay_full_focus without crop_gameplay_rect", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          { segment_key: "hook", video_asset_id: assetId, trim_start: 0, trim_end: 2, order_index: 0, layout_template: "gameplay_full_focus" },
          { segment_key: "body", video_asset_id: assetId, trim_start: 2, trim_end: 4, order_index: 1, layout_template: "standard" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.missing_crop).toEqual(["hook"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/segments.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/segments'`.

- [ ] **Step 3: Implement the route**

`apps/api/src/routes/segments.ts`:
```typescript
import { randomUUID } from "crypto";
import express, { Router } from "express";
import { getDb } from "../db";

interface SegmentPayload {
  segment_key: string;
  video_asset_id: string;
  secondary_video_asset_id?: string;
  trim_start: number;
  trim_end: number;
  order_index: number;
  layout_template: string;
  crop_gameplay_rect?: Record<string, number>;
  crop_facecam_rect?: Record<string, number>;
  title_text?: string;
}

const TEMPLATES_REQUIRING_GAMEPLAY_CROP = new Set(["gameplay_full_focus", "gameplay_facecam_split"]);
const TEMPLATES_REQUIRING_FACECAM_CROP = new Set(["gameplay_facecam_split"]);

export function createSegmentsRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";

  router.put("/", (req, res) => {
    const db = getDb(dbPath);
    const campaignId = req.params.id;
    const segments: SegmentPayload[] = req.body.segments ?? [];

    const plan = db
      .prepare("SELECT content_plan FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { content_plan: string } | undefined;
    if (!plan) {
      res.status(404).json({ error: "no plan found for this campaign" });
      return;
    }
    const requiredKeys = Object.keys(JSON.parse(plan.content_plan));
    const providedKeys = segments.map((s) => s.segment_key);
    const missingSegments = requiredKeys.filter((k) => !providedKeys.includes(k));
    if (missingSegments.length > 0) {
      res.status(400).json({ missing_segments: missingSegments });
      return;
    }

    const missingCrop = segments
      .filter((s) => {
        if (s.secondary_video_asset_id) return false;
        if (TEMPLATES_REQUIRING_GAMEPLAY_CROP.has(s.layout_template) && !s.crop_gameplay_rect) return true;
        if (TEMPLATES_REQUIRING_FACECAM_CROP.has(s.layout_template) && !s.crop_facecam_rect) return true;
        return false;
      })
      .map((s) => s.segment_key);
    if (missingCrop.length > 0) {
      res.status(400).json({ missing_crop: missingCrop });
      return;
    }

    const deleteExisting = db.prepare("DELETE FROM segment_assignments WHERE campaign_id = ?");
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const replaceAll = db.transaction((rows: SegmentPayload[]) => {
      deleteExisting.run(campaignId);
      for (const s of rows) {
        insert.run(
          randomUUID(),
          campaignId,
          s.segment_key,
          s.video_asset_id,
          s.secondary_video_asset_id ?? null,
          s.trim_start,
          s.trim_end,
          s.order_index,
          s.layout_template,
          s.crop_gameplay_rect ? JSON.stringify(s.crop_gameplay_rect) : null,
          s.crop_facecam_rect ? JSON.stringify(s.crop_facecam_rect) : null,
          s.title_text ?? null
        );
      }
    });
    replaceAll(segments);

    const saved = db.prepare("SELECT * FROM segment_assignments WHERE campaign_id = ?").all(campaignId);
    res.json(saved);
  });

  return router;
}
```

Add to `apps/api/src/server.ts`:
```typescript
import { createSegmentsRouter } from "./routes/segments";
// ...
app.use("/api/campaigns/:id/segments", createSegmentsRouter());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/segments.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/segments.ts apps/api/src/server.ts apps/api/tests/segments.test.ts
git commit -m "feat(api): add segment assignment route with content_plan and crop validation"
```

---

### Task 12: `api` render submit/status/finalize routes + render-complete callback

**Files:**
- Create: `apps/api/src/routes/render.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/render.test.ts`
- Modify: `apps/api/tests/internal.test.ts`

**Interfaces:**
- Consumes: `submitRender` from Task 9, `segment_assignments` from Task 11.
- Produces: `POST /api/campaigns/:id/render`, `GET /api/campaigns/:id/render/:jobId`, `POST /api/campaigns/:id/render/:jobId/finalize`, and internal `POST /api/internal/render/:jobId/complete`. Task 15 (web-ui preview page) depends on the `GET`/`finalize` response shapes.

- [ ] **Step 1: Write failing tests**

`apps/api/tests/render.test.ts`:
```typescript
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
  submitRender: jest.fn().mockResolvedValue(undefined),
}));

describe("render routes", () => {
  let dbPath: string;
  let campaignId: string;
  let assetId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;
    process.env.VIDEO_WORKER_URL = "http://video-worker:8100";
    process.env.API_INTERNAL_CALLBACK_URL = "http://api:4000/api/internal";
    jest.clearAllMocks();

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    campaignId = "campaign-1";
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test", "planned", "/x.pdf", now, now);
    db.prepare(
      `INSERT INTO plans (id, campaign_id, strategy_summary, requirements_checklist, content_plan, opportunity_score, pdf_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("plan-1", campaignId, "s", "[]", JSON.stringify({ hook: { script: "hi" } }), 50, null, now);
    assetId = "asset-1";
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, campaignId, "/video-assets/a.mp4", "footage", 5.0, "done", now);
    db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("seg-1", campaignId, "hook", assetId, null, 0, 2, 0, "standard", null, null, null);
  });

  it("submits a render job and returns queued status", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({ tts_voice: "id_ID-voice-medium" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).toBeDefined();
  });

  it("returns job status via GET", async () => {
    const app = createApp();
    const submitRes = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({ tts_voice: "id_ID-voice-medium" });

    const statusRes = await request(app).get(
      `/api/campaigns/${campaignId}/render/${submitRes.body.job_id}`
    );
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("rendering");
  });

  it("finalizes a ready render job", async () => {
    const app = createApp();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("job-1", campaignId, "ready_for_preview", "id_ID-voice-medium", null, "/exports/job-1.mp4", null, now, now);

    const res = await request(app).post(`/api/campaigns/${campaignId}/render/job-1/finalize`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
  });
});
```

Append to `apps/api/tests/internal.test.ts`:
```typescript
describe("internal render-complete callback", () => {
  let dbPath: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("campaign-1", "Test", "planned", "/x.pdf", now, now);
    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("job-1", "campaign-1", "rendering", "id_ID-voice-medium", null, null, null, now, now);
  });

  it("marks job ready_for_preview and stores caption_words on success", async () => {
    const app = createApp();
    const res = await request(app).post("/api/internal/render/job-1/complete").send({
      job_id: "job-1",
      output_path: "/video-assets/exports/job-1.mp4",
      caption_words: [{ word: "hi", start_ms: 0, end_ms: 300 }],
    });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get("job-1") as any;
    expect(job.status).toBe("ready_for_preview");
    expect(job.output_path).toBe("/video-assets/exports/job-1.mp4");
    const words = db.prepare("SELECT * FROM caption_words WHERE render_job_id = ?").all("job-1");
    expect(words).toHaveLength(1);
  });

  it("marks job failed with error_message on failure", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/internal/render/job-1/complete")
      .send({ job_id: "job-1", error: "ffmpeg exploded" });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get("job-1") as any;
    expect(job.status).toBe("failed");
    expect(job.error_message).toBe("ffmpeg exploded");
  });
});
```

Add the missing imports at the top of `apps/api/tests/internal.test.ts` if not already present (`request`, `createApp`, `fs`, `os`, `path`, `getDb`, `resetDbCacheForTests`) — reuse the same import block as the existing `describe` in that file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/render.test.ts tests/internal.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/render'`, and the new internal callback tests fail against the not-yet-extended handler.

- [ ] **Step 3: Implement the render routes**

`apps/api/src/routes/render.ts`:
```typescript
import { randomUUID } from "crypto";
import express, { Router } from "express";
import { getDb } from "../db";
import { submitRender, RenderSegmentPayload } from "../services/videoWorkerClient";

export function createRenderRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const videoWorkerUrl = process.env.VIDEO_WORKER_URL ?? "http://video-worker:8100";
  const callbackBase = process.env.API_INTERNAL_CALLBACK_URL ?? "http://api:4000/api/internal";

  router.post("/", async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = req.params.id;

    const segments = db
      .prepare("SELECT * FROM segment_assignments WHERE campaign_id = ? ORDER BY order_index ASC")
      .all(campaignId) as any[];
    if (segments.length === 0) {
      res.status(400).json({ error: "no segment assignments found for this campaign" });
      return;
    }

    const plan = db
      .prepare("SELECT content_plan FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { content_plan: string } | undefined;
    const contentPlan = plan ? JSON.parse(plan.content_plan) : {};

    const assetPathById = new Map<string, string>();
    for (const row of db.prepare("SELECT id, file_path FROM video_assets WHERE campaign_id = ?").all(campaignId) as any[]) {
      assetPathById.set(row.id, row.file_path);
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const musicAssetId: string | null = req.body.music_asset_id ?? null;
    const ttsVoice: string = req.body.tts_voice ?? "id_ID-voice-medium";

    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, campaignId, "rendering", ttsVoice, musicAssetId, null, null, now, now);

    const segmentPayloads: RenderSegmentPayload[] = segments.map((s) => ({
      file_path: assetPathById.get(s.video_asset_id) ?? "",
      secondary_file_path: s.secondary_video_asset_id ? assetPathById.get(s.secondary_video_asset_id) : undefined,
      trim_start: s.trim_start,
      trim_end: s.trim_end,
      order_index: s.order_index,
      script_text: contentPlan[s.segment_key]?.script ?? "",
      layout_template: s.layout_template,
      crop_gameplay_rect: s.crop_gameplay_rect ? JSON.parse(s.crop_gameplay_rect) : undefined,
      crop_facecam_rect: s.crop_facecam_rect ? JSON.parse(s.crop_facecam_rect) : undefined,
      title_text: s.title_text ?? undefined,
    }));

    const musicPath = musicAssetId ? assetPathById.get(musicAssetId) ?? null : null;

    await submitRender(
      videoWorkerUrl,
      jobId,
      segmentPayloads,
      ttsVoice,
      musicPath,
      `${callbackBase}/render/${jobId}/complete`
    );

    res.status(202).json({ job_id: jobId, status: "queued" });
  });

  router.get("/:jobId", (req, res) => {
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(req.params.jobId) as any;
    if (!job) {
      res.status(404).json({ error: "render job not found" });
      return;
    }
    const captionWords = db
      .prepare("SELECT * FROM caption_words WHERE render_job_id = ? ORDER BY start_ms ASC")
      .all(req.params.jobId);
    res.json({ ...job, caption_words: captionWords });
  });

  router.post("/:jobId/finalize", (req, res) => {
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(req.params.jobId) as any;
    if (!job) {
      res.status(404).json({ error: "render job not found" });
      return;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE render_jobs SET status = ?, updated_at = ? WHERE id = ?").run("final", now, req.params.jobId);
    const updated = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(req.params.jobId);
    res.json(updated);
  });

  return router;
}
```

Modify `apps/api/src/routes/internal.ts` — add a render-complete handler in `createInternalRouter`:
```typescript
  router.post("/render/:jobId/complete", (req, res) => {
    const db = getDb(dbPath);
    const { jobId } = req.params;
    const now = new Date().toISOString();

    if (req.body.error) {
      db.prepare("UPDATE render_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        req.body.error,
        now,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    db.prepare("UPDATE render_jobs SET status = ?, output_path = ?, updated_at = ? WHERE id = ?").run(
      "ready_for_preview",
      req.body.output_path,
      now,
      jobId
    );

    const words = (req.body.caption_words ?? []) as Array<{ word: string; start_ms: number; end_ms: number }>;
    const insert = db.prepare(
      `INSERT INTO caption_words (id, render_job_id, word, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows: typeof words) => {
      for (const w of rows) {
        insert.run(randomUUID(), jobId, w.word, w.start_ms, w.end_ms);
      }
    });
    insertMany(words);

    res.json({ status: "recorded" });
  });
```

Add the `randomUUID` import to the top of `apps/api/src/routes/internal.ts` if not already present (it is, from Task 10).

Add to `apps/api/src/server.ts`:
```typescript
import { createRenderRouter } from "./routes/render";
// ...
app.use("/api/campaigns/:id/render", createRenderRouter());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/render.test.ts tests/internal.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/render.ts apps/api/src/routes/internal.ts apps/api/src/server.ts apps/api/tests/render.test.ts apps/api/tests/internal.test.ts
git commit -m "feat(api): add render submit/status/finalize routes and render-complete callback"
```

---

### Task 13: `web-ui` asset upload page with analysis status

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`
- Create: `apps/web-ui/components/AssetUpload.tsx`
- Create: `apps/web-ui/components/AssetList.tsx`
- Create: `apps/web-ui/app/campaigns/[id]/assets/page.tsx`

**Interfaces:**
- Consumes: `POST /api/campaigns/:id/assets` and `GET /api/campaigns/:id/assets` from Task 10.
- Produces: `uploadAsset(campaignId, formData): Promise<VideoAsset>`, `listAssets(campaignId): Promise<VideoAsset[]>` in `apiClient.ts`, and the asset management page at `/campaigns/:id/assets`. Task 14 depends on `VideoAsset` type and `listAssets`.

- [ ] **Step 1: Extend the API client**

Add to `apps/web-ui/lib/apiClient.ts`:
```typescript
export interface VideoAsset {
  id: string;
  campaign_id: string;
  file_path: string;
  asset_type: "footage" | "music";
  duration_seconds: number;
  analysis_status: "pending" | "done" | "failed";
  created_at: string;
}

export interface MomentCandidate {
  id: string;
  video_asset_id: string;
  timestamp_ms: number;
  score: number;
  detection_type: "audio_peak" | "scene_change";
}

export async function uploadAsset(campaignId: string, formData: FormData): Promise<VideoAsset> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(`asset upload failed with status ${res.status}`);
  return res.json();
}

export async function listAssets(campaignId: string): Promise<VideoAsset[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets`, { cache: "no-store" });
  if (!res.ok) throw new Error(`list assets failed with status ${res.status}`);
  return res.json();
}

export async function listMoments(campaignId: string, assetId: string): Promise<MomentCandidate[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/moments`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`list moments failed with status ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Build the upload and list components**

`apps/web-ui/components/AssetUpload.tsx`:
```tsx
"use client";

import { FormEvent, useState } from "react";
import { VideoAsset, uploadAsset } from "../lib/apiClient";

export function AssetUpload({
  campaignId,
  onUploaded,
}: {
  campaignId: string;
  onUploaded: (asset: VideoAsset) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData(e.currentTarget);
      const asset = await uploadAsset(campaignId, formData);
      onUploaded(asset);
      e.currentTarget.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <select name="asset_type" defaultValue="footage">
        <option value="footage">Footage</option>
        <option value="music">Music</option>
      </select>
      <input type="file" name="file" required />
      <button type="submit" disabled={submitting}>
        {submitting ? "Uploading..." : "Upload"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

`apps/web-ui/components/AssetList.tsx`:
```tsx
import { VideoAsset } from "../lib/apiClient";

export function AssetList({ assets }: { assets: VideoAsset[] }) {
  if (assets.length === 0) return <p>No assets uploaded yet.</p>;
  return (
    <ul>
      {assets.map((a) => (
        <li key={a.id}>
          {a.file_path.split("/").pop()} — {a.asset_type} — {a.duration_seconds.toFixed(1)}s
          {a.asset_type === "footage" && <span> — analysis: {a.analysis_status}</span>}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Build the page**

`apps/web-ui/app/campaigns/[id]/assets/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VideoAsset, listAssets } from "../../../../lib/apiClient";
import { AssetUpload } from "../../../../components/AssetUpload";
import { AssetList } from "../../../../components/AssetList";

export default function AssetsPage({ params }: { params: { id: string } }) {
  const [assets, setAssets] = useState<VideoAsset[]>([]);

  async function refresh() {
    setAssets(await listAssets(params.id));
  }

  useEffect(() => {
    refresh();
  }, [params.id]);

  return (
    <main>
      <h1>Assets</h1>
      <AssetUpload campaignId={params.id} onUploaded={refresh} />
      <AssetList assets={assets} />
      <Link href={`/campaigns/${params.id}/segments`}>Next: assign segments</Link>
    </main>
  );
}
```

- [ ] **Step 4: Manual verification**

Run: `docker compose -f docker/docker-compose.yml up --build -d`
Open `http://localhost:3000/campaigns/<a-planned-campaign-id>/assets`, upload a short footage file.
Expected: asset appears in the list with `analysis: pending`, then updates to `analysis: done` after a page refresh (a few seconds later).

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts apps/web-ui/components/AssetUpload.tsx apps/web-ui/components/AssetList.tsx apps/web-ui/app/campaigns/[id]/assets
git commit -m "feat(web-ui): add asset upload page with analysis status"
```

---

### Task 14: `web-ui` segment editor (timeline scrubber, crop canvas, layout picker)

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`
- Create: `apps/web-ui/components/TimelineScrubber.tsx`
- Create: `apps/web-ui/components/CropCanvas.tsx`
- Create: `apps/web-ui/components/SegmentEditor.tsx`
- Create: `apps/web-ui/app/campaigns/[id]/segments/page.tsx`
- Modify: `apps/api/Dockerfile` (add `ffmpeg`/`ffprobe` for the asset-duration probe added in Task 10)
- Modify: `docker/docker-compose.gpu.yml` (no change needed; noted here only if GPU passthrough for `video-worker`'s whisper step is desired — see Step 5)

**Interfaces:**
- Consumes: `listAssets`/`listMoments` from Task 13, `PUT /api/campaigns/:id/segments` from Task 11, `content_plan` from the existing `getCampaign` detail response (Sub-proyek 1).
- Produces: `saveSegments(campaignId, segments): Promise<SegmentAssignment[]>` in `apiClient.ts`, and the full segment-assignment page. Task 15 depends on nothing from this task directly (separate route), but both share the `apiClient.ts` module.

- [ ] **Step 1: Extend the API client**

Add to `apps/web-ui/lib/apiClient.ts`:
```typescript
export type LayoutTemplate =
  | "standard"
  | "gameplay_facecam_split"
  | "gameplay_full_focus"
  | "cinematic_letterbox";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SegmentDraft {
  segment_key: string;
  video_asset_id: string;
  secondary_video_asset_id?: string;
  trim_start: number;
  trim_end: number;
  order_index: number;
  layout_template: LayoutTemplate;
  crop_gameplay_rect?: CropRect;
  crop_facecam_rect?: CropRect;
  title_text?: string;
}

export async function saveSegments(campaignId: string, segments: SegmentDraft[]): Promise<unknown> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/segments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(JSON.stringify(body));
  }
  return res.json();
}

export async function submitRenderJob(
  campaignId: string,
  ttsVoice: string,
  musicAssetId?: string
): Promise<{ job_id: string; status: string }> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tts_voice: ttsVoice, music_asset_id: musicAssetId }),
  });
  if (!res.ok) throw new Error(`render submit failed with status ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Build the timeline scrubber**

`apps/web-ui/components/TimelineScrubber.tsx`:
```tsx
"use client";

import { useRef, useState } from "react";
import { MomentCandidate } from "../lib/apiClient";

export function TimelineScrubber({
  src,
  durationSeconds,
  moments,
  trimStart,
  trimEnd,
  onChange,
}: {
  src: string;
  durationSeconds: number;
  moments: MomentCandidate[];
  trimStart: number;
  trimEnd: number;
  onChange: (start: number, end: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  function jumpTo(seconds: number) {
    if (videoRef.current) videoRef.current.currentTime = seconds;
  }

  function setInPoint() {
    const current = videoRef.current?.currentTime ?? 0;
    onChange(current, trimEnd);
  }

  function setOutPoint() {
    const current = videoRef.current?.currentTime ?? durationSeconds;
    onChange(trimStart, current);
  }

  return (
    <div>
      <video ref={videoRef} src={src} controls style={{ width: "100%" }} />
      <div style={{ position: "relative", height: 24, background: "#ddd" }}>
        {moments.map((m) => (
          <button
            key={m.id}
            type="button"
            title={`${m.detection_type} (${m.score.toFixed(2)})`}
            onClick={() => jumpTo(m.timestamp_ms / 1000)}
            style={{
              position: "absolute",
              left: `${(m.timestamp_ms / 1000 / durationSeconds) * 100}%`,
              width: 4,
              height: "100%",
              background: m.detection_type === "audio_peak" ? "orange" : "purple",
              border: "none",
            }}
          />
        ))}
      </div>
      <button type="button" onClick={setInPoint}>
        Set In ({trimStart.toFixed(1)}s)
      </button>
      <button type="button" onClick={setOutPoint}>
        Set Out ({trimEnd.toFixed(1)}s)
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Build the crop canvas**

`apps/web-ui/components/CropCanvas.tsx`:
```tsx
"use client";

import { useRef, useState } from "react";
import { CropRect } from "../lib/apiClient";

export function CropCanvas({
  imageSrc,
  label,
  onChange,
}: {
  imageSrc: string;
  label: string;
  onChange: (rect: CropRect) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);

  function relativePos(e: React.MouseEvent): { x: number; y: number } {
    const bounds = containerRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - bounds.left) / bounds.width,
      y: (e.clientY - bounds.top) / bounds.height,
    };
  }

  function handleMouseDown(e: React.MouseEvent) {
    setStart(relativePos(e));
  }

  function handleMouseUp(e: React.MouseEvent) {
    if (!start) return;
    const end = relativePos(e);
    const newRect: CropRect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    setRect(newRect);
    onChange(newRect);
    setStart(null);
  }

  return (
    <div>
      <p>{label}</p>
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        style={{ position: "relative", width: "100%", cursor: "crosshair" }}
      >
        <img src={imageSrc} alt={label} style={{ width: "100%", display: "block" }} />
        {rect && (
          <div
            style={{
              position: "absolute",
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              border: "2px solid red",
            }}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build the segment editor and page**

`apps/web-ui/components/SegmentEditor.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import {
  CropRect,
  LayoutTemplate,
  MomentCandidate,
  SegmentDraft,
  VideoAsset,
  listMoments,
} from "../lib/apiClient";
import { TimelineScrubber } from "./TimelineScrubber";
import { CropCanvas } from "./CropCanvas";

const TEMPLATES: LayoutTemplate[] = [
  "standard",
  "gameplay_facecam_split",
  "gameplay_full_focus",
  "cinematic_letterbox",
];

export function SegmentEditor({
  campaignId,
  segmentKey,
  assets,
  draft,
  onChange,
}: {
  campaignId: string;
  segmentKey: string;
  assets: VideoAsset[];
  draft: SegmentDraft;
  onChange: (draft: SegmentDraft) => void;
}) {
  const [moments, setMoments] = useState<MomentCandidate[]>([]);
  const asset = assets.find((a) => a.id === draft.video_asset_id);

  useEffect(() => {
    if (draft.video_asset_id) {
      listMoments(campaignId, draft.video_asset_id).then(setMoments);
    }
  }, [campaignId, draft.video_asset_id]);

  const needsGameplayCrop =
    !draft.secondary_video_asset_id &&
    (draft.layout_template === "gameplay_full_focus" || draft.layout_template === "gameplay_facecam_split");
  const needsFacecamCrop = !draft.secondary_video_asset_id && draft.layout_template === "gameplay_facecam_split";

  return (
    <fieldset>
      <legend>{segmentKey}</legend>

      <select
        value={draft.video_asset_id}
        onChange={(e) => onChange({ ...draft, video_asset_id: e.target.value })}
      >
        <option value="">Select footage</option>
        {assets
          .filter((a) => a.asset_type === "footage")
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.file_path.split("/").pop()}
            </option>
          ))}
      </select>

      <select
        value={draft.layout_template}
        onChange={(e) => onChange({ ...draft, layout_template: e.target.value as LayoutTemplate })}
      >
        {TEMPLATES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      {asset && (
        <TimelineScrubber
          src={`/media/${asset.file_path}`}
          durationSeconds={asset.duration_seconds}
          moments={moments}
          trimStart={draft.trim_start}
          trimEnd={draft.trim_end}
          onChange={(start, end) => onChange({ ...draft, trim_start: start, trim_end: end })}
        />
      )}

      {needsGameplayCrop && asset && (
        <CropCanvas
          imageSrc={`/media/${asset.file_path}`}
          label="Gameplay area"
          onChange={(rect: CropRect) => onChange({ ...draft, crop_gameplay_rect: rect })}
        />
      )}
      {needsFacecamCrop && asset && (
        <CropCanvas
          imageSrc={`/media/${asset.file_path}`}
          label="Facecam area"
          onChange={(rect: CropRect) => onChange({ ...draft, crop_facecam_rect: rect })}
        />
      )}

      <input
        type="text"
        placeholder="Title text (optional)"
        value={draft.title_text ?? ""}
        onChange={(e) => onChange({ ...draft, title_text: e.target.value })}
      />
    </fieldset>
  );
}
```

`apps/web-ui/app/campaigns/[id]/segments/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  SegmentDraft,
  VideoAsset,
  getCampaign,
  listAssets,
  saveSegments,
  submitRenderJob,
} from "../../../../lib/apiClient";
import { SegmentEditor } from "../../../../components/SegmentEditor";

export default function SegmentsPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [drafts, setDrafts] = useState<Record<string, SegmentDraft>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listAssets(params.id), getCampaign(params.id)]).then(([assetList, campaign]) => {
      setAssets(assetList);
      const segmentKeys = Object.keys(campaign.plan?.content_plan ?? {});
      const initial: Record<string, SegmentDraft> = {};
      segmentKeys.forEach((key, index) => {
        initial[key] = {
          segment_key: key,
          video_asset_id: "",
          trim_start: 0,
          trim_end: 0,
          order_index: index,
          layout_template: "standard",
        };
      });
      setDrafts(initial);
    });
  }, [params.id]);

  async function handleSubmit() {
    setError(null);
    try {
      await saveSegments(params.id, Object.values(drafts));
      const job = await submitRenderJob(params.id, "id_ID-voice-medium");
      router.push(`/campaigns/${params.id}/preview/${job.job_id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Assign Segments</h1>
      {Object.entries(drafts).map(([key, draft]) => (
        <SegmentEditor
          key={key}
          campaignId={params.id}
          segmentKey={key}
          assets={assets}
          draft={draft}
          onChange={(updated) => setDrafts({ ...drafts, [key]: updated })}
        />
      ))}
      <button type="button" onClick={handleSubmit}>
        Submit Render
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 5: Serve uploaded media statically from `api` and add ffmpeg to its Dockerfile**

Add to `apps/api/src/server.ts` (inside `createApp`, after `express.json()`):
```typescript
  app.use("/media", express.static(process.env.VIDEO_ASSETS_DIR ?? "/app/video-assets"));
```

Modify `apps/api/Dockerfile` to add `ffmpeg` (needed for the `ffprobe` call added in Task 10):
```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]
```

- [ ] **Step 6: Manual verification**

Run: `docker compose -f docker/docker-compose.yml up --build -d`
Upload footage on the assets page, then open `/campaigns/<id>/segments`.
Expected: each `content_plan` segment shows a footage dropdown, layout picker, timeline scrubber with moment markers (after analysis finishes), crop canvases appear only for templates that need them, and submitting navigates to the preview page with a job id in the URL.

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts apps/web-ui/components/TimelineScrubber.tsx apps/web-ui/components/CropCanvas.tsx apps/web-ui/components/SegmentEditor.tsx apps/web-ui/app/campaigns/[id]/segments apps/api/src/server.ts apps/api/Dockerfile
git commit -m "feat(web-ui): add segment editor with timeline scrubber, crop canvas, and layout picker"
```

---

### Task 15: `web-ui` render preview and finalize page

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`
- Create: `apps/web-ui/components/RenderPreview.tsx`
- Create: `apps/web-ui/app/campaigns/[id]/preview/[jobId]/page.tsx`

**Interfaces:**
- Consumes: `GET /api/campaigns/:id/render/:jobId` and `POST /api/campaigns/:id/render/:jobId/finalize` from Task 12.
- Produces: `getRenderJob(campaignId, jobId): Promise<RenderJobDetail>`, `finalizeRenderJob(campaignId, jobId): Promise<RenderJobDetail>` in `apiClient.ts`, and the preview page with polling and re-render controls.

- [ ] **Step 1: Extend the API client**

Add to `apps/web-ui/lib/apiClient.ts`:
```typescript
export interface RenderJobDetail {
  id: string;
  campaign_id: string;
  status: "queued" | "rendering" | "ready_for_preview" | "final" | "failed";
  tts_voice: string;
  music_asset_id: string | null;
  output_path: string | null;
  error_message: string | null;
}

export async function getRenderJob(campaignId: string, jobId: string): Promise<RenderJobDetail> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render/${jobId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get render job failed with status ${res.status}`);
  return res.json();
}

export async function finalizeRenderJob(campaignId: string, jobId: string): Promise<RenderJobDetail> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render/${jobId}/finalize`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`finalize failed with status ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Build the preview component**

`apps/web-ui/components/RenderPreview.tsx`:
```tsx
"use client";

import { useState } from "react";
import { RenderJobDetail, finalizeRenderJob, submitRenderJob } from "../lib/apiClient";
import { useRouter } from "next/navigation";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function RenderPreview({ campaignId, job }: { campaignId: string; job: RenderJobDetail }) {
  const router = useRouter();
  const [voice, setVoice] = useState(job.tts_voice);
  const [finalizing, setFinalizing] = useState(false);

  async function handleReRender() {
    const newJob = await submitRenderJob(campaignId, voice, job.music_asset_id ?? undefined);
    router.push(`/campaigns/${campaignId}/preview/${newJob.job_id}`);
  }

  async function handleFinalize() {
    setFinalizing(true);
    await finalizeRenderJob(campaignId, job.id);
    setFinalizing(false);
    router.refresh();
  }

  if (job.status === "failed") {
    return <p role="alert">Render failed: {job.error_message}</p>;
  }
  if (job.status !== "ready_for_preview" && job.status !== "final") {
    return <p>Rendering... ({job.status})</p>;
  }

  return (
    <div>
      <video src={`${API_BASE_URL}/media${job.output_path?.replace("/app/video-assets", "")}`} controls />
      <p>Status: {job.status}</p>
      <input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="TTS voice" />
      <button type="button" onClick={handleReRender}>
        Re-render with new voice
      </button>
      {job.status !== "final" && (
        <button type="button" onClick={handleFinalize} disabled={finalizing}>
          Finalize
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the page with polling**

`apps/web-ui/app/campaigns/[id]/preview/[jobId]/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { RenderJobDetail, getRenderJob } from "../../../../../lib/apiClient";
import { RenderPreview } from "../../../../../components/RenderPreview";

export default function PreviewPage({ params }: { params: { id: string; jobId: string } }) {
  const [job, setJob] = useState<RenderJobDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const result = await getRenderJob(params.id, params.jobId);
      if (cancelled) return;
      setJob(result);
      if (result.status === "rendering" || result.status === "queued") {
        setTimeout(poll, 3000);
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [params.id, params.jobId]);

  if (!job) return <p>Loading...</p>;
  return (
    <main>
      <h1>Render Preview</h1>
      <RenderPreview campaignId={params.id} job={job} />
    </main>
  );
}
```

- [ ] **Step 4: Manual verification**

Run: `docker compose -f docker/docker-compose.yml up --build -d`
Complete the full flow: upload footage/music, assign segments, submit render, watch the preview page poll until `ready_for_preview`, play the video, click Finalize.
Expected: video plays with visible layout (split/crop/letterbox as chosen), caption burned in, title text (if set) visible, status becomes `final` after clicking Finalize.

Run: `docker compose -f docker/docker-compose.yml down`

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts apps/web-ui/components/RenderPreview.tsx apps/web-ui/app/campaigns/[id]/preview
git commit -m "feat(web-ui): add render preview page with polling, re-render, and finalize"
```

---

### Task 16: End-to-end integration test across `api` and `video-worker`

**Files:**
- Create: `tests/fixtures/gameplay_clip.mp4`
- Create: `tests/e2e_video.test.sh`

**Interfaces:**
- Consumes: the full running stack (`api`, `video-worker`, plus Sub-proyek 1's `ai-worker`/`ollama` to first produce a `planned` campaign) from `docker compose up`.
- Produces: a shell script exercising asset upload → analysis → segment assignment → render → finalize end-to-end, exiting non-zero on failure.

- [ ] **Step 1: Generate a two-tone gameplay fixture (for crop verification)**

Run once:
```bash
ffmpeg -y -f lavfi -i "color=c=green:s=1920x1080:d=3[top]; color=c=yellow:s=1920x1080:d=3[bottom]; [top][bottom]vstack" -c:v libx264 tests/fixtures/gameplay_clip.mp4
```

- [ ] **Step 2: Write the e2e script**

`tests/e2e_video.test.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

API_URL="http://localhost:4000"

echo "Creating a planned campaign via Sub-proyek 1 flow..."
CAMPAIGN_RESPONSE=$(curl -sf -X POST "$API_URL/api/campaigns" \
  -F "file=@tests/fixtures/brd_sample.pdf;type=application/pdf" \
  -F "title=Video E2E Campaign" \
  -F "content_format=gameplay clip" \
  -F "target_language=id" \
  -F "deadline=2026-10-01" \
  -F "reward=Rp 500.000" \
  -F "constraints=none")
CAMPAIGN_ID=$(echo "$CAMPAIGN_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "Campaign: $CAMPAIGN_ID"

echo "Uploading footage asset..."
ASSET_RESPONSE=$(curl -sf -X POST "$API_URL/api/campaigns/$CAMPAIGN_ID/assets" \
  -F "asset_type=footage" \
  -F "file=@tests/fixtures/gameplay_clip.mp4;type=video/mp4")
ASSET_ID=$(echo "$ASSET_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "Asset: $ASSET_ID"

echo "Waiting for analysis to complete..."
for i in $(seq 1 20); do
  STATUS=$(curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID/assets" | python3 -c "
import sys, json
assets = json.load(sys.stdin)
print(next(a['analysis_status'] for a in assets if a['id'] == '$ASSET_ID'))
")
  if [[ "$STATUS" == "done" || "$STATUS" == "failed" ]]; then
    break
  fi
  sleep 1
done
echo "Analysis status: $STATUS"

echo "Assigning segments..."
DETAIL=$(curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID")
SEGMENT_KEYS=$(echo "$DETAIL" | python3 -c "
import sys, json
print(','.join(json.load(sys.stdin)['plan']['content_plan'].keys()))
")
python3 - "$CAMPAIGN_ID" "$ASSET_ID" "$SEGMENT_KEYS" <<'PY'
import json
import sys
import urllib.request

campaign_id, asset_id, keys = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
segments = [
    {
        "segment_key": key,
        "video_asset_id": asset_id,
        "trim_start": 0,
        "trim_end": 1,
        "order_index": i,
        "layout_template": "gameplay_full_focus",
        "crop_gameplay_rect": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 0.5},
    }
    for i, key in enumerate(keys)
]
req = urllib.request.Request(
    f"http://localhost:4000/api/campaigns/{campaign_id}/segments",
    data=json.dumps({"segments": segments}).encode(),
    headers={"Content-Type": "application/json"},
    method="PUT",
)
urllib.request.urlopen(req).read()
PY

echo "Submitting render..."
RENDER_RESPONSE=$(curl -sf -X POST "$API_URL/api/campaigns/$CAMPAIGN_ID/render" \
  -H "Content-Type: application/json" \
  -d '{"tts_voice": "id_ID-news_tts-medium"}')
JOB_ID=$(echo "$RENDER_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['job_id'])")
echo "Job: $JOB_ID"

echo "Polling render status..."
for i in $(seq 1 60); do
  JOB_STATUS=$(curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID/render/$JOB_ID" | python3 -c "import sys, json; print(json.load(sys.stdin)['status'])")
  if [[ "$JOB_STATUS" == "ready_for_preview" || "$JOB_STATUS" == "failed" ]]; then
    break
  fi
  sleep 3
done
echo "Render status: $JOB_STATUS"

if [[ "$JOB_STATUS" != "ready_for_preview" ]]; then
  echo "FAIL: render did not reach ready_for_preview"
  curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID/render/$JOB_ID"
  exit 1
fi

echo "Finalizing..."
curl -sf -X POST "$API_URL/api/campaigns/$CAMPAIGN_ID/render/$JOB_ID/finalize" > /dev/null

echo "PASS"
```

Run: `chmod +x tests/e2e_video.test.sh`

- [ ] **Step 3: Run against the real stack**

Run:
```bash
docker compose -f docker/docker-compose.yml up --build -d
sleep 5
docker exec $(docker compose -f docker/docker-compose.yml ps -q ollama) ollama pull mistral:7b-instruct

# Provision a real Piper voice model. No task in this plan ever downloads an
# actual .onnx voice file into the piper-voices volume -- without this, the
# render pipeline's TTS step fails with "model file not found" on every run.
# id_ID-news_tts-medium is a real voice from the official rhasspy/piper-voices
# repository (confirmed present in that repo's voices.json); downloaded here
# via the video-worker container's own Python (no curl needed in the image).
docker exec $(docker compose -f docker/docker-compose.yml ps -q video-worker) python -c "
import os
import urllib.request
os.makedirs('/app/voices', exist_ok=True)
base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx'
urllib.request.urlretrieve(base, '/app/voices/id_ID-news_tts-medium.onnx')
urllib.request.urlretrieve(base + '.json', '/app/voices/id_ID-news_tts-medium.onnx.json')
"

./tests/e2e_video.test.sh
docker compose -f docker/docker-compose.yml down
```
Expected: script prints `PASS`. If `analysis_status` is `failed` or `JOB_STATUS` is `failed`, inspect `docker compose -f docker/docker-compose.yml logs video-worker` for the ffmpeg/Piper/whisper error before treating this as a real regression — whisper's own model download also needs to be reachable in the container for a first run (faster-whisper downloads its "small" model on first use).

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/gameplay_clip.mp4 tests/e2e_video.test.sh
git commit -m "test: add end-to-end script covering asset upload through render finalize"
```

---

## Self-Review Notes

- **Spec coverage:** footage/music upload (Task 10), timeline scrubber + moment-candidate markers (Task 2, 3, 14), 4 layout templates + crop drawing (Task 6, 11, 14), title text overlay (Task 6, 7), TTS (Task 4), forced-alignment captions (Task 5, 7), render/preview/re-render/finalize (Task 8, 12, 15), Docker Compose + `video-worker` service (Task 1, 14 Dockerfile update). Every "Termasuk" bullet has a task; every "Tidak termasuk" bullet is respected (no auto-download, no auto-trim beyond advisory markers, no generative video, no bundled music, no external publish, no custom templates).
- **Placeholder scan:** no TBD/TODO markers; every step has runnable code or an exact command.
- **Type consistency:** `MomentCandidate` fields (`timestamp_ms`, `score`, `detection_type`) match across Task 2 (Python), Task 3 (route), Task 9 (TS type), Task 13 (web-ui type). `CaptionWord` fields (`word`, `start_ms`, `end_ms`) match across Task 5, 7, 8, 9, 12. `SegmentInput`/`RenderSegmentInput` and the TS `SegmentAssignment`/`SegmentDraft` types carry the same field names (`layout_template`, `crop_gameplay_rect`, `crop_facecam_rect`, `secondary_video_asset_id`/`secondary_file_path`, `title_text`) across Python (Task 6, 7), `api` (Task 9, 11, 12), and `web-ui` (Task 14). Route paths (`/api/campaigns/:id/assets`, `/api/campaigns/:id/assets/:assetId/moments`, `/api/campaigns/:id/segments`, `/api/campaigns/:id/render`, `/api/campaigns/:id/render/:jobId`, `/api/campaigns/:id/render/:jobId/finalize`, `/api/internal/assets/:assetId/analysis-complete`, `/api/internal/render/:jobId/complete`) are identical between `api` (Task 10, 11, 12) and `video-worker`'s callback targets (Task 3, 8) and `web-ui`'s client calls (Task 13, 14, 15).
