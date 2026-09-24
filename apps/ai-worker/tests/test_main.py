import os
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_parse_route_returns_parsed_document():
    resp = client.post(
        "/parse",
        json={"file_path": os.path.join(FIXTURES, "sample.docx"), "doc_type": "docx"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "Reward Campaign" in body["raw_text"]
    assert body["extracted_links"] == ["https://example.com/brief-video"]


def test_parse_route_invalid_doc_type_returns_400():
    resp = client.post(
        "/parse",
        json={"file_path": os.path.join(FIXTURES, "sample.docx"), "doc_type": "csv"},
    )
    assert resp.status_code == 400


def test_plan_route_returns_plan_result():
    fake_raw = (
        "Here is the plan:\n"
        "```json\n"
        "{\n"
        '  "strategy_summary": "s",\n'
        '  "requirements_checklist": ["a"],\n'
        '  "content_plan": {"hook": "h"},\n'
        '  "opportunity_score": 50\n'
        "}\n"
        "```"
    )
    with patch("main.call_ollama", return_value=fake_raw):
        resp = client.post(
            "/plan",
            json={
                "campaign_summary": "sum",
                "requirements_text": "req",
                "example_links": [],
                "content_format": "video",
                "target_language": "id",
                "deadline": "2026-10-01",
                "reward": "500k",
                "constraints": "none",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["strategy_summary"] == "s"
    assert body["opportunity_score"] == 50
