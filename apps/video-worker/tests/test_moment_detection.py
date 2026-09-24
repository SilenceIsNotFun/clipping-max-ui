import os

from moment_detection import detect_audio_peaks, detect_scene_changes

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_detect_audio_peaks_finds_the_loud_window():
    candidates = detect_audio_peaks(os.path.join(FIXTURES, "short_clip_with_peak.wav"))
    assert len(candidates) >= 1
    top = max(candidates, key=lambda c: c.score)
    # With WINDOW_SECONDS=0.5/STEP_SECONDS=0.25 and the peak spanning 1.4-1.6s,
    # the 0.5s window with the largest overlap with the peak starts at 1.25s
    # (a 0.4s/0.5s = 40% overlap) -- not a window centered on the peak itself,
    # since windows are wider than the peak. This is deterministic given the
    # fixture and constants above, verified by direct calculation.
    assert 1200 <= top.timestamp_ms <= 1300
    assert top.detection_type == "audio_peak"
    assert 0.0 <= top.score <= 1.0


def test_detect_scene_changes_returns_list_for_short_clip():
    candidates = detect_scene_changes(os.path.join(FIXTURES, "short_clip.mp4"))
    assert isinstance(candidates, list)
    for c in candidates:
        assert c.detection_type == "scene_change"
        assert 0.0 <= c.score <= 1.0
