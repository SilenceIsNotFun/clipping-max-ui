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


def test_title_text_appends_drawtext_filter():
    segment = SegmentInput(layout_template="standard", title_text="MOMENT CLUTCH TENZ")
    result = build_segment_filter(segment)
    assert "drawtext" in result
    assert "MOMENT CLUTCH TENZ" in result


def test_no_title_text_omits_drawtext_filter():
    segment = SegmentInput(layout_template="standard", title_text=None)
    result = build_segment_filter(segment)
    assert "drawtext" not in result


def test_title_text_with_apostrophe_is_escaped_safely():
    segment = SegmentInput(layout_template="standard", title_text="Ryan's clutch")
    result = build_segment_filter(segment)
    assert "Ryan" in result
    assert "clutch" in result
    # must use the close-quote/escaped-quote/reopen-quote trick, not a
    # backslash-escaped quote (which terminates the ffmpeg filter string early)
    assert "'\\''" in result
    assert "Ryan\\'" not in result


def test_missing_required_crop_raises():
    import pytest

    with pytest.raises(ValueError):
        build_segment_filter(SegmentInput(layout_template="gameplay_full_focus"))
