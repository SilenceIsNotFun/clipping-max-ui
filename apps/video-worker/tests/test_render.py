import os
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
