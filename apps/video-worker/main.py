import glob
import logging
import os
import tempfile
import time

import requests
from fastapi import BackgroundTasks, FastAPI

from face_crop import detect_crop_suggestion
from ffmpeg_utils import build_trim_args, probe_duration, run_ffmpeg
from hook_finder import find_hooks
from moment_detection import detect_audio_peaks, detect_scene_changes
from render import render_video
from schemas import RenderJobInput
from youtube_download import download_youtube_video

app = FastAPI(title="contentrewardfarm-video-worker")
logger = logging.getLogger("video-worker")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")


def _post_callback(callback_url: str, payload: dict) -> None:
    """POST a background-task result back to the api and make failures
    visible. A silently-rejected callback (e.g. api's body-size limit
    rejecting a large moment_candidates payload for a long video) previously
    left the caller stuck at "pending" forever with zero trace of why."""
    try:
        response = requests.post(callback_url, json=payload, timeout=30)
        response.raise_for_status()
    except Exception:  # noqa: BLE001 - log and move on; the caller has no way to retry this
        logger.exception("callback POST to %s failed (payload keys: %s)", callback_url, list(payload.keys()))


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
        _post_callback(
            callback_url,
            {
                "video_asset_id": video_asset_id,
                "moment_candidates": [c.model_dump() for c in candidates],
                "crop_suggestion": crop_suggestion.model_dump() if crop_suggestion else None,
            },
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        _post_callback(callback_url, {"video_asset_id": video_asset_id, "error": str(exc)})


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
            _post_callback(
                callback_url,
                {
                    "job_id": job_id,
                    "output_path": result.output_path,
                    "caption_words": [w.model_dump() for w in result.caption_words],
                },
            )
    except Exception as exc:  # noqa: BLE001
        _post_callback(callback_url, {"job_id": job_id, "error": str(exc)})


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
        watermark_path=payload.get("watermark_path"),
        watermark_rect=payload.get("watermark_rect"),
        output_path=output_path,
    )
    background_tasks.add_task(_run_render, job_id, job_input, payload["callback_url"])
    return {"status": "accepted"}


def _run_find_hooks(
    video_asset_id: str,
    file_path: str,
    hook: str,
    strategy_summary: str,
    requirements_checklist: list[str],
    callback_url: str,
) -> None:
    try:
        suggestions = find_hooks(file_path, hook, strategy_summary, requirements_checklist, GEMINI_API_KEY)
        _post_callback(
            callback_url,
            {
                "video_asset_id": video_asset_id,
                "hook_suggestions": [s.model_dump() for s in suggestions],
            },
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        logger.exception("find-hooks failed for video_asset_id=%s", video_asset_id)
        _post_callback(callback_url, {"video_asset_id": video_asset_id, "error": str(exc)})


@app.post("/find-hooks", status_code=202)
def find_hooks_route(payload: dict, background_tasks: BackgroundTasks) -> dict:
    background_tasks.add_task(
        _run_find_hooks,
        payload["video_asset_id"],
        payload["file_path"],
        payload["hook"],
        payload["strategy_summary"],
        payload["requirements_checklist"],
        payload["callback_url"],
    )
    return {"status": "accepted"}


def _run_cut(cut_job_id: str, file_path: str, start_seconds: float, duration_seconds: float, callback_url: str) -> None:
    output_dir = os.environ.get("VIDEO_ASSETS_DIR", "/app/video-assets")
    output_path = os.path.join(output_dir, "clips", f"{cut_job_id}.mp4")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    try:
        args = build_trim_args(file_path, start_seconds, start_seconds + duration_seconds, output_path)
        run_ffmpeg(args)
        actual_duration = probe_duration(output_path)
        _post_callback(
            callback_url,
            {"cut_job_id": cut_job_id, "status": "done", "output_path": output_path, "duration_seconds": actual_duration},
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        logger.exception("cut failed for cut_job_id=%s", cut_job_id)
        _post_callback(callback_url, {"cut_job_id": cut_job_id, "status": "failed", "error": str(exc)})


@app.post("/cut", status_code=202)
def cut_route(payload: dict, background_tasks: BackgroundTasks) -> dict:
    background_tasks.add_task(
        _run_cut,
        payload["cut_job_id"],
        payload["file_path"],
        payload["start_seconds"],
        payload["duration_seconds"],
        payload["callback_url"],
    )
    return {"status": "accepted"}


YOUTUBE_PROGRESS_THROTTLE_SECONDS = 2.0


def _cleanup_partial_download(output_path: str) -> None:
    """Best-effort removal of a failed/timed-out download's output file and
    any sibling fragment/part files yt-dlp may have created alongside it
    (e.g. "<output_path>.part", "<output_path>.f137.part"), so bad URLs,
    private videos, and timeouts don't leak unbounded orphan files into the
    shared video-assets volume forever. Never raises -- the file may not
    exist at all if the process failed before writing anything."""
    try:
        for path in glob.glob(f"{output_path}*"):
            try:
                os.remove(path)
            except OSError:
                pass
    except OSError:
        pass


def _run_youtube_download(job_id: str, url: str, output_path: str, callback_url: str) -> None:
    last_post_time = {"value": 0.0}

    def on_progress(progress: dict) -> None:
        now = time.monotonic()
        if now - last_post_time["value"] < YOUTUBE_PROGRESS_THROTTLE_SECONDS:
            return
        last_post_time["value"] = now
        _post_callback(callback_url, {"job_id": job_id, "status": "downloading", **progress})

    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        download_youtube_video(url, output_path, on_progress=on_progress)
        duration = probe_duration(output_path)
        _post_callback(
            callback_url,
            {"job_id": job_id, "status": "done", "output_path": output_path, "duration_seconds": duration},
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        logger.exception("youtube download failed for job_id=%s", job_id)
        _cleanup_partial_download(output_path)
        _post_callback(callback_url, {"job_id": job_id, "status": "failed", "error": str(exc)})


@app.post("/download-youtube", status_code=202)
def download_youtube_route(payload: dict, background_tasks: BackgroundTasks) -> dict:
    output_dir = os.environ.get("VIDEO_ASSETS_DIR", "/app/video-assets")
    output_path = os.path.join(output_dir, "downloads", f"{payload['job_id']}.mp4")
    background_tasks.add_task(_run_youtube_download, payload["job_id"], payload["url"], output_path, payload["callback_url"])
    return {"status": "accepted"}
