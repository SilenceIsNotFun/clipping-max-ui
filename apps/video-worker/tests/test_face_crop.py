from unittest.mock import patch

from face_crop import _cluster_detections, _score_cluster, detect_face_crop


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
