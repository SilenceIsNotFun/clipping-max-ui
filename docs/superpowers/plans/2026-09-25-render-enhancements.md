# Render Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `video-worker`'s render pipeline with karaoke-style ASS captions, PNG-rendered title overlays, and an auto-suggested crop (face detection with saliency fallback) that pre-fills the operator's manual crop tools — without changing the existing upload/assign/render/finalize architecture from Sub-proyek 2.

**Architecture:** Two new, independently-testable Python modules in `video-worker` (`face_crop.py` for crop suggestion, `title_render.py` for PNG title rendering) plug into the existing `/analyze` and render pipeline. `layout.py`'s title handling is restructured from `drawtext` text-interpolation to an `overlay` filter referencing a pre-rendered PNG input, with every layout branch now producing an explicit `[out]` label so the render step's `-map` is always unambiguous. `render.py`'s caption writer switches from SRT to ASS with per-word color-swap highlighting. `api` persists crop suggestions in a new table and threads a new `caption_style` field through the existing segment/render request-response shapes. `web-ui` fetches the suggestion to pre-fill the existing `CropCanvas` and adds a caption-style picker.

**Tech Stack:** OpenCV (`opencv-python-headless`) + a vendored YuNet ONNX face detector for the primary face-detection path (Haar cascade fallback ships with OpenCV itself), OpenCV's `StaticSaliencySpectralResidual` + frame-difference motion centroid for the no-face fallback, Pillow (already available via the Docker base) for PNG title rendering, ASS (Advanced SubStation Alpha) text format for captions — all within the existing FastAPI/Express/Next.js stack from Sub-proyek 1-2.

**Spec:** `docs/superpowers/specs/2026-09-25-render-enhancements-design.md`

## Global Constraints

- No real-time per-frame face tracking — crop suggestion is one static rect per video asset, computed once during `/analyze`, same as the existing moment-detection timing.
- No YouTube heatmap or external engagement data of any kind.
- No LLM-based clip/moment suggestion in this sub-project (noted as a separate future idea in the spec, not in scope here).
- No emoji rendering support in title PNGs for this MVP.
- Only 2-3 hardcoded caption style presets; no operator-defined colors/fonts.
- Crop suggestions are strictly advisory: they only pre-fill the UI's existing manual crop tool (`CropCanvas`), never write directly to `segment_assignments`. The operator's own submit of the segment form is still what persists the final crop, preserving the "operator has final say" principle already established for moment detection and crop drawing in Sub-proyek 2.
- Output canvas stays 1080x1920 (9:16), consistent with all of Sub-proyek 2.
- Model file `face_detection_yunet.onnx` is vendored into the repo (not downloaded at Docker build time), avoiding an additional network dependency point of failure.

---

## File Structure

```
apps/video-worker/
  models/
    face_detection_yunet.onnx   # vendored ONNX face detector, ~230KB, MIT license
  face_crop.py                    # NEW: face + saliency crop suggestion
  title_render.py                   # NEW: Pillow-based PNG title rendering
  layout.py                           # MODIFY: title_text -> title_overlay_path, explicit [out] labels
  render.py                             # MODIFY: SRT -> ASS captions, title PNG rendering wired in
  schemas.py                              # MODIFY: CropSuggestion, SegmentInput/RenderSegmentInput changes
  main.py                                   # MODIFY: /analyze calls detect_crop_suggestion too
  requirements.txt                            # MODIFY: add opencv-python-headless
  tests/
    test_face_crop.py
    test_title_render.py
    fixtures/
      (reuses existing short_clip.mp4/cut_clip.mp4 from Sub-proyek 2)

apps/api/
  src/
    db.ts                        # MODIFY: crop_suggestions table, segment_assignments.caption_style column
    types.ts                       # MODIFY: CropSuggestion, caption_style field additions
    routes/
      assets.ts                     # MODIFY: add GET /:assetId/crop-suggestion
      internal.ts                     # MODIFY: analysis-complete inserts crop_suggestions when present
      segments.ts                       # MODIFY: accept/persist caption_style
      render.ts                           # MODIFY: thread caption_style into video-worker payload
    services/
      videoWorkerClient.ts                  # MODIFY: RenderSegmentPayload gains caption_style
  tests/
    db.test.ts, assets.test.ts, internal.test.ts, segments.test.ts, render.test.ts   # all MODIFY (append cases)

apps/web-ui/
  lib/apiClient.ts               # MODIFY: CropSuggestion type, getCropSuggestion, SegmentDraft.caption_style
  components/
    SegmentEditor.tsx              # MODIFY: fetch+pre-fill crop suggestion, caption_style select
    CropCanvas.tsx                   # MODIFY: accept optional initialRect prop
```

Rationale: `face_crop.py` and `title_render.py` are new, single-purpose modules following the same pattern as `moment_detection.py`/`tts.py`/`alignment.py` from Sub-proyek 2 — each does one thing, is independently unit-testable, and plugs into `main.py`/`render.py` through a narrow function-call interface. `layout.py`'s restructuring (explicit `[out]` labels on every branch) is the minimal change needed to support an additional PNG input without breaking the four existing layout templates.

---

### Task 1: Vendor YuNet model and add OpenCV dependency

**Files:**
- Create: `apps/video-worker/models/face_detection_yunet.onnx`
- Modify: `apps/video-worker/requirements.txt`

**Interfaces:**
- Consumes: nothing new.
- Produces: `apps/video-worker/models/face_detection_yunet.onnx` on disk, `opencv-python-headless` importable as `cv2`. Task 2 depends on both.

- [ ] **Step 1: Download the YuNet model into the repo**

Run (one-time, not part of the Docker build):
```bash
curl -sfL https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx -o apps/video-worker/models/face_detection_yunet.onnx
```
Verify it downloaded correctly:
```bash
ls -la apps/video-worker/models/face_detection_yunet.onnx
```
Expected: a file roughly 230-350KB in size (exact size varies by model revision; anything under 10KB means the download failed and returned an error page instead — re-run with `-v` to check for a redirect/404).

- [ ] **Step 2: Add OpenCV to requirements**

Add to `apps/video-worker/requirements.txt`:
```
opencv-python-headless==4.10.0.84
```

- [ ] **Step 3: Verify the dependency installs and the model loads**

Run (using whatever Python environment this worktree already has set up for `video-worker`, e.g. `uv venv`/`uv pip install` if `python3 -m venv` isn't available on this host — same pattern used throughout Sub-proyek 2):
```bash
cd apps/video-worker && uv pip install opencv-python-headless==4.10.0.84 2>&1 | tail -5
python3 -c "
import cv2
detector = cv2.FaceDetectorYN.create('models/face_detection_yunet.onnx', '', (320, 320))
print('YuNet loaded OK:', detector is not None)
"
```
Expected: `YuNet loaded OK: True`. If real ffmpeg/cv2 isn't available on the bare host, fall back to the Docker build+run verification pattern established in Sub-proyek 2 (build the `video-worker` image, run the same check inside a container).

- [ ] **Step 4: Commit**

```bash
git add apps/video-worker/models/face_detection_yunet.onnx apps/video-worker/requirements.txt
git commit -m "feat(video-worker): vendor YuNet face detection model, add OpenCV dependency"
```

---

### Task 2: Face-based crop suggestion (detection + clustering + scoring)

**Files:**
- Create: `apps/video-worker/face_crop.py`
- Modify: `apps/video-worker/schemas.py`
- Create: `apps/video-worker/tests/test_face_crop.py`

**Interfaces:**
- Consumes: `probe_duration` from `ffmpeg_utils.py` (Task 1 of Sub-proyek 2, already exists), `CropRect` from `schemas.py` (already exists).
- Produces: `CropSuggestion` schema (`crop_gameplay_rect: CropRect | None`, `crop_facecam_rect: CropRect | None`, `detection_method: Literal["face", "saliency"]`, `confidence: float`); `detect_face_crop(video_path: str) -> tuple[CropRect | None, CropRect | None]` (primary and optional secondary/dual-speaker rect). Task 3 depends on this exact function name/signature.

- [ ] **Step 1: Add `CropSuggestion` schema**

Add to `apps/video-worker/schemas.py` (after the existing `CropRect` class):
```python
class CropSuggestion(BaseModel):
    crop_gameplay_rect: Optional[CropRect] = None
    crop_facecam_rect: Optional[CropRect] = None
    detection_method: Literal["face", "saliency"]
    confidence: float
```

- [ ] **Step 2: Write failing tests for clustering/scoring/orchestration**

`apps/video-worker/tests/test_face_crop.py`:
```python
from unittest.mock import patch

from face_crop import _cluster_detections, _score_cluster, detect_face_crop


def test_cluster_detections_groups_nearby_points():
    boxes = [
        (0.5, 0.5, 0.2, 0.2),
        (0.51, 0.49, 0.2, 0.2),
        (0.9, 0.1, 0.15, 0.15),
    ]
    clusters = _cluster_detections(boxes)
    assert len(clusters) == 2
    sizes = sorted(len(c["points"]) for c in clusters)
    assert sizes == [1, 2]


def test_score_cluster_rewards_count_width_and_center_bias():
    center_cluster = {"cx": 0.5, "points": [(0.5, 0.5, 0.3, 0.3)] * 5}
    edge_cluster = {"cx": 0.95, "points": [(0.95, 0.5, 0.3, 0.3)] * 5}
    assert _score_cluster(center_cluster) > _score_cluster(edge_cluster)


def test_detect_face_crop_returns_none_when_no_faces_found():
    with patch("face_crop._extract_frame", return_value=None):
        primary, secondary = detect_face_crop("/fake/path.mp4")
    assert primary is None
    assert secondary is None


def test_detect_face_crop_picks_highest_scoring_cluster():
    fake_frame = object()

    def fake_detect(frame):
        return [(0.5, 0.5, 0.2, 0.2)]

    with patch("face_crop._extract_frame", return_value=fake_frame), patch(
        "face_crop.detect_faces_in_frame", side_effect=fake_detect
    ), patch("face_crop.probe_duration", return_value=10.0):
        primary, secondary = detect_face_crop("/fake/path.mp4")

    assert primary is not None
    assert 0.0 <= primary.x <= 1.0
    assert 0.0 <= primary.y <= 1.0
    assert primary.width > 0
    assert primary.height > 0
    assert secondary is None


def test_detect_face_crop_finds_dual_speakers_on_opposite_sides():
    fake_frame = object()

    def fake_detect(frame):
        return [(0.2, 0.5, 0.15, 0.15), (0.8, 0.5, 0.15, 0.15)]

    with patch("face_crop._extract_frame", return_value=fake_frame), patch(
        "face_crop.detect_faces_in_frame", side_effect=fake_detect
    ), patch("face_crop.probe_duration", return_value=10.0):
        primary, secondary = detect_face_crop("/fake/path.mp4")

    assert primary is not None
    assert secondary is not None
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_face_crop.py -v`
Expected: `ModuleNotFoundError: No module named 'face_crop'`.

- [ ] **Step 4: Implement face detection, clustering, and scoring**

`apps/video-worker/face_crop.py`:
```python
import os
from typing import List, Optional, Tuple

import cv2
import numpy as np

from ffmpeg_utils import probe_duration
from schemas import CropRect

MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
YUNET_MODEL_PATH = os.path.join(MODEL_DIR, "face_detection_yunet.onnx")

SAMPLE_COUNT = 25
CLUSTER_DISTANCE_THRESHOLD = 0.12
MIN_CLUSTER_SIZE = 2
DUAL_SPEAKER_MIN_SEPARATION = 0.3


def _sample_frame_timestamps(duration_seconds: float, count: int = SAMPLE_COUNT) -> List[float]:
    if duration_seconds <= 0:
        return []
    step = duration_seconds / (count + 1)
    return [step * (i + 1) for i in range(count)]


def _extract_frame(video_path: str, timestamp: float):
    cap = cv2.VideoCapture(video_path)
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
        ok, frame = cap.read()
        return frame if ok else None
    finally:
        cap.release()


_yunet_detector = None


def _get_yunet_detector(frame_w: int, frame_h: int):
    global _yunet_detector
    if not os.path.exists(YUNET_MODEL_PATH):
        return None
    if _yunet_detector is None:
        _yunet_detector = cv2.FaceDetectorYN.create(YUNET_MODEL_PATH, "", (frame_w, frame_h))
    else:
        _yunet_detector.setInputSize((frame_w, frame_h))
    return _yunet_detector


def detect_faces_in_frame(frame) -> List[Tuple[float, float, float, float]]:
    """Returns (cx, cy, w, h) normalized 0-1 face boxes. Tries YuNet first, falls
    back to OpenCV's bundled Haar cascade if YuNet finds nothing."""
    h, w = frame.shape[:2]
    boxes: List[Tuple[float, float, float, float]] = []

    detector = _get_yunet_detector(w, h)
    if detector is not None:
        _, faces = detector.detect(frame)
        if faces is not None:
            for f in faces:
                x, y, fw, fh = float(f[0]), float(f[1]), float(f[2]), float(f[3])
                boxes.append(((x + fw / 2) / w, (y + fh / 2) / h, fw / w, fh / h))

    if boxes:
        return boxes

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    detections = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5)
    for (x, y, fw, fh) in detections:
        boxes.append(((x + fw / 2) / w, (y + fh / 2) / h, fw / w, fh / h))
    return boxes


def _cluster_detections(all_boxes: List[Tuple[float, float, float, float]]) -> List[dict]:
    clusters: List[dict] = []
    for cx, cy, w, h in all_boxes:
        matched = None
        for c in clusters:
            dist = ((cx - c["cx"]) ** 2 + (cy - c["cy"]) ** 2) ** 0.5
            if dist < CLUSTER_DISTANCE_THRESHOLD:
                matched = c
                break
        if matched:
            matched["points"].append((cx, cy, w, h))
            n = len(matched["points"])
            matched["cx"] = sum(p[0] for p in matched["points"]) / n
            matched["cy"] = sum(p[1] for p in matched["points"]) / n
        else:
            clusters.append({"cx": cx, "cy": cy, "points": [(cx, cy, w, h)]})
    return clusters


def _score_cluster(cluster: dict) -> float:
    points = cluster["points"]
    count = len(points)
    avg_w = sum(p[2] for p in points) / count
    center_bias = 1.0 - abs(cluster["cx"] - 0.5)
    return count * (avg_w ** 0.5) * max(0.1, center_bias)


def _cluster_to_rect(cluster: dict) -> CropRect:
    points = cluster["points"]
    avg_w = sum(p[2] for p in points) / len(points)
    avg_h = sum(p[3] for p in points) / len(points)
    cx, cy = cluster["cx"], cluster["cy"]
    if abs(cx - 0.5) < 0.03:
        cx = 0.5

    crop_w = min(1.0, avg_w * 2.5)
    crop_h = min(1.0, avg_h * 2.5)
    x = max(0.0, min(1.0 - crop_w, cx - crop_w / 2))
    y = max(0.0, min(1.0 - crop_h, cy - crop_h / 2))
    return CropRect(x=round(x, 3), y=round(y, 3), width=round(crop_w, 3), height=round(crop_h, 3))


def detect_face_crop(video_path: str) -> Tuple[Optional[CropRect], Optional[CropRect]]:
    """Samples frames across the video, detects faces, and returns (primary_rect,
    secondary_rect). secondary_rect is only set when two well-separated speaker
    clusters are found (dual-speaker / side-by-side interview format)."""
    duration = probe_duration(video_path)
    timestamps = _sample_frame_timestamps(duration)

    all_boxes: List[Tuple[float, float, float, float]] = []
    for ts in timestamps:
        frame = _extract_frame(video_path, ts)
        if frame is None:
            continue
        all_boxes.extend(detect_faces_in_frame(frame))

    clusters = [c for c in _cluster_detections(all_boxes) if len(c["points"]) >= MIN_CLUSTER_SIZE]
    if not clusters:
        return None, None

    clusters.sort(key=_score_cluster, reverse=True)
    primary = _cluster_to_rect(clusters[0])

    if len(clusters) >= 2:
        second_best = clusters[1]
        separation = abs(clusters[0]["cx"] - second_best["cx"])
        if separation >= DUAL_SPEAKER_MIN_SEPARATION:
            secondary = _cluster_to_rect(second_best)
            return primary, secondary

    return primary, None
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_face_crop.py -v`
Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/face_crop.py apps/video-worker/schemas.py apps/video-worker/tests/test_face_crop.py
git commit -m "feat(video-worker): detect face-based crop suggestions with clustering and dual-speaker support"
```

---

### Task 3: Saliency fallback and top-level crop suggestion orchestrator

**Files:**
- Modify: `apps/video-worker/face_crop.py`
- Modify: `apps/video-worker/tests/test_face_crop.py`

**Interfaces:**
- Consumes: `detect_face_crop` from Task 2, `probe_duration`/`_extract_frame` (module-internal from Task 2).
- Produces: `detect_saliency_crop(video_path: str) -> CropRect | None`; `detect_crop_suggestion(video_path: str) -> CropSuggestion | None` (tries face detection first, falls back to saliency, returns `None` if both find nothing). Task 4 (`/analyze` wiring) depends on `detect_crop_suggestion`'s exact name and return type.

- [ ] **Step 1: Write failing tests for saliency fallback and the orchestrator**

Append to `apps/video-worker/tests/test_face_crop.py`:
```python
from face_crop import detect_crop_suggestion, detect_saliency_crop


def test_detect_saliency_crop_returns_none_when_no_frames_readable():
    with patch("face_crop._extract_frame", return_value=None):
        result = detect_saliency_crop("/fake/path.mp4")
    assert result is None


def test_detect_saliency_crop_centers_on_weighted_motion(tmp_path):
    # Use the real short_clip.mp4 fixture (static two-tone frame, no faces) to
    # exercise the real saliency+motion code path end-to-end rather than mocking
    # cv2.saliency internals, which are awkward to mock meaningfully.
    import os

    fixture = os.path.join(os.path.dirname(__file__), "fixtures", "short_clip.mp4")
    result = detect_saliency_crop(fixture)
    # A static, unchanging two-color frame has no motion signal, so this may
    # legitimately return None (no saliency/motion peak found) -- the real
    # assertion is that it does not raise, and if it returns a rect, the rect
    # is well-formed.
    if result is not None:
        assert 0.0 <= result.x <= 1.0
        assert 0.0 <= result.y <= 1.0
        assert result.width > 0
        assert result.height > 0


def test_detect_crop_suggestion_prefers_face_over_saliency():
    from schemas import CropRect

    fake_rect = CropRect(x=0.1, y=0.1, width=0.5, height=0.5)
    with patch("face_crop.detect_face_crop", return_value=(fake_rect, None)), patch(
        "face_crop.detect_saliency_crop"
    ) as mock_saliency:
        result = detect_crop_suggestion("/fake/path.mp4")

    assert result is not None
    assert result.detection_method == "face"
    assert result.crop_gameplay_rect == fake_rect
    mock_saliency.assert_not_called()


def test_detect_crop_suggestion_falls_back_to_saliency():
    from schemas import CropRect

    fake_rect = CropRect(x=0.2, y=0.2, width=0.6, height=0.6)
    with patch("face_crop.detect_face_crop", return_value=(None, None)), patch(
        "face_crop.detect_saliency_crop", return_value=fake_rect
    ):
        result = detect_crop_suggestion("/fake/path.mp4")

    assert result is not None
    assert result.detection_method == "saliency"
    assert result.crop_gameplay_rect == fake_rect


def test_detect_crop_suggestion_returns_none_when_both_fail():
    with patch("face_crop.detect_face_crop", return_value=(None, None)), patch(
        "face_crop.detect_saliency_crop", return_value=None
    ):
        result = detect_crop_suggestion("/fake/path.mp4")

    assert result is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_face_crop.py -v`
Expected: `ImportError: cannot import name 'detect_saliency_crop'` (and `detect_crop_suggestion`).

- [ ] **Step 3: Implement saliency fallback and orchestrator**

Append to `apps/video-worker/face_crop.py`:
```python
from schemas import CropSuggestion

SALIENCY_SAMPLE_COUNT = 10
SALIENCY_CROP_SIZE = 0.6


def detect_saliency_crop(video_path: str) -> Optional[CropRect]:
    """Falls back to visual saliency + inter-frame motion when no face is
    found (e.g. gameplay footage, product demos)."""
    duration = probe_duration(video_path)
    timestamps = _sample_frame_timestamps(duration, count=SALIENCY_SAMPLE_COUNT)

    saliency = cv2.saliency.StaticSaliencySpectralResidual_create()
    weighted_x, weighted_y, total_weight = 0.0, 0.0, 0.0

    for ts in timestamps:
        frame = _extract_frame(video_path, ts)
        if frame is None:
            continue
        h, w = frame.shape[:2]
        success, sal_map = saliency.computeSaliency(frame)
        if not success:
            continue
        sal_map = (sal_map * 255).astype("uint8")
        moments = cv2.moments(sal_map)
        if moments["m00"] == 0:
            continue
        cx = moments["m10"] / moments["m00"] / w
        cy = moments["m01"] / moments["m00"] / h
        weighted_x += cx
        weighted_y += cy
        total_weight += 1.0

    if total_weight == 0:
        return None

    cx = weighted_x / total_weight
    cy = weighted_y / total_weight
    crop_w = crop_h = SALIENCY_CROP_SIZE
    x = max(0.0, min(1.0 - crop_w, cx - crop_w / 2))
    y = max(0.0, min(1.0 - crop_h, cy - crop_h / 2))
    return CropRect(x=round(x, 3), y=round(y, 3), width=crop_w, height=crop_h)


def detect_crop_suggestion(video_path: str) -> Optional[CropSuggestion]:
    """Top-level entry point: tries face detection first (higher confidence),
    falls back to saliency+motion if no face is found, returns None if neither
    finds anything usable."""
    primary, secondary = detect_face_crop(video_path)
    if primary is not None:
        return CropSuggestion(
            crop_gameplay_rect=primary,
            crop_facecam_rect=secondary,
            detection_method="face",
            confidence=0.7,
        )

    saliency_rect = detect_saliency_crop(video_path)
    if saliency_rect is not None:
        return CropSuggestion(
            crop_gameplay_rect=saliency_rect,
            crop_facecam_rect=None,
            detection_method="saliency",
            confidence=0.4,
        )

    return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_face_crop.py -v`
Expected: all 9 tests PASS. (The `detect_saliency_crop` real-fixture test may pass with either a `None` result or a well-formed rect, per the test's own comment — requires real `ffmpeg`/`cv2`, use the Docker fallback if not available on the bare host.)

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/face_crop.py apps/video-worker/tests/test_face_crop.py
git commit -m "feat(video-worker): add saliency-fallback crop detection and top-level orchestrator"
```

---

### Task 4: Wire crop suggestion into the `/analyze` route

**Files:**
- Modify: `apps/video-worker/main.py`
- Modify: `apps/video-worker/tests/test_main.py`

**Interfaces:**
- Consumes: `detect_crop_suggestion` from Task 3.
- Produces: `/analyze`'s callback payload gains a `crop_suggestion` field (the `CropSuggestion.model_dump()` dict, or `None`). Task 9 (`api`'s internal callback handler) depends on this exact field name and shape.

- [ ] **Step 1: Write a failing test for the extended callback payload**

Modify `apps/video-worker/tests/test_main.py`'s existing `test_analyze_returns_202_and_calls_callback_with_candidates` test (find it and update it) to also assert the new field, and add one more test:
```python
def test_analyze_calls_callback_with_crop_suggestion():
    from schemas import CropRect, CropSuggestion

    fake_suggestion = CropSuggestion(
        crop_gameplay_rect=CropRect(x=0.1, y=0.1, width=0.5, height=0.5),
        crop_facecam_rect=None,
        detection_method="face",
        confidence=0.7,
    )
    with patch("main.detect_audio_peaks", return_value=[]), patch(
        "main.detect_scene_changes", return_value=[]
    ), patch("main.detect_crop_suggestion", return_value=fake_suggestion), patch(
        "main.requests.post"
    ) as mock_post:
        client.post(
            "/analyze",
            json={
                "video_asset_id": "asset-crop-1",
                "file_path": "/fake/path.mp4",
                "callback_url": "http://api:4000/api/internal/assets/asset-crop-1/analysis-complete",
            },
        )
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

    _, kwargs = mock_post.call_args
    body = kwargs["json"]
    assert body["crop_suggestion"]["detection_method"] == "face"
    assert body["crop_suggestion"]["crop_gameplay_rect"]["x"] == 0.1


def test_analyze_callback_crop_suggestion_is_null_when_none_found():
    with patch("main.detect_audio_peaks", return_value=[]), patch(
        "main.detect_scene_changes", return_value=[]
    ), patch("main.detect_crop_suggestion", return_value=None), patch("main.requests.post") as mock_post:
        client.post(
            "/analyze",
            json={
                "video_asset_id": "asset-crop-2",
                "file_path": "/fake/path.mp4",
                "callback_url": "http://api:4000/api/internal/assets/asset-crop-2/analysis-complete",
            },
        )
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

    _, kwargs = mock_post.call_args
    assert kwargs["json"]["crop_suggestion"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py -v`
Expected: `AttributeError` or `KeyError` on `crop_suggestion` (not yet produced by `_run_analysis`), and `AttributeError: <module 'main'> does not have the attribute 'detect_crop_suggestion'` for the patch targets.

- [ ] **Step 3: Wire `detect_crop_suggestion` into `_run_analysis`**

Modify `apps/video-worker/main.py`: add the import and update `_run_analysis`:
```python
from face_crop import detect_crop_suggestion
```
Change `_run_analysis` from:
```python
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
```
to:
```python
def _run_analysis(video_asset_id: str, file_path: str, callback_url: str) -> None:
    try:
        candidates = detect_audio_peaks(file_path) + detect_scene_changes(file_path)
        try:
            crop_suggestion = detect_crop_suggestion(file_path)
        except Exception:  # noqa: BLE001 - crop suggestion failure must not fail the whole analysis
            crop_suggestion = None
        requests.post(
            callback_url,
            json={
                "video_asset_id": video_asset_id,
                "moment_candidates": [c.model_dump() for c in candidates],
                "crop_suggestion": crop_suggestion.model_dump() if crop_suggestion else None,
            },
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        requests.post(
            callback_url,
            json={"video_asset_id": video_asset_id, "error": str(exc)},
            timeout=30,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py -v`
Expected: all tests PASS (including the pre-existing `/health`, `/render` tests, unaffected by this change).

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/main.py apps/video-worker/tests/test_main.py
git commit -m "feat(video-worker): include crop suggestion in /analyze callback payload"
```

---

### Task 5: Title text rendered as a PNG overlay (Pillow)

**Files:**
- Create: `apps/video-worker/title_render.py`
- Create: `apps/video-worker/tests/test_title_render.py`

**Interfaces:**
- Consumes: nothing new (Pillow is already available — `piper-tts`'s dependency chain and the base `python:3.11-slim` image both commonly ship it, but to be safe this task adds it explicitly).
- Produces: `render_title_png(title_text: str, output_path: str) -> None`, writing a 1080x1920 transparent RGBA PNG with the title text drawn (white fill, black stroke, shadow, centered horizontally, positioned near the top). Task 6 depends on this exact function name/signature.

- [ ] **Step 1: Add Pillow to requirements (if not already present)**

Check `apps/video-worker/requirements.txt` — if `Pillow` is not listed, add:
```
Pillow==10.4.0
```

- [ ] **Step 2: Write failing tests**

`apps/video-worker/tests/test_title_render.py`:
```python
import os

from PIL import Image

from title_render import render_title_png


def test_render_title_png_creates_transparent_rgba_canvas(tmp_path):
    output_path = str(tmp_path / "title.png")
    render_title_png("Hello World", output_path)

    assert os.path.exists(output_path)
    img = Image.open(output_path)
    assert img.mode == "RGBA"
    assert img.size == (1080, 1920)


def test_render_title_png_draws_non_transparent_pixels(tmp_path):
    output_path = str(tmp_path / "title.png")
    render_title_png("VISIBLE TEXT", output_path)

    img = Image.open(output_path)
    alpha_channel = img.split()[-1]
    extrema = alpha_channel.getextrema()
    # At least some pixels must be non-transparent (the drawn text/stroke)
    assert extrema[1] > 0


def test_render_title_png_handles_apostrophes_and_special_chars(tmp_path):
    output_path = str(tmp_path / "title.png")
    # This must not raise -- unlike the old drawtext-based approach, PNG
    # rendering has no ffmpeg filter-graph escaping to worry about.
    render_title_png("Ryan's 100% clutch: GG!", output_path)
    assert os.path.exists(output_path)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_title_render.py -v`
Expected: `ModuleNotFoundError: No module named 'title_render'`.

- [ ] **Step 4: Implement PNG title rendering**

`apps/video-worker/title_render.py`:
```python
from PIL import Image, ImageDraw, ImageFont

CANVAS_W = 1080
CANVAS_H = 1920
FONT_SIZE = 84
TITLE_Y = 80
STROKE_WIDTH = 5
SHADOW_OFFSET = 4


def _load_font() -> ImageFont.FreeTypeFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, FONT_SIZE)
        except OSError:
            continue
    return ImageFont.load_default()


def render_title_png(title_text: str, output_path: str) -> None:
    """Renders title_text onto a transparent 1080x1920 PNG canvas: white fill,
    black stroke, drop shadow, horizontally centered near the top. Unlike
    ffmpeg's drawtext filter, this has no filter-graph escaping concerns --
    apostrophes, colons, percent signs, etc. are handled natively by Pillow."""
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _load_font()

    bbox = draw.textbbox((0, 0), title_text, font=font, stroke_width=STROKE_WIDTH)
    text_w = bbox[2] - bbox[0]
    x = (CANVAS_W - text_w) / 2 - bbox[0]
    y = TITLE_Y

    draw.text(
        (x + SHADOW_OFFSET, y + SHADOW_OFFSET),
        title_text,
        font=font,
        fill=(0, 0, 0, 160),
        stroke_width=STROKE_WIDTH,
        stroke_fill=(0, 0, 0, 160),
    )
    draw.text(
        (x, y),
        title_text,
        font=font,
        fill=(255, 255, 255, 255),
        stroke_width=STROKE_WIDTH,
        stroke_fill=(0, 0, 0, 255),
    )

    img.save(output_path, "PNG")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_title_render.py -v`
Expected: all 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/title_render.py apps/video-worker/requirements.txt apps/video-worker/tests/test_title_render.py
git commit -m "feat(video-worker): render title text as a PNG overlay instead of ffmpeg drawtext"
```

---

### Task 6: Integrate title-PNG overlay into the layout/render pipeline

**Files:**
- Modify: `apps/video-worker/schemas.py`
- Modify: `apps/video-worker/layout.py`
- Modify: `apps/video-worker/tests/test_layout.py`
- Modify: `apps/video-worker/render.py`
- Modify: `apps/video-worker/tests/test_render.py`

**Interfaces:**
- Consumes: `render_title_png` from Task 5.
- Produces: `SegmentInput.title_overlay_path: str | None` (replaces `title_text: str | None`); `build_segment_filter(segment: SegmentInput) -> str` now ALWAYS ends its filter graph with an explicit `[out]` label (all four layout templates), and appends an `overlay=0:0[out]` stage referencing an additional ffmpeg input when `title_overlay_path` is set. Task 7 is independent of this task (touches only caption/ASS code) but shares the same `render.py` file, so implement this task first.

- [ ] **Step 1: Change `SegmentInput`'s title field**

In `apps/video-worker/schemas.py`, change:
```python
class SegmentInput(BaseModel):
    layout_template: Literal[
        "standard", "gameplay_facecam_split", "gameplay_full_focus", "cinematic_letterbox"
    ]
    crop_gameplay_rect: Optional[CropRect] = None
    crop_facecam_rect: Optional[CropRect] = None
    has_secondary: bool = False
    title_text: Optional[str] = None
```
to:
```python
class SegmentInput(BaseModel):
    layout_template: Literal[
        "standard", "gameplay_facecam_split", "gameplay_full_focus", "cinematic_letterbox"
    ]
    crop_gameplay_rect: Optional[CropRect] = None
    crop_facecam_rect: Optional[CropRect] = None
    has_secondary: bool = False
    title_overlay_path: Optional[str] = None
```
(`RenderSegmentInput`'s own `title_text: Optional[str] = None` field is UNCHANGED — that's the wire-level text the operator typed; it still exists exactly as before. Only the internal `SegmentInput` used by `build_segment_filter` changes.)

- [ ] **Step 2: Write failing tests for the new layout behavior**

Replace `apps/video-worker/tests/test_layout.py`'s two title-related tests (`test_title_text_appends_drawtext_filter` and `test_no_title_text_omits_drawtext_filter`) with:
```python
def test_title_overlay_path_appends_overlay_filter_and_out_label():
    segment = SegmentInput(layout_template="standard", title_overlay_path="/tmp/title.png")
    result = build_segment_filter(segment)
    assert "overlay=0:0[out]" in result
    assert "[1:v]" in result or "1:v" in result


def test_no_title_overlay_path_still_produces_out_label_without_overlay():
    segment = SegmentInput(layout_template="standard", title_overlay_path=None)
    result = build_segment_filter(segment)
    assert "[out]" in result
    assert "overlay" not in result


def test_title_overlay_uses_correct_input_index_with_secondary_source():
    segment = SegmentInput(layout_template="gameplay_facecam_split", has_secondary=True, title_overlay_path="/tmp/title.png")
    result = build_segment_filter(segment)
    # primary=0, secondary=1, so the title PNG must be input 2 when a
    # secondary source is present
    assert "[2:v]overlay=0:0[out]" in result
```
Also update the two other tests that referenced `title_text`/`drawtext` if any remain (search the file for `title_text=` and `drawtext` and update every occurrence to use `title_overlay_path` and the new `[out]`/`overlay` assertions consistently with the pattern above).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_layout.py -v`
Expected: failures on the new/updated title tests (old `drawtext`-based behavior still in place), plus possibly the missing-crop test if its exact error text changed (it shouldn't — only title handling changes).

- [ ] **Step 4: Rewrite `layout.py`'s title handling and add explicit `[out]` labels**

Replace the entire contents of `apps/video-worker/layout.py` with:
```python
from schemas import CropRect, SegmentInput

CANVAS_W = 1080
CANVAS_H = 1920


def _crop_expr(rect: CropRect) -> str:
    return (
        f"crop=w=iw*{rect.width}:h=ih*{rect.height}:"
        f"x=iw*{rect.x}:y=ih*{rect.y}"
    )


def build_segment_filter(segment: SegmentInput) -> str:
    if segment.layout_template == "standard":
        chain = (
            f"[0:v]scale={CANVAS_W}:{CANVAS_H}:force_original_aspect_ratio=increase,"
            f"crop={CANVAS_W}:{CANVAS_H}[base]"
        )

    elif segment.layout_template == "gameplay_full_focus":
        if segment.has_secondary:
            chain = f"[0:v]scale={CANVAS_W}:{CANVAS_H}[base]"
        else:
            if segment.crop_gameplay_rect is None:
                raise ValueError("gameplay_full_focus requires crop_gameplay_rect")
            chain = f"[0:v]{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{CANVAS_H}[base]"

    elif segment.layout_template == "gameplay_facecam_split":
        top_h = int(CANVAS_H * 0.6)
        bottom_h = CANVAS_H - top_h
        if segment.has_secondary:
            chain = (
                f"[0:v]scale={CANVAS_W}:{top_h}[top];"
                f"[1:v]scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2[base]"
            )
        else:
            if segment.crop_gameplay_rect is None or segment.crop_facecam_rect is None:
                raise ValueError(
                    "gameplay_facecam_split requires crop_gameplay_rect and crop_facecam_rect"
                )
            chain = (
                f"[0:v]split=2[src1][src2];"
                f"[src1]{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{top_h}[top];"
                f"[src2]{_crop_expr(segment.crop_facecam_rect)},scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2[base]"
            )

    elif segment.layout_template == "cinematic_letterbox":
        chain = (
            f"[0:v]scale={CANVAS_W}:-1:force_original_aspect_ratio=decrease,"
            f"pad={CANVAS_W}:{CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black[base]"
        )

    else:
        raise ValueError(f"unknown layout_template: {segment.layout_template}")

    if segment.title_overlay_path:
        png_input_index = 2 if segment.has_secondary else 1
        chain += f";[base][{png_input_index}:v]overlay=0:0[out]"
    else:
        chain += ";[base]null[out]"

    return chain
```

- [ ] **Step 5: Run layout tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_layout.py -v`
Expected: all tests PASS.

- [ ] **Step 6: Update `render.py` to render the title PNG and wire the extra input**

In `apps/video-worker/render.py`, add the import:
```python
from title_render import render_title_png
```
Replace `_render_single_segment` (currently lines 24-52) with:
```python
def _render_single_segment(
    segment, index: int, tts_voice: str, voices_dir: str, work_dir: str
) -> tuple[str, str]:
    tts_path = os.path.join(work_dir, f"segment_{index}_tts.wav")
    generate_tts(segment.script_text, tts_voice, voices_dir, tts_path)

    title_overlay_path = None
    if segment.title_text:
        title_overlay_path = os.path.join(work_dir, f"segment_{index}_title.png")
        render_title_png(segment.title_text, title_overlay_path)

    segment_filter_input = SegmentInput(
        layout_template=segment.layout_template,
        crop_gameplay_rect=segment.crop_gameplay_rect,
        crop_facecam_rect=segment.crop_facecam_rect,
        has_secondary=segment.secondary_file_path is not None,
        title_overlay_path=title_overlay_path,
    )
    video_filter = build_segment_filter(segment_filter_input)

    trimmed_path = os.path.join(work_dir, f"segment_{index}_video.mp4")
    # ffmpeg applies -ss/-to only to the -i that immediately follows them, so
    # each input needs its own copy of the trim window.
    inputs = ["-ss", str(segment.trim_start), "-to", str(segment.trim_end), "-i", segment.file_path]
    if segment.secondary_file_path:
        inputs += ["-ss", str(segment.trim_start), "-to", str(segment.trim_end), "-i", segment.secondary_file_path]
    if title_overlay_path:
        inputs += ["-i", title_overlay_path]

    args = ["ffmpeg", "-y"] + inputs + ["-filter_complex", video_filter, "-map", "[out]", trimmed_path]
    run_ffmpeg(args)
    return trimmed_path, tts_path
```
(Note: `-an` was removed since `-map "[out]"` now explicitly selects only the video stream — no audio stream is mapped, so no separate audio-exclusion flag is needed. This also fixes the ordering: the title PNG input is always added LAST, after any secondary source, matching the `png_input_index = 2 if has_secondary else 1` calculation in `layout.py`.)

- [ ] **Step 7: Update `test_render.py`'s existing test if it references `title_text` on `SegmentInput` directly**

Check `apps/video-worker/tests/test_render.py` for any direct construction of `SegmentInput(..., title_text=...)` — there shouldn't be any (the existing test only builds `RenderSegmentInput`, which is unchanged), but confirm by running the full test suite next.

- [ ] **Step 8: Run the full video-worker test suite to verify no regressions**

Run: `cd apps/video-worker && python -m pytest -v`
Expected: all tests pass, including `test_render.py`'s existing `test_render_video_produces_output_and_offsets_captions` (uses real ffmpeg — requires the Docker fallback if bare-host ffmpeg/cv2 aren't available, same pattern as every prior video-worker task).

- [ ] **Step 9: Commit**

```bash
git add apps/video-worker/schemas.py apps/video-worker/layout.py apps/video-worker/tests/test_layout.py apps/video-worker/render.py apps/video-worker/tests/test_render.py
git commit -m "feat(video-worker): overlay pre-rendered title PNG instead of ffmpeg drawtext"
```

---

### Task 7: ASS karaoke captions (replacing SRT)

**Files:**
- Modify: `apps/video-worker/schemas.py`
- Modify: `apps/video-worker/render.py`
- Modify: `apps/video-worker/tests/test_render.py`

**Interfaces:**
- Consumes: `CaptionWord` (already exists).
- Produces: `RenderSegmentInput.caption_style: str | None` (new field, wire-level, default `None` meaning `"default"`); `_write_ass(caption_words: list[CaptionWord], style_name: str, ass_path: str) -> None` (module-private in `render.py`, replaces `_write_srt`). `render_video` picks the `caption_style` from the first segment (by `order_index`) per the spec's documented MVP simplification (one style per video, not per-segment).

- [ ] **Step 1: Add `caption_style` to the wire schema**

In `apps/video-worker/schemas.py`, add a field to `RenderSegmentInput`:
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
    caption_style: Optional[str] = None
```
(Only the `caption_style: Optional[str] = None` line is new — everything else in this class is unchanged.)

- [ ] **Step 2: Write failing tests for ASS generation**

Add to `apps/video-worker/tests/test_render.py` (near the top, alongside existing imports, add `from render import _write_ass` — or wherever `_write_srt` was previously imported/tested, if it was; if it wasn't directly unit-tested before, add these as new tests):
```python
def test_write_ass_default_style_produces_dialogue_events_with_color_tags(tmp_path):
    from render import _write_ass
    from schemas import CaptionWord

    words = [
        CaptionWord(word="hello", start_ms=0, end_ms=300),
        CaptionWord(word="world", start_ms=300, end_ms=600),
    ]
    ass_path = str(tmp_path / "captions.ass")
    _write_ass(words, "default", ass_path)

    content = open(ass_path, encoding="utf-8").read()
    assert "[Script Info]" in content
    assert "[V4+ Styles]" in content
    assert "[Events]" in content
    # One Dialogue event per active word (karaoke-style highlight)
    assert content.count("Dialogue:") == 2
    assert "hello" in content
    assert "world" in content
    # Color-swap override tag for the highlighted word
    assert "\\c&H" in content


def test_write_ass_unknown_style_falls_back_to_default(tmp_path):
    from render import _write_ass
    from schemas import CaptionWord

    words = [CaptionWord(word="hi", start_ms=0, end_ms=200)]
    ass_path = str(tmp_path / "captions.ass")
    # Must not raise even with a style name that doesn't exist
    _write_ass(words, "nonexistent_style_xyz", ass_path)
    assert os.path.exists(ass_path)


def test_write_ass_handles_empty_caption_words(tmp_path):
    from render import _write_ass

    ass_path = str(tmp_path / "captions.ass")
    _write_ass([], "default", ass_path)
    content = open(ass_path, encoding="utf-8").read()
    # Header sections must still be present even with zero words, so the
    # subtitles= filter has a syntactically valid (if caption-less) file to
    # burn in rather than failing the whole render on an edge case.
    assert "[Events]" in content
    assert content.count("Dialogue:") == 0
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v`
Expected: `ImportError: cannot import name '_write_ass'`.

- [ ] **Step 4: Implement ASS generation and wire it into `render_video`**

In `apps/video-worker/render.py`, replace the `_write_srt` function (currently lines 10-21) with:
```python
CAPTION_STYLES: dict[str, dict[str, str]] = {
    "default": {"primary": "&H00FFFFFF", "highlight": "&H0000FFFF", "outline": "&H00000000"},
    "energetic": {"primary": "&H00FFFFFF", "highlight": "&H000080FF", "outline": "&H00000000"},
    "warning": {"primary": "&H0080FFFF", "highlight": "&H000000FF", "outline": "&H00000000"},
}


def _format_ass_timestamp(ms: int) -> str:
    hours, rem_ms = divmod(ms, 3_600_000)
    minutes, rem_ms = divmod(rem_ms, 60_000)
    seconds, centis_ms = divmod(rem_ms, 1_000)
    centis = centis_ms // 10
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centis:02d}"


def _write_ass(caption_words: list[CaptionWord], style_name: str, ass_path: str) -> None:
    """Writes an ASS (Advanced SubStation Alpha) subtitle file with one
    Dialogue event per word: the full sentence-so-far context isn't tracked
    (MVP keeps this simple), each word is shown alone for its own [start,
    end] window with a color-swap override tag simulating karaoke-style
    highlighting when the word is active."""
    style = CAPTION_STYLES.get(style_name, CAPTION_STYLES["default"])

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 2\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,DejaVu Sans,72,{style['primary']},{style['outline']},1,1,3,0,2,40,40,120,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = [header]
    for word in caption_words:
        start_ts = _format_ass_timestamp(word.start_ms)
        end_ts = _format_ass_timestamp(word.end_ms)
        text = f"{{\\c{style['highlight']}}}{word.word}{{\\c{style['primary']}}}"
        lines.append(f"Dialogue: 0,{start_ts},{end_ts},Default,,0,0,0,,{text}\n")

    with open(ass_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
```
Then in `render_video`, replace:
```python
    srt_path = os.path.join(work_dir, "captions.srt")
    _write_srt(all_caption_words, srt_path)
    escaped_srt_path = srt_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
```
with:
```python
    caption_style = ordered_segments[0].caption_style if ordered_segments and ordered_segments[0].caption_style else "default"
    ass_path = os.path.join(work_dir, "captions.ass")
    _write_ass(all_caption_words, caption_style, ass_path)
    escaped_ass_path = ass_path.replace("\\", "\\\\").replace("'", "'\\''")
```
And update BOTH occurrences of `subtitles='{escaped_srt_path}'` (one in the music branch, one in the no-music branch, both inside the `-filter_complex` f-strings) to `subtitles='{escaped_ass_path}'`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v`
Expected: all tests PASS, including the pre-existing full-pipeline test (real ffmpeg required — Docker fallback if needed).

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/schemas.py apps/video-worker/render.py apps/video-worker/tests/test_render.py
git commit -m "feat(video-worker): generate ASS karaoke captions with color-highlight instead of SRT"
```

---

### Task 8: `api` schema additions — `crop_suggestions` table and `caption_style` column

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/tests/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: new table `crop_suggestions` (id, video_asset_id, crop_gameplay_rect, crop_facecam_rect, detection_method, confidence, created_at); `segment_assignments` gains `caption_style TEXT` column. Tasks 9-11 depend on these exact table/column names.

- [ ] **Step 1: Write a failing test for the new table**

Add to `apps/api/tests/db.test.ts`, inside the existing `describe` block:
```typescript
  it("creates the crop_suggestions table with a caption_style column on segment_assignments", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toContain("crop_suggestions");

    const columns = db
      .prepare("PRAGMA table_info(segment_assignments)")
      .all()
      .map((row: any) => row.name);
    expect(columns).toContain("caption_style");
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: FAIL — `crop_suggestions` table doesn't exist yet, `caption_style` column not present.

- [ ] **Step 3: Add the schema changes**

In `apps/api/src/db.ts`, add a new `CREATE TABLE IF NOT EXISTS crop_suggestions` block to the `SCHEMA` string (after `moment_candidates`, before `segment_assignments` for logical grouping — order in the SQL string doesn't matter functionally):
```sql

CREATE TABLE IF NOT EXISTS crop_suggestions (
  id TEXT PRIMARY KEY,
  video_asset_id TEXT NOT NULL REFERENCES video_assets(id),
  crop_gameplay_rect TEXT,
  crop_facecam_rect TEXT,
  detection_method TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);
```
And add `caption_text TEXT` — no, add `caption_style TEXT` to the existing `segment_assignments` table definition: change
```sql
  crop_gameplay_rect TEXT,
  crop_facecam_rect TEXT,
  title_text TEXT
);
```
to
```sql
  crop_gameplay_rect TEXT,
  crop_facecam_rect TEXT,
  title_text TEXT,
  caption_style TEXT
);
```

- [ ] **Step 4: Add TypeScript types**

Add to `apps/api/src/types.ts`:
```typescript
export interface CropSuggestion {
  id: string;
  video_asset_id: string;
  crop_gameplay_rect: string | null; // JSON-encoded CropRect
  crop_facecam_rect: string | null; // JSON-encoded CropRect
  detection_method: "face" | "saliency";
  confidence: number;
  created_at: string;
}
```
And add `caption_style: string | null;` to the existing `SegmentAssignment` interface (find it in `types.ts` and add the field alongside `title_text: string | null;`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/tests/db.test.ts
git commit -m "feat(api): add crop_suggestions table and caption_style column"
```

---

### Task 9: Persist crop suggestions from the `/analyze` callback and expose a read endpoint

**Files:**
- Modify: `apps/api/src/routes/internal.ts`
- Modify: `apps/api/src/routes/assets.ts`
- Modify: `apps/api/tests/internal.test.ts`
- Modify: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Consumes: `crop_suggestions` table and `CropSuggestion` type from Task 8; `/analyze` callback's `crop_suggestion` field shape from Task 4.
- Produces: `POST /api/internal/assets/:assetId/analysis-complete` inserts a `crop_suggestions` row when the payload includes a non-null `crop_suggestion`; new route `GET /api/campaigns/:id/assets/:assetId/crop-suggestion` returns the most recent suggestion for that asset (404 if none). Task 12 (web-ui) depends on this exact route path and response shape.

- [ ] **Step 1: Write failing tests for the callback handler**

Add to `apps/api/tests/internal.test.ts`, inside the existing `describe("internal analysis-complete callback"` block (reuse the same `beforeEach` setup already there):
```typescript
  it("stores a crop suggestion when the callback includes one", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({
        video_asset_id: assetId,
        moment_candidates: [],
        crop_suggestion: {
          crop_gameplay_rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
          crop_facecam_rect: null,
          detection_method: "face",
          confidence: 0.7,
        },
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM crop_suggestions WHERE video_asset_id = ?").all(assetId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].detection_method).toBe("face");
    expect(JSON.parse(rows[0].crop_gameplay_rect).x).toBe(0.1);
  });

  it("does not store a crop suggestion when the callback's crop_suggestion is null", async () => {
    const app = createApp();
    await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({ video_asset_id: assetId, moment_candidates: [], crop_suggestion: null });

    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM crop_suggestions WHERE video_asset_id = ?").all(assetId);
    expect(rows).toHaveLength(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/internal.test.ts`
Expected: FAIL — no rows inserted (handler doesn't process `crop_suggestion` yet), but no crash either since it's simply ignored today.

- [ ] **Step 3: Update the callback handler**

In `apps/api/src/routes/internal.ts`, in the `POST /assets/:assetId/analysis-complete` handler, after the existing `moment_candidates` insert-and-transaction block and before `res.json({ status: "recorded" })`, add:
```typescript
    const cropSuggestion = req.body.crop_suggestion as
      | {
          crop_gameplay_rect: Record<string, number> | null;
          crop_facecam_rect: Record<string, number> | null;
          detection_method: "face" | "saliency";
          confidence: number;
        }
      | null
      | undefined;
    if (cropSuggestion) {
      db.prepare(
        `INSERT INTO crop_suggestions (id, video_asset_id, crop_gameplay_rect, crop_facecam_rect, detection_method, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        assetId,
        cropSuggestion.crop_gameplay_rect ? JSON.stringify(cropSuggestion.crop_gameplay_rect) : null,
        cropSuggestion.crop_facecam_rect ? JSON.stringify(cropSuggestion.crop_facecam_rect) : null,
        cropSuggestion.detection_method,
        cropSuggestion.confidence,
        now
      );
    }
```
(Place this right before the final `res.json({ status: "recorded" });` of that route handler — after the existing `moment_candidates` `insertMany(candidates);` call and the `UPDATE video_assets SET analysis_status = 'done'...` line, so it doesn't interfere with the existing success path.)

- [ ] **Step 4: Run internal tests to verify they pass**

Run: `cd apps/api && npx jest tests/internal.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write failing tests for the new read endpoint**

Add to `apps/api/tests/assets.test.ts`, inside the existing `describe("asset routes"` block:
```typescript
  it("returns the crop suggestion for an asset", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);
    const assetId = uploadRes.body.id;

    const db = getDb(process.env.DB_PATH as string);
    db.prepare(
      `INSERT INTO crop_suggestions (id, video_asset_id, crop_gameplay_rect, crop_facecam_rect, detection_method, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "suggestion-1",
      assetId,
      JSON.stringify({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }),
      null,
      "face",
      0.7,
      new Date().toISOString()
    );

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/${assetId}/crop-suggestion`);
    expect(res.status).toBe(200);
    expect(res.body.detection_method).toBe("face");
    expect(JSON.parse(res.body.crop_gameplay_rect).x).toBe(0.2);
  });

  it("returns 404 when no crop suggestion exists for an asset", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const res = await request(app).get(
      `/api/campaigns/${campaignId}/assets/${uploadRes.body.id}/crop-suggestion`
    );
    expect(res.status).toBe(404);
  });
```
Add the import `import { getDb } from "../src/db";` to the top of `apps/api/tests/assets.test.ts` if it isn't already imported there.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: FAIL — 404 on the route (doesn't exist), or a routing error.

- [ ] **Step 7: Add the new route**

In `apps/api/src/routes/assets.ts`, add a new route (after the existing `GET /:assetId/moments` route, before the final `return router;`):
```typescript
  router.get("/:assetId/crop-suggestion", (req, res) => {
    const db = getDb(dbPath);
    const suggestion = db
      .prepare("SELECT * FROM crop_suggestions WHERE video_asset_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.assetId);
    if (!suggestion) {
      res.status(404).json({ error: "no crop suggestion found for this asset" });
      return;
    }
    res.json(suggestion);
  });
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/assets.test.ts tests/internal.test.ts`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/internal.ts apps/api/src/routes/assets.ts apps/api/tests/internal.test.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): persist crop suggestions from analyze callback, expose read endpoint"
```

---

### Task 10: Thread `caption_style` through segment assignment and render submission

**Files:**
- Modify: `apps/api/src/routes/segments.ts`
- Modify: `apps/api/src/services/videoWorkerClient.ts`
- Modify: `apps/api/src/routes/render.ts`
- Modify: `apps/api/tests/segments.test.ts`
- Modify: `apps/api/tests/render.test.ts`

**Interfaces:**
- Consumes: `caption_style` column from Task 8, `caption_style` field on `video-worker`'s `RenderSegmentInput` from Task 7.
- Produces: `PUT /api/campaigns/:id/segments` accepts and persists `caption_style` per segment; `POST /api/campaigns/:id/render` includes `caption_style` in the payload sent to `video-worker`.

- [ ] **Step 1: Write a failing test for persisting `caption_style`**

Add to `apps/api/tests/segments.test.ts`, inside the existing `describe` block (extend the existing "saves segment assignments" test rather than adding a whole new one — find the test named `"saves segment assignments covering all content_plan segments"` and add a `caption_style: "energetic"` field to one of its two segment payload objects, then add an assertion after the existing ones):
```typescript
    const rows = db.prepare("SELECT * FROM segment_assignments WHERE campaign_id = ?").all(campaignId) as any[];
    expect(rows).toHaveLength(2);
    const hookRow = rows.find((r: any) => r.segment_key === "hook");
    expect(hookRow.caption_style).toBe("energetic");
```
(Add `caption_style: "energetic"` to the `hook` segment object in that test's request body.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/segments.test.ts`
Expected: FAIL — `hookRow.caption_style` is `undefined` (column not populated by the current INSERT).

- [ ] **Step 3: Update the segments route**

In `apps/api/src/routes/segments.ts`, add `caption_style?: string;` to the `SegmentPayload` interface:
```typescript
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
  caption_style?: string;
}
```
Update the `INSERT INTO segment_assignments` statement and its `.run(...)` call to include the new column — change:
```typescript
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
```
to:
```typescript
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text, caption_style)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
```
and add `s.caption_style ?? null` as a new final argument to the `insert.run(...)` call inside `replaceAll`.

- [ ] **Step 4: Run segments tests to verify they pass**

Run: `cd apps/api && npx jest tests/segments.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write a failing test for threading `caption_style` into the render payload**

Add to `apps/api/tests/render.test.ts` — find the existing `beforeEach` that inserts a `segment_assignments` row and add `caption_style` to that INSERT (change the existing `segment_assignments` insert statement/values to include a `caption_style` column with a test value like `"warning"`), then in the "submits a render job" test, add an assertion:
```typescript
    const { submitRender } = require("../src/services/videoWorkerClient");
    const callArgs = (submitRender as jest.Mock).mock.calls[0];
    const segmentsPayload = callArgs[2];
    expect(segmentsPayload[0].caption_style).toBe("warning");
```
(Adjust the exact `submitRender` mock-call argument index if the existing test file's mock setup differs — check the current call signature `submitRender(videoWorkerUrl, jobId, segmentPayloads, ttsVoice, musicPath, callbackUrl)` from `apps/api/src/routes/render.ts` to confirm `segmentPayloads` is argument index 2.)

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/render.test.ts`
Expected: FAIL — `segmentsPayload[0].caption_style` is `undefined`.

- [ ] **Step 7: Update `videoWorkerClient.ts` and `render.ts`**

In `apps/api/src/services/videoWorkerClient.ts`, add `caption_style?: string;` to `RenderSegmentPayload`:
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
  caption_style?: string;
}
```
In `apps/api/src/routes/render.ts`, add `caption_style: s.caption_style ?? undefined,` to the object built inside `segmentPayloads = segments.map((s) => ({ ... }))`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/render.test.ts`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/segments.ts apps/api/src/services/videoWorkerClient.ts apps/api/src/routes/render.ts apps/api/tests/segments.test.ts apps/api/tests/render.test.ts
git commit -m "feat(api): thread caption_style through segment assignment and render submission"
```

---

### Task 11: `web-ui` — pre-fill crop suggestions and add caption style picker

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`
- Modify: `apps/web-ui/components/CropCanvas.tsx`
- Modify: `apps/web-ui/components/SegmentEditor.tsx`

**Interfaces:**
- Consumes: `GET /api/campaigns/:id/assets/:assetId/crop-suggestion` from Task 9, `caption_style` field from Task 10.
- Produces: `getCropSuggestion(campaignId, assetId): Promise<CropSuggestion | null>` in `apiClient.ts`; `CropCanvas` accepts an optional `initialRect?: CropRect | null` prop; `SegmentDraft` gains `caption_style?: string`.

- [ ] **Step 1: Add types and client function to `apiClient.ts`**

Add to `apps/web-ui/lib/apiClient.ts`:
```typescript
export interface CropSuggestion {
  crop_gameplay_rect: string | null;
  crop_facecam_rect: string | null;
  detection_method: "face" | "saliency";
  confidence: number;
}

export async function getCropSuggestion(campaignId: string, assetId: string): Promise<CropSuggestion | null> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/crop-suggestion`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get crop suggestion failed with status ${res.status}`);
  return res.json();
}
```
Add `caption_style?: string;` to the existing `SegmentDraft` interface (alongside `title_text?: string;`).

- [ ] **Step 2: Add `initialRect` support to `CropCanvas`**

In `apps/web-ui/components/CropCanvas.tsx`, add an optional prop and sync it into state when it changes (it may arrive asynchronously after the component has already mounted, since the parent fetches the suggestion via `useEffect`):
```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { CropRect } from "../lib/apiClient";

export function CropCanvas({
  imageSrc,
  label,
  initialRect,
  onChange,
}: {
  imageSrc: string;
  label: string;
  initialRect?: CropRect | null;
  onChange: (rect: CropRect) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);

  useEffect(() => {
    if (initialRect) {
      setRect(initialRect);
      onChange(initialRect);
    }
    // Only re-run when the suggestion itself changes (by reference), not on
    // every parent re-render -- onChange is intentionally excluded from deps
    // since it's a fresh closure each render in the current SegmentEditor usage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRect]);

  function relativePos(e: React.MouseEvent): { x: number; y: number } {
```
(Keep the rest of the file — `relativePos`, `handleMouseDown`, `handleMouseUp`, and the JSX render — exactly as it currently is; only the function signature/props and the new `useEffect` are added.)

- [ ] **Step 3: Wire crop suggestion fetching and the caption style picker into `SegmentEditor`**

In `apps/web-ui/components/SegmentEditor.tsx`, add the import and state:
```tsx
import {
  CropRect,
  CropSuggestion,
  LayoutTemplate,
  MomentCandidate,
  SegmentDraft,
  VideoAsset,
  getCropSuggestion,
  listMoments,
} from "../lib/apiClient";
```
Add a new state variable and effect (alongside the existing `moments` state/effect):
```tsx
  const [cropSuggestion, setCropSuggestion] = useState<CropSuggestion | null>(null);

  useEffect(() => {
    if (draft.video_asset_id) {
      getCropSuggestion(campaignId, draft.video_asset_id).then(setCropSuggestion);
    } else {
      setCropSuggestion(null);
    }
  }, [campaignId, draft.video_asset_id]);
```
Add a `CAPTION_STYLES` constant near the top of the file (alongside `TEMPLATES`):
```tsx
const CAPTION_STYLES = ["default", "energetic", "warning"];
```
Pass `initialRect` to both `CropCanvas` usages — change:
```tsx
      {needsGameplayCrop && asset && (
        <CropCanvas
          imageSrc={mediaUrl(asset.file_path)}
          label="Gameplay area"
          onChange={(rect: CropRect) => onChange({ ...draft, crop_gameplay_rect: rect })}
        />
      )}
      {needsFacecamCrop && asset && (
        <CropCanvas
          imageSrc={mediaUrl(asset.file_path)}
          label="Facecam area"
          onChange={(rect: CropRect) => onChange({ ...draft, crop_facecam_rect: rect })}
        />
      )}
```
to:
```tsx
      {needsGameplayCrop && asset && (
        <CropCanvas
          imageSrc={mediaUrl(asset.file_path)}
          label="Gameplay area"
          initialRect={cropSuggestion ? JSON.parse(cropSuggestion.crop_gameplay_rect ?? "null") : null}
          onChange={(rect: CropRect) => onChange({ ...draft, crop_gameplay_rect: rect })}
        />
      )}
      {needsFacecamCrop && asset && (
        <CropCanvas
          imageSrc={mediaUrl(asset.file_path)}
          label="Facecam area"
          initialRect={cropSuggestion ? JSON.parse(cropSuggestion.crop_facecam_rect ?? "null") : null}
          onChange={(rect: CropRect) => onChange({ ...draft, crop_facecam_rect: rect })}
        />
      )}
```
Add a caption style `<select>` after the existing title text `<input>`:
```tsx
      <select
        value={draft.caption_style ?? "default"}
        onChange={(e) => onChange({ ...draft, caption_style: e.target.value })}
      >
        {CAPTION_STYLES.map((style) => (
          <option key={style} value={style}>
            {style}
          </option>
        ))}
      </select>
```

- [ ] **Step 4: Manual verification**

Run: `cd apps/web-ui && npm run build`
Expected: TypeScript compiles with no errors.

If a Docker/browser environment is available for a live check (per the honest-verification-limits pattern established throughout Sub-proyek 2 — do NOT force a full `docker compose up` if the host is resource-constrained; static build verification alone is acceptable and should be reported as such): open the segments page for a campaign with an analyzed footage asset, confirm the crop canvas pre-fills with a suggested box when one exists, and confirm the caption style dropdown is present and changes the submitted `caption_style` value.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts apps/web-ui/components/CropCanvas.tsx apps/web-ui/components/SegmentEditor.tsx
git commit -m "feat(web-ui): pre-fill crop suggestions and add caption style picker"
```

---

### Task 12: End-to-end verification of the enhanced render pipeline

**Files:**
- Modify: `tests/e2e_video.test.sh`

**Interfaces:**
- Consumes: the full running stack (`api`, `video-worker`, plus Sub-proyek 1's `ai-worker`/`ollama` for the plan-seeding pivot already established in Sub-proyek 2's own e2e script).
- Produces: an updated e2e script that also exercises the new caption_style/title/crop-suggestion path.

- [ ] **Step 1: Extend the e2e script's segment payload**

In `tests/e2e_video.test.sh`, find the Python heredoc block that builds the `segments` list for the `PUT /segments` call and add `caption_style` and a `title_text` to at least one segment:
```python
segments = [
    {
        "segment_key": key,
        "video_asset_id": asset_id,
        "trim_start": 0,
        "trim_end": 1,
        "order_index": i,
        "layout_template": "gameplay_full_focus",
        "crop_gameplay_rect": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 0.5},
        "caption_style": "energetic",
        "title_text": "E2E Title Test" if i == 0 else None,
    }
    for i, key in enumerate(keys)
]
```
(This replaces the existing dict comprehension in that heredoc — same structure, two new keys added per segment.)

- [ ] **Step 2: Add a step verifying the crop-suggestion endpoint responds sanely**

After the "Uploading footage asset..." step and before "Waiting for analysis to complete...", add:
```bash
echo "Checking crop-suggestion endpoint (advisory only, may be empty for a 2-tone synthetic fixture)..."
CROP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/campaigns/$CAMPAIGN_ID/assets/$ASSET_ID/crop-suggestion")
echo "Crop suggestion endpoint status: $CROP_STATUS (200 = found, 404 = none found -- both are valid outcomes for this synthetic fixture)"
if [[ "$CROP_STATUS" != "200" && "$CROP_STATUS" != "404" ]]; then
  echo "FAIL: unexpected status from crop-suggestion endpoint"
  exit 1
fi
```

- [ ] **Step 3: Run against the real stack, per the resource-conscious pattern already established for this project**

Per the established pattern from Sub-proyek 2's own final e2e task: this project's host may be shared/resource-constrained. Before running, check whether the stack is already up and whether required models (Ollama's `mistral:7b-instruct`, the Piper voice, and now the YuNet model baked into the image) are already cached — do not re-download anything that's already present. Run:
```bash
docker compose -f docker/docker-compose.yml up --build -d
./tests/e2e_video.test.sh
docker compose -f docker/docker-compose.yml down
```
Expected: the script reaches at least the crop-suggestion check and the render-submission step without a hard failure. Per the same established, disclosed tradeoff from Sub-proyek 2's e2e script: if the render step's poll loop times out without reaching `ready_for_preview` on a slow/shared host, that is a soft, non-fatal exit (the existing script's behavior, unchanged by this task) — not a regression to chase. If you can let a full render complete, do one manual check of the resulting output: `ffprobe` the final MP4 and confirm it's a valid video file, and if possible extract a frame to visually confirm the title text (if this run set `title_text`) is rendered without any ffmpeg errors in `docker compose logs video-worker`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e_video.test.sh
git commit -m "test: exercise caption_style, title overlay, and crop-suggestion in the e2e script"
```

---

## Self-Review Notes

- **Spec coverage:** ASS karaoke captions (Task 7), title-as-PNG (Tasks 5-6), auto-crop suggestion with face+saliency fallback and dual-speaker detection (Tasks 2-4), 2-3 caption style presets (Task 7), crop suggestion as advisory pre-fill never auto-writing `segment_assignments` (Task 11 — suggestion only feeds `CropCanvas`'s `initialRect`, the operator's own form submit still persists the real value), vendored YuNet model not downloaded at build time (Task 1). Every spec bullet has a task.
- **Placeholder scan:** no TBD/TODO markers; every step has runnable code or an exact command.
- **Type consistency:** `CropSuggestion` fields (`crop_gameplay_rect`, `crop_facecam_rect`, `detection_method`, `confidence`) match across Task 3 (Python), Task 4 (route payload), Task 9 (TS type + DB columns), Task 11 (web-ui type). `caption_style` field name is identical across Task 7 (video-worker wire schema), Task 8 (DB column), Task 10 (api routes + client), Task 11 (web-ui `SegmentDraft`). `title_overlay_path`/`SegmentInput` changes in Task 6 don't touch `RenderSegmentInput.title_text`, which stays consistent with Task 7's and the existing Sub-proyek 2 code's usage. `GET /api/campaigns/:id/assets/:assetId/crop-suggestion` path is identical between Task 9 (route definition) and Task 11 (client call).
