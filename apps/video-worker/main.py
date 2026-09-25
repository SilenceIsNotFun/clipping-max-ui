import os
import tempfile

import requests
from fastapi import BackgroundTasks, FastAPI

from face_crop import detect_crop_suggestion
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
