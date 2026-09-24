import os
import subprocess

import pytest

from ffmpeg_utils import build_concat_args, build_trim_args, probe_duration, run_ffmpeg

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
CLIP = os.path.join(FIXTURES, "short_clip.mp4")


def test_probe_duration_returns_seconds():
    duration = probe_duration(CLIP)
    assert 1.8 < duration < 2.2


def test_build_trim_args_produces_valid_command(tmp_path):
    output = str(tmp_path / "trimmed.mp4")
    args = build_trim_args(CLIP, 0.0, 1.0, output)
    run_ffmpeg(args)
    assert os.path.exists(output)
    assert 0.8 < probe_duration(output) < 1.2


def test_build_concat_args_produces_valid_command(tmp_path):
    trimmed1 = str(tmp_path / "a.mp4")
    trimmed2 = str(tmp_path / "b.mp4")
    run_ffmpeg(build_trim_args(CLIP, 0.0, 1.0, trimmed1))
    run_ffmpeg(build_trim_args(CLIP, 1.0, 2.0, trimmed2))

    output = str(tmp_path / "combined.mp4")
    args = build_concat_args([trimmed1, trimmed2], output)
    run_ffmpeg(args)
    assert os.path.exists(output)
    assert 1.8 < probe_duration(output) < 2.2


def test_run_ffmpeg_raises_on_bad_input(tmp_path):
    with pytest.raises(subprocess.CalledProcessError):
        run_ffmpeg(["ffmpeg", "-y", "-i", "/nonexistent.mp4", str(tmp_path / "out.mp4")])
