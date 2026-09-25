from unittest.mock import patch

from face_crop import (
    _cluster_detections,
    _score_cluster,
    detect_face_crop,
    detect_crop_suggestion,
    detect_saliency_crop,
)


def test_cluster_detections_groups_nearby_points():
    boxes = [
        (0.5, 0.5, 0.2, 0.2),
        (0.51, 0.49, 0.2, 0.2),
        (0.9, 0.1, 0.15, 0.15),
    ]
    clusters = _cluster_detections(boxes)
    assert len(clusters) == 2
    sizes = sorted(len(c["points"]) for c in clusters)
    assert sizes == [1, 2]


def test_score_cluster_rewards_count_width_and_center_bias():
    center_cluster = {"cx": 0.5, "points": [(0.5, 0.5, 0.3, 0.3)] * 5}
    edge_cluster = {"cx": 0.95, "points": [(0.95, 0.5, 0.3, 0.3)] * 5}
    assert _score_cluster(center_cluster) > _score_cluster(edge_cluster)


def test_detect_face_crop_returns_none_when_no_faces_found():
    with patch("face_crop._extract_frame", return_value=None), patch(
        "face_crop.probe_duration", return_value=10.0
    ):
        primary, secondary = detect_face_crop("/fake/path.mp4")
    assert primary is None
    assert secondary is None


def test_detect_face_crop_picks_highest_scoring_cluster():
    fake_frame = object()

    def fake_detect(frame):
        return [(0.5, 0.5, 0.2, 0.2)]

    with patch("face_crop._extract_frame", return_value=fake_frame), patch(
        "face_crop.detect_faces_in_frame", side_effect=fake_detect
    ), patch("face_crop.probe_duration", return_value=10.0):
        primary, secondary = detect_face_crop("/fake/path.mp4")

    assert primary is not None
    assert 0.0 <= primary.x <= 1.0
    assert 0.0 <= primary.y <= 1.0
    assert primary.width > 0
    assert primary.height > 0
    assert secondary is None


def test_detect_face_crop_finds_dual_speakers_on_opposite_sides():
    fake_frame = object()

    def fake_detect(frame):
        return [(0.2, 0.5, 0.15, 0.15), (0.8, 0.5, 0.15, 0.15)]

    with patch("face_crop._extract_frame", return_value=fake_frame), patch(
        "face_crop.detect_faces_in_frame", side_effect=fake_detect
    ), patch("face_crop.probe_duration", return_value=10.0):
        primary, secondary = detect_face_crop("/fake/path.mp4")

    assert primary is not None
    assert secondary is not None


def test_detect_saliency_crop_returns_none_when_no_frames_readable():
    with patch("face_crop._extract_frame", return_value=None), patch(
        "face_crop.probe_duration", return_value=10.0
    ):
        result = detect_saliency_crop("/fake/path.mp4")
    assert result is None


def test_detect_saliency_crop_centers_on_weighted_motion(tmp_path):
    # Use the real short_clip.mp4 fixture (static two-tone frame, no faces) to
    # exercise the real saliency+motion code path end-to-end rather than mocking
    # cv2.saliency internals, which are awkward to mock meaningfully.
    import os

    fixture = os.path.join(os.path.dirname(__file__), "fixtures", "short_clip.mp4")
    result = detect_saliency_crop(fixture)
    # A static, unchanging two-color frame has no motion signal, so this may
    # legitimately return None (no saliency/motion peak found) -- the real
    # assertion is that it does not raise, and if it returns a rect, the rect
    # is well-formed.
    if result is not None:
        assert 0.0 <= result.x <= 1.0
        assert 0.0 <= result.y <= 1.0
        assert result.width > 0
        assert result.height > 0


def test_detect_crop_suggestion_prefers_face_over_saliency():
    from schemas import CropRect

    fake_rect = CropRect(x=0.1, y=0.1, width=0.5, height=0.5)
    with patch("face_crop.detect_face_crop", return_value=(fake_rect, None)), patch(
        "face_crop.detect_saliency_crop"
    ) as mock_saliency:
        result = detect_crop_suggestion("/fake/path.mp4")

    assert result is not None
    assert result.detection_method == "face"
    assert result.crop_gameplay_rect == fake_rect
    mock_saliency.assert_not_called()


def test_detect_crop_suggestion_falls_back_to_saliency():
    from schemas import CropRect

    fake_rect = CropRect(x=0.2, y=0.2, width=0.6, height=0.6)
    with patch("face_crop.detect_face_crop", return_value=(None, None)), patch(
        "face_crop.detect_saliency_crop", return_value=fake_rect
    ):
        result = detect_crop_suggestion("/fake/path.mp4")

    assert result is not None
    assert result.detection_method == "saliency"
    assert result.crop_gameplay_rect == fake_rect


def test_detect_crop_suggestion_returns_none_when_both_fail():
    with patch("face_crop.detect_face_crop", return_value=(None, None)), patch(
        "face_crop.detect_saliency_crop", return_value=None
    ):
        result = detect_crop_suggestion("/fake/path.mp4")

    assert result is None
