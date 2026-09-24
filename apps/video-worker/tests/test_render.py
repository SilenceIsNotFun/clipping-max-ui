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
