import json
from unittest.mock import patch

from planner import build_prompt, call_ollama, parse_llm_response


def test_build_prompt_includes_all_inputs():
    prompt = build_prompt(
        campaign_summary="Promote a snack brand",
        requirements_text="Must show product in first 3 seconds",
        example_links=["https://example.com/brief-video"],
        content_format="15s vertical video",
        target_language="id",
        deadline="2026-10-01",
        reward="Rp 500.000",
        constraints="No profanity",
    )
    assert "Promote a snack brand" in prompt
    assert "Must show product in first 3 seconds" in prompt
    assert "https://example.com/brief-video" in prompt
    assert "15s vertical video" in prompt
    assert "id" in prompt
    assert "2026-10-01" in prompt
    assert "Rp 500.000" in prompt
    assert "No profanity" in prompt


def test_call_ollama_posts_to_generate_endpoint():
    with patch("planner.requests.post") as mock_post:
        mock_post.return_value.json.return_value = {"response": "hello"}
        mock_post.return_value.raise_for_status.return_value = None
        result = call_ollama("prompt text", "http://ollama:11434", "mistral:7b-instruct")
        assert result == "hello"
        mock_post.assert_called_once_with(
            "http://ollama:11434/api/generate",
            json={"model": "mistral:7b-instruct", "prompt": "prompt text", "stream": False},
            timeout=120,
        )


def test_parse_llm_response_extracts_json_from_fenced_block():
    raw = """Here is the plan:
```json
{
  "strategy_summary": "Focus on unboxing hook",
  "requirements_checklist": ["Show product in 3s", "Use hashtag #brand"],
  "content_plan": {"hook": "Surprise reveal", "script": "...", "assets": ["product shot"]},
  "opportunity_score": 72
}
```
"""
    result = parse_llm_response(raw)
    assert result.strategy_summary == "Focus on unboxing hook"
    assert result.requirements_checklist == ["Show product in 3s", "Use hashtag #brand"]
    assert result.content_plan["hook"] == "Surprise reveal"
    assert result.opportunity_score == 72


def test_parse_llm_response_raises_on_missing_json():
    import pytest

    with pytest.raises(ValueError):
        parse_llm_response("no json here")
