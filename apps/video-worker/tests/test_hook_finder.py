from unittest.mock import MagicMock, patch

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


class _FakeFile:
    def __init__(self, state: str = "ACTIVE", name: str = "files/abc123"):
        self.state = state
        self.name = name
        self.error = None


def test_find_hooks_uploads_file_and_returns_parsed_suggestions():
    fake_uploaded = _FakeFile(state="ACTIVE")
    fake_response = MagicMock()
    fake_response.text = '[{"start_seconds": 1, "end_seconds": 10, "title": "T", "reasoning": "R"}]'

    fake_client = MagicMock()
    fake_client.files.upload.return_value = fake_uploaded
    fake_client.models.generate_content.return_value = fake_response

    with patch("hook_finder.genai.Client", return_value=fake_client):
        from hook_finder import find_hooks

        result = find_hooks(
            file_path="/tmp/fake.mp4",
            hook="lead with the prize",
            strategy_summary="fast cuts",
            requirements_checklist=["30-59 seconds"],
            api_key="fake-key",
        )

    assert len(result) == 1
    assert result[0].title == "T"
    fake_client.files.upload.assert_called_once_with(file="/tmp/fake.mp4")
    # the uploaded file and the prompt must both be passed as contents
    call_kwargs = fake_client.models.generate_content.call_args.kwargs
    assert fake_uploaded in call_kwargs["contents"]
    assert any(isinstance(c, str) and "lead with the prize" in c for c in call_kwargs["contents"])


def test_find_hooks_waits_for_processing_state():
    processing_then_active = [_FakeFile(state="PROCESSING"), _FakeFile(state="ACTIVE")]
    fake_response = MagicMock()
    fake_response.text = '[{"start_seconds": 1, "end_seconds": 10, "title": "T", "reasoning": "R"}]'

    fake_client = MagicMock()
    fake_client.files.upload.return_value = processing_then_active[0]
    fake_client.files.get.return_value = processing_then_active[1]
    fake_client.models.generate_content.return_value = fake_response

    with patch("hook_finder.genai.Client", return_value=fake_client), patch("hook_finder.time.sleep"):
        from hook_finder import find_hooks

        result = find_hooks(
            file_path="/tmp/fake.mp4",
            hook="hook",
            strategy_summary="strategy",
            requirements_checklist=[],
            api_key="fake-key",
        )

    assert len(result) == 1
    fake_client.files.get.assert_called_once()


def test_find_hooks_raises_when_file_processing_never_leaves_processing_state():
    always_processing = _FakeFile(state="PROCESSING")

    fake_client = MagicMock()
    fake_client.files.upload.return_value = always_processing
    fake_client.files.get.return_value = always_processing

    # Fast-forward the deadline check without actually sleeping: the first
    # call to time.monotonic() establishes the deadline, every call after
    # that reports time already past it, so the loop raises on its first
    # iteration instead of looping (or sleeping) forever.
    monotonic_values = iter([0, 1000, 1000, 1000, 1000])

    with patch("hook_finder.genai.Client", return_value=fake_client), patch(
        "hook_finder.time.sleep"
    ), patch("hook_finder.time.monotonic", side_effect=lambda: next(monotonic_values, 1000)):
        from hook_finder import find_hooks

        with pytest.raises(RuntimeError, match="timed out"):
            find_hooks(
                file_path="/tmp/fake.mp4",
                hook="hook",
                strategy_summary="strategy",
                requirements_checklist=[],
                api_key="fake-key",
            )


def test_find_hooks_raises_when_gemini_processing_fails():
    fake_uploaded = _FakeFile(state="FAILED")
    fake_uploaded.error = "corrupt video"

    fake_client = MagicMock()
    fake_client.files.upload.return_value = fake_uploaded

    with patch("hook_finder.genai.Client", return_value=fake_client):
        from hook_finder import find_hooks

        try:
            find_hooks(
                file_path="/tmp/fake.mp4",
                hook="hook",
                strategy_summary="strategy",
                requirements_checklist=[],
                api_key="fake-key",
            )
            assert False, "expected RuntimeError"
        except RuntimeError as exc:
            assert "corrupt video" in str(exc)
