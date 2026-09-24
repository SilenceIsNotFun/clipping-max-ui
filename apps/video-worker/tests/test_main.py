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
