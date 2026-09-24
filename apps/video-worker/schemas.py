"""Pydantic request/response models for the video-worker service.

Populated by later tasks in the video-content-generation plan; left empty
here since Task 1 only scaffolds the service and ffmpeg primitives.
"""

from typing import Literal, Optional

from pydantic import BaseModel


class MomentCandidate(BaseModel):
    timestamp_ms: int
    score: float
    detection_type: Literal["audio_peak", "scene_change"]


class CaptionWord(BaseModel):
    word: str
    start_ms: int
    end_ms: int


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
