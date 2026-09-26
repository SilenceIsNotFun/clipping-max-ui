from schemas import CropRect, SegmentInput
from layout import build_segment_filter


def test_standard_layout_scales_and_crops_to_canvas():
    segment = SegmentInput(layout_template="standard")
    result = build_segment_filter(segment)
    assert "scale=1080:1920" in result
    assert "crop=1080:1920" in result


def test_gameplay_full_focus_uses_crop_gameplay_rect():
    segment = SegmentInput(
        layout_template="gameplay_full_focus",
        crop_gameplay_rect=CropRect(x=0.0, y=0.0, width=1.0, height=0.5),
    )
    result = build_segment_filter(segment)
    assert "crop=" in result
    assert "iw*1.0" in result or "iw*1.000000" in result
    assert "scale=1080:1920" in result


def test_gameplay_facecam_split_single_source_crops_both_areas():
    segment = SegmentInput(
        layout_template="gameplay_facecam_split",
        crop_gameplay_rect=CropRect(x=0.0, y=0.0, width=1.0, height=0.5),
        crop_facecam_rect=CropRect(x=0.0, y=0.5, width=1.0, height=0.5),
        has_secondary=False,
    )
    result = build_segment_filter(segment)
    assert "vstack" in result
    assert result.count("crop=") == 2


def test_gameplay_facecam_split_two_sources_skips_crop():
    segment = SegmentInput(layout_template="gameplay_facecam_split", has_secondary=True)
    result = build_segment_filter(segment)
    assert "vstack" in result
    assert "crop=" not in result


def test_cinematic_letterbox_pads_with_black_bars():
    segment = SegmentInput(layout_template="cinematic_letterbox")
    result = build_segment_filter(segment)
    assert "pad=1080:1920" in result
    assert "black" in result


def test_title_overlay_path_appends_overlay_filter_and_out_label():
    segment = SegmentInput(layout_template="standard", title_overlay_path="/tmp/title.png")
    result = build_segment_filter(segment)
    assert "overlay=0:0[out]" in result
    assert "[1:v]" in result or "1:v" in result


def test_no_title_overlay_path_still_produces_out_label_without_overlay():
    segment = SegmentInput(layout_template="standard", title_overlay_path=None)
    result = build_segment_filter(segment)
    assert "[out]" in result
    assert "overlay" not in result


def test_title_overlay_uses_correct_input_index_with_secondary_source():
    segment = SegmentInput(layout_template="gameplay_facecam_split", has_secondary=True, title_overlay_path="/tmp/title.png")
    result = build_segment_filter(segment)
    # primary=0, secondary=1, so the title PNG must be input 2 when a
    # secondary source is present
    assert "[2:v]overlay=0:0[out]" in result


def test_missing_required_crop_raises():
    import pytest

    with pytest.raises(ValueError):
        build_segment_filter(SegmentInput(layout_template="gameplay_full_focus"))
