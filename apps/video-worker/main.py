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
