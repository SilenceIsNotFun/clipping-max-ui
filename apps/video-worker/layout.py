from schemas import CropRect, SegmentInput

CANVAS_W = 1080
CANVAS_H = 1920


def _crop_expr(rect: CropRect) -> str:
    return (
        f"crop=w=iw*{rect.width}:h=ih*{rect.height}:"
        f"x=iw*{rect.x}:y=ih*{rect.y}"
    )


def _title_filter(title_text: str) -> str:
    escaped = title_text.replace("'", "\\'").replace(":", "\\:")
    return (
        f"drawtext=text='{escaped}':fontcolor=white:fontsize=64:"
        "borderw=3:bordercolor=black:x=(w-text_w)/2:y=80"
    )


def build_segment_filter(segment: SegmentInput) -> str:
    if segment.layout_template == "standard":
        filters = [
            f"scale={CANVAS_W}:{CANVAS_H}:force_original_aspect_ratio=increase",
            f"crop={CANVAS_W}:{CANVAS_H}",
        ]
        chain = ",".join(filters)

    elif segment.layout_template == "gameplay_full_focus":
        if segment.has_secondary:
            chain = f"scale={CANVAS_W}:{CANVAS_H}"
        else:
            if segment.crop_gameplay_rect is None:
                raise ValueError("gameplay_full_focus requires crop_gameplay_rect")
            chain = f"{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{CANVAS_H}"

    elif segment.layout_template == "gameplay_facecam_split":
        top_h = int(CANVAS_H * 0.6)
        bottom_h = CANVAS_H - top_h
        if segment.has_secondary:
            chain = (
                f"[0:v]scale={CANVAS_W}:{top_h}[top];"
                f"[1:v]scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2"
            )
        else:
            if segment.crop_gameplay_rect is None or segment.crop_facecam_rect is None:
                raise ValueError(
                    "gameplay_facecam_split requires crop_gameplay_rect and crop_facecam_rect"
                )
            chain = (
                f"split=2[src1][src2];"
                f"[src1]{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{top_h}[top];"
                f"[src2]{_crop_expr(segment.crop_facecam_rect)},scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2"
            )

    elif segment.layout_template == "cinematic_letterbox":
        chain = (
            f"scale={CANVAS_W}:-1:force_original_aspect_ratio=decrease,"
            f"pad={CANVAS_W}:{CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black"
        )

    else:
        raise ValueError(f"unknown layout_template: {segment.layout_template}")

    if segment.title_text:
        chain = f"{chain},{_title_filter(segment.title_text)}"

    return chain
