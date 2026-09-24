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
