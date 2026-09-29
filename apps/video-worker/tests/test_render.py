import os
import subprocess
import wave
from unittest.mock import patch

from schemas import CaptionWord, RenderJobInput, RenderSegmentInput
from render import render_video

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
CLIP = os.path.join(FIXTURES, "short_clip.mp4")


def fake_generate_tts(text, voice, voices_dir, output_path):
    # Write a real, tiny, valid (silent) WAV file -- render_video's audio
    # concat step runs a real ffmpeg process against this path, so a
    # placeholder like b"RIFF" (not a decodable WAV) would fail there.
    with wave.open(output_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 1600)  # 0.1s of silence


def fake_align_words(audio_path):
    return [CaptionWord(word="hi", start_ms=0, end_ms=300)]


def test_render_video_produces_output_and_offsets_captions(tmp_path):
    job = RenderJobInput(
        segments=[
            RenderSegmentInput(
                file_path=CLIP,
                trim_start=0.0,
                trim_end=1.0,
                order_index=0,
                script_text="hi",
                layout_template="standard",
            ),
            RenderSegmentInput(
                file_path=CLIP,
                trim_start=1.0,
                trim_end=2.0,
                order_index=1,
                script_text="hi",
                layout_template="standard",
            ),
        ],
        tts_voice="id_ID-voice-medium",
        voices_dir="/app/voices",
        music_path=None,
        output_path=str(tmp_path / "final.mp4"),
    )

    with patch("render.generate_tts", side_effect=fake_generate_tts), patch(
        "render.align_words", side_effect=fake_align_words
    ), patch("render.probe_duration", return_value=1.0):
        result = render_video(job, str(tmp_path))

    assert os.path.exists(result.output_path)
    # second segment's caption words must be offset by the first segment's duration (1.0s)
    assert result.caption_words[0].start_ms == 0
    assert result.caption_words[1].start_ms == 1000


def test_render_video_overlays_watermark_when_present(tmp_path):
    from schemas import CropRect, RenderJobInput, RenderSegmentInput
    from render import render_video

    fixtures = os.path.join(os.path.dirname(__file__), "fixtures")
    watermark_path = os.path.join(fixtures, "sample_watermark.png")

    segment = RenderSegmentInput(
        file_path=os.path.join(fixtures, "short_clip.mp4"),
        trim_start=0,
        trim_end=1,
        order_index=0,
        script_text="hello",
        layout_template="standard",
    )
    job = RenderJobInput(
        segments=[segment],
        tts_voice="id_ID-news_tts-medium",
        voices_dir=os.environ.get("PIPER_VOICES_DIR", "/app/voices"),
        watermark_path=watermark_path,
        watermark_rect=CropRect(x=0.7, y=0.05, width=0.25, height=0.1),
        output_path=str(tmp_path / "output.mp4"),
    )

    result = render_video(job, str(tmp_path))
    assert os.path.exists(result.output_path)
    # A real ffprobe check that the output is a valid, playable video is
    # sufient here -- pixel-level verification of *where* the watermark
    # landed is out of scope for an automated test in this project
    # (established pattern: prior layout/title tests verify the filter
    # string, not rendered pixels).
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", result.output_path],
        capture_output=True,
        text=True,
    )
    assert probe.returncode == 0
    assert float(probe.stdout.strip()) > 0


def _run_render_video_with_mocked_ffmpeg(job, tmp_path):
    """Runs render_video with every dependency except the final run_ffmpeg
    call site heavily mocked out, so we can inspect the exact `args` list
    passed to the last ffmpeg invocation (the one that produces
    `final_output`) without touching real ffmpeg/piper. Returns that args
    list."""
    fake_video_path = str(tmp_path / "segment_0_video.mp4")
    fake_tts_path = str(tmp_path / "segment_0_tts.wav")

    captured_calls = []

    def fake_run_ffmpeg(args):
        captured_calls.append(args)

    with patch(
        "render._render_single_segment",
        return_value=(fake_video_path, fake_tts_path),
    ), patch("render.align_words", return_value=[]), patch(
        "render.probe_duration", return_value=1.0
    ), patch(
        "render._concat_video_only"
    ), patch(
        "render._concat_audio_only"
    ), patch(
        "render._write_ass"
    ), patch(
        "render.run_ffmpeg", side_effect=fake_run_ffmpeg
    ):
        render_video(job, str(tmp_path))

    # The final ffmpeg invocation (the one building `final_output`) is the
    # last captured call -- _render_single_segment's own run_ffmpeg call is
    # mocked out entirely via the _render_single_segment patch above, so
    # there is exactly one captured call here.
    assert len(captured_calls) == 1
    return captured_calls[0]


def test_render_video_omits_watermark_stage_when_unset(tmp_path):
    """Regression guard: when watermark_path/watermark_rect are unset, the
    constructed ffmpeg args must be byte-for-byte the pre-feature shape --
    no watermark input, no [wm]/[vout] filter fragments, and -map "[v]"
    (not "[vout]")."""
    segment = RenderSegmentInput(
        file_path=CLIP,
        trim_start=0.0,
        trim_end=1.0,
        order_index=0,
        script_text="hi",
        layout_template="standard",
    )
    job = RenderJobInput(
        segments=[segment],
        tts_voice="id_ID-voice-medium",
        voices_dir="/app/voices",
        music_path=None,
        watermark_path=None,
        watermark_rect=None,
        output_path=str(tmp_path / "final.mp4"),
    )

    args = _run_render_video_with_mocked_ffmpeg(job, tmp_path)

    assert not any(str(a).endswith(".png") for a in args)  # no watermark -i entry
    assert "[wm]" not in "".join(args)
    assert "[vout]" not in "".join(args)
    assert "-map" in args
    map_index = args.index("-map")
    assert args[map_index + 1] == "[v]"


def test_render_video_includes_watermark_stage_when_set(tmp_path):
    """Regression guard: when watermark_path/watermark_rect ARE set, the
    constructed ffmpeg args must include the watermark -i entry, the
    [wm]/[vout] filter fragments, and -map "[vout]"."""
    from schemas import CropRect

    segment = RenderSegmentInput(
        file_path=CLIP,
        trim_start=0.0,
        trim_end=1.0,
        order_index=0,
        script_text="hi",
        layout_template="standard",
    )
    watermark_path = os.path.join(FIXTURES, "sample_watermark.png")
    job = RenderJobInput(
        segments=[segment],
        tts_voice="id_ID-voice-medium",
        voices_dir="/app/voices",
        music_path=None,
        watermark_path=watermark_path,
        watermark_rect=CropRect(x=0.7, y=0.05, width=0.25, height=0.1),
        output_path=str(tmp_path / "final.mp4"),
    )

    args = _run_render_video_with_mocked_ffmpeg(job, tmp_path)

    assert watermark_path in args
    assert args[args.index(watermark_path) - 1] == "-i"
    joined = "".join(args)
    assert "[wm]" in joined
    assert "[vout]" in joined
    assert "-map" in args
    map_index = args.index("-map")
    assert args[map_index + 1] == "[vout]"


def test_build_watermark_overlay_filter_computes_pixel_geometry():
    from schemas import CropRect
    from render import _build_watermark_filter

    rect = CropRect(x=0.7, y=0.05, width=0.25, height=0.1)
    filter_str, watermark_input_index = _build_watermark_filter(rect, base_label="v", watermark_input_index=3)

    assert "scale=270:192" in filter_str  # 0.25*1080=270, 0.1*1920=192
    assert "overlay=756:96" in filter_str  # 0.7*1080=756, 0.05*1920=96
    assert "[3:v]" in filter_str
    assert watermark_input_index == 3


def test_write_ass_default_style_produces_dialogue_events_with_color_tags(tmp_path):
    from render import _write_ass
    from schemas import CaptionWord

    words = [
        CaptionWord(word="hello", start_ms=0, end_ms=300),
        CaptionWord(word="world", start_ms=300, end_ms=600),
    ]
    ass_path = str(tmp_path / "captions.ass")
    _write_ass(words, "default", ass_path)

    content = open(ass_path, encoding="utf-8").read()
    assert "[Script Info]" in content
    assert "[V4+ Styles]" in content
    assert "[Events]" in content
    # One Dialogue event per active word (karaoke-style highlight)
    assert content.count("Dialogue:") == 2
    assert "hello" in content
    assert "world" in content
    # Color-swap override tag for the highlighted word
    assert "\\c&H" in content


def test_write_ass_groups_words_into_multi_word_karaoke_lines(tmp_path):
    """Regression test: each Dialogue event must show the word's surrounding
    line (multiple words), with only the currently-active word wrapped in the
    highlight color tag -- not the word shown alone (which was indistinguishable
    from the old SRT captions it replaced)."""
    from render import CAPTION_STYLES, _write_ass
    from schemas import CaptionWord

    words = [
        CaptionWord(word="hello", start_ms=0, end_ms=100),
        CaptionWord(word="there", start_ms=100, end_ms=200),
        CaptionWord(word="friend", start_ms=200, end_ms=300),
        CaptionWord(word="today", start_ms=300, end_ms=400),
    ]
    ass_path = str(tmp_path / "captions.ass")
    _write_ass(words, "default", ass_path)

    content = open(ass_path, encoding="utf-8").read()
    dialogue_lines = [line for line in content.splitlines() if line.startswith("Dialogue:")]

    # One Dialogue event per word, still -- but now each shows the WHOLE line.
    assert len(dialogue_lines) == 4
    for line in dialogue_lines:
        for w in ("hello", "there", "friend", "today"):
            assert w in line, f"expected '{w}' present in every line's rendered text: {line}"

    style = CAPTION_STYLES["default"]
    highlight_tag = f"{{\\c{style['highlight']}}}"
    primary_reset_tag = f"{{\\c{style['primary']}}}"

    # The event active during "there"'s window highlights only "there".
    there_line = next(line for line in dialogue_lines if "0:00:00.10" in line.split(",")[1])
    assert f"{highlight_tag}there{primary_reset_tag}" in there_line
    assert f"{highlight_tag}hello{primary_reset_tag}" not in there_line
    assert f"{highlight_tag}friend{primary_reset_tag}" not in there_line
    assert f"{highlight_tag}today{primary_reset_tag}" not in there_line
    # Exactly one word is wrapped in the highlight tag per line.
    assert there_line.count("\\c" + style["highlight"]) == 1


def test_write_ass_multiple_lines_when_more_than_words_per_line(tmp_path):
    """More than WORDS_PER_LINE words must start a new line group rather than
    growing one giant Dialogue text forever."""
    from render import WORDS_PER_LINE, _write_ass
    from schemas import CaptionWord

    words = [
        CaptionWord(word=f"word{i}", start_ms=i * 100, end_ms=(i + 1) * 100)
        for i in range(WORDS_PER_LINE + 2)
    ]
    ass_path = str(tmp_path / "captions.ass")
    _write_ass(words, "default", ass_path)

    content = open(ass_path, encoding="utf-8").read()
    dialogue_lines = [line for line in content.splitlines() if line.startswith("Dialogue:")]
    assert len(dialogue_lines) == len(words)

    # A Dialogue event from the first line-group must not include words from
    # the second line-group, and vice versa.
    first_group_event = dialogue_lines[0]
    assert "word0" in first_group_event
    assert f"word{WORDS_PER_LINE}" not in first_group_event

    last_group_event = dialogue_lines[-1]
    assert f"word{WORDS_PER_LINE + 1}" in last_group_event
    assert "word0" not in last_group_event


def test_write_ass_unknown_style_falls_back_to_default(tmp_path):
    from render import _write_ass
    from schemas import CaptionWord

    words = [CaptionWord(word="hi", start_ms=0, end_ms=200)]
    ass_path = str(tmp_path / "captions.ass")
    # Must not raise even with a style name that doesn't exist
    _write_ass(words, "nonexistent_style_xyz", ass_path)
    assert os.path.exists(ass_path)


def test_write_ass_handles_empty_caption_words(tmp_path):
    from render import _write_ass

    ass_path = str(tmp_path / "captions.ass")
    _write_ass([], "default", ass_path)
    content = open(ass_path, encoding="utf-8").read()
    # Header sections must still be present even with zero words, so the
    # subtitles= filter has a syntactically valid (if caption-less) file to
    # burn in rather than failing the whole render on an edge case.
    assert "[Events]" in content
    assert content.count("Dialogue:") == 0


def test_render_single_segment_passes_title_rect_to_render_title_png():
    from unittest.mock import patch
    from schemas import CropRect, RenderSegmentInput
    from render import _render_single_segment

    fixtures = os.path.join(os.path.dirname(__file__), "fixtures")
    segment = RenderSegmentInput(
        file_path=os.path.join(fixtures, "short_clip.mp4"),
        trim_start=0,
        trim_end=1,
        order_index=0,
        script_text="hello",
        layout_template="standard",
        title_text="Hello",
        title_rect=CropRect(x=0.1, y=0.8, width=0.8, height=0.1),
    )

    with patch("render.render_title_png") as mock_render_title, patch("render.generate_tts"), patch(
        "render.run_ffmpeg"
    ):
        _render_single_segment(segment, 0, "id_ID-news_tts-medium", "/app/voices", "/tmp")

    mock_render_title.assert_called_once()
    call_args = mock_render_title.call_args
    assert call_args[0][0] == "Hello"
    assert call_args[0][2] == segment.title_rect


def test_write_ass_still_uses_named_presets_via_resolve_caption_style():
    from render import _write_ass
    from schemas import CaptionWord

    words = [CaptionWord(word="hi", start_ms=0, end_ms=500)]
    ass_path = "/tmp/test_write_ass_preset.ass"
    _write_ass(words, "energetic", ass_path)
    with open(ass_path) as f:
        content = f.read()
    assert "&H000080FF" in content  # energetic preset's highlight color
    os.remove(ass_path)
