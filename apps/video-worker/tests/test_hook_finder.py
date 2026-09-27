import pytest

from hook_finder import build_prompt, parse_hook_response


def test_build_prompt_includes_all_inputs():
    prompt = build_prompt(
        hook="Lead with the Bitcoin prize",
        strategy_summary="Fast cuts, high energy, trending audio",
        requirements_checklist=["Length: 30-59 seconds", "Talking head only"],
    )
    assert "Lead with the Bitcoin prize" in prompt
    assert "Fast cuts, high energy, trending audio" in prompt
    assert "Length: 30-59 seconds" in prompt
    assert "Talking head only" in prompt


def test_build_prompt_handles_empty_checklist():
    prompt = build_prompt(hook="hook", strategy_summary="strategy", requirements_checklist=[])
    assert "none specified" in prompt


def test_parse_hook_response_extracts_json_from_fenced_block():
    raw = """Here are the hooks:
```json
[
  {"start_seconds": 12.5, "end_seconds": 38.0, "title": "He Bet a Bitcoin on THIS", "reasoning": "Opens on the prize reveal, matches the required hook direction."}
]
```
"""
    result = parse_hook_response(raw)
    assert len(result) == 1
    assert result[0].start_ms == 12500
    assert result[0].end_ms == 38000
    assert result[0].title == "He Bet a Bitcoin on THIS"
    assert "prize reveal" in result[0].reasoning


def test_parse_hook_response_extracts_json_without_fence():
    raw = '[{"start_seconds": 5, "end_seconds": 20, "title": "Clip A", "reasoning": "Reason A"}]'
    result = parse_hook_response(raw)
    assert len(result) == 1
    assert result[0].start_ms == 5000
    assert result[0].end_ms == 20000


def test_parse_hook_response_handles_multiple_candidates():
    raw = """[
  {"start_seconds": 0, "end_seconds": 15, "title": "A", "reasoning": "ra"},
  {"start_seconds": 100, "end_seconds": 130, "title": "B", "reasoning": "rb"},
  {"start_seconds": 200, "end_seconds": 225, "title": "C", "reasoning": "rc"}
]"""
    result = parse_hook_response(raw)
    assert len(result) == 3
    assert [r.title for r in result] == ["A", "B", "C"]


def test_parse_hook_response_raises_on_missing_json():
    with pytest.raises(ValueError):
        parse_hook_response("no json here at all")


def test_parse_hook_response_raises_on_malformed_json():
    with pytest.raises(ValueError):
        parse_hook_response("[ this is not valid json ]")
