"""Pydantic request/response models for the video-worker service.

Populated by later tasks in the video-content-generation plan; left empty
here since Task 1 only scaffolds the service and ffmpeg primitives.
"""

from typing import Literal

from pydantic import BaseModel


class MomentCandidate(BaseModel):
    timestamp_ms: int
    score: float
    detection_type: Literal["audio_peak", "scene_change"]


class CaptionWord(BaseModel):
    word: str
    start_ms: int
    end_ms: int
