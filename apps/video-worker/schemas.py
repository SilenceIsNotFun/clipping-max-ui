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


class CropSuggestion(BaseModel):
    crop_gameplay_rect: Optional[CropRect] = None
    crop_facecam_rect: Optional[CropRect] = None
    detection_method: Literal["face", "saliency"]
    confidence: float


class SegmentInput(BaseModel):
    layout_template: Literal[
        "standard", "gameplay_facecam_split", "gameplay_full_focus", "cinematic_letterbox"
    ]
    crop_gameplay_rect: Optional[CropRect] = None
    crop_facecam_rect: Optional[CropRect] = None
    has_secondary: bool = False
    title_overlay_path: Optional[str] = None


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


class RenderJobInput(BaseModel):
    segments: list[RenderSegmentInput]
    tts_voice: str
    voices_dir: str
    music_path: Optional[str] = None
    watermark_path: Optional[str] = None
    watermark_rect: Optional[CropRect] = None
    output_path: str


class RenderResult(BaseModel):
    output_path: str
    caption_words: list[CaptionWord]
