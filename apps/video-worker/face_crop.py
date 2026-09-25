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
