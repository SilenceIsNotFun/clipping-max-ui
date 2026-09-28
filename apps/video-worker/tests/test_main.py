import os
import time
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_post_callback_logs_and_does_not_raise_when_callback_rejects_payload(caplog):
    from main import _post_callback

    with patch("main.requests.post") as mock_post:
        mock_response = mock_post.return_value
        mock_response.raise_for_status.side_effect = Exception("413 Payload Too Large")
        with caplog.at_level("ERROR"):
            _post_callback("http://api:4000/whatever", {"video_asset_id": "asset-1"})

    assert "callback POST" in caplog.text
    assert "failed" in caplog.text


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


def test_analyze_callback_crop_suggestion_is_null_on_exception():
    with patch("main.detect_audio_peaks", return_value=[]), patch(
        "main.detect_scene_changes", return_value=[]
    ), patch(
        "main.detect_crop_suggestion", side_effect=ValueError("crop detection failed")
    ), patch("main.requests.post") as mock_post:
        client.post(
            "/analyze",
            json={
                "video_asset_id": "asset-crop-3",
                "file_path": "/fake/path.mp4",
                "callback_url": "http://api:4000/api/internal/assets/asset-crop-3/analysis-complete",
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


def test_render_passes_watermark_path_and_rect_through_to_render_job_input():
    with patch("main.render_video") as mock_render, patch("main.requests.post"):
        from schemas import CaptionWord, RenderResult

        mock_render.return_value = RenderResult(
            output_path="/app/video-assets/exports/job-wm-1.mp4",
            caption_words=[CaptionWord(word="hi", start_ms=0, end_ms=300)],
        )

        resp = client.post(
            "/render",
            json={
                "job_id": "job-wm-1",
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
                "watermark_path": "/app/video-assets/watermarks/logo.png",
                "watermark_rect": {"x": 0.05, "y": 0.05, "width": 0.2, "height": 0.1},
                "callback_url": "http://api:4000/api/internal/render/job-wm-1/complete",
            },
        )
        assert resp.status_code == 202

        for _ in range(20):
            if mock_render.called:
                break
            time.sleep(0.05)

        assert mock_render.called
        (job_input_arg, _work_dir), _kwargs = mock_render.call_args
        assert job_input_arg.watermark_path == "/app/video-assets/watermarks/logo.png"
        assert job_input_arg.watermark_rect is not None
        assert job_input_arg.watermark_rect.x == 0.05
        assert job_input_arg.watermark_rect.y == 0.05
        assert job_input_arg.watermark_rect.width == 0.2
        assert job_input_arg.watermark_rect.height == 0.1


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


def test_find_hooks_returns_202_and_calls_callback_with_suggestions():
    from schemas import HookSuggestion

    fake_suggestions = [HookSuggestion(start_ms=1000, end_ms=10000, title="T", reasoning="R")]
    with patch("main.find_hooks", return_value=fake_suggestions), patch("main.requests.post") as mock_post:
        resp = client.post(
            "/find-hooks",
            json={
                "video_asset_id": "asset-1",
                "file_path": os.path.join(FIXTURES, "short_clip.mp4"),
                "hook": "lead with the prize",
                "strategy_summary": "fast cuts",
                "requirements_checklist": ["30-59 seconds"],
                "callback_url": "http://api:4000/api/internal/assets/asset-1/hooks-complete",
            },
        )
        assert resp.status_code == 202
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

    _, kwargs = mock_post.call_args
    body = kwargs["json"]
    assert body["video_asset_id"] == "asset-1"
    assert body["hook_suggestions"][0]["title"] == "T"


def test_find_hooks_reports_error_on_gemini_failure():
    with patch("main.find_hooks", side_effect=RuntimeError("no GEMINI_API_KEY set")), patch(
        "main.requests.post"
    ) as mock_post:
        client.post(
            "/find-hooks",
            json={
                "video_asset_id": "asset-2",
                "file_path": os.path.join(FIXTURES, "short_clip.mp4"),
                "hook": "hook",
                "strategy_summary": "strategy",
                "requirements_checklist": [],
                "callback_url": "http://api:4000/api/internal/assets/asset-2/hooks-complete",
            },
        )
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

    _, kwargs = mock_post.call_args
    assert "no GEMINI_API_KEY" in kwargs["json"]["error"]
