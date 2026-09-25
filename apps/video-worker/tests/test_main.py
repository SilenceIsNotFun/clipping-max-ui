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
    with patch("main.detect_audio_peaks", return_value=[]), patch(
        "main.detect_scene_changes", return_value=[]
    ), patch("main.detect_crop_suggestion", return_value=None), patch(
        "main.requests.post"
    ) as mock_post:
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
        assert "crop_suggestion" in body


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
