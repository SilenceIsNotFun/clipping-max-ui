from schemas import CropRect, SegmentInput

CANVAS_W = 1080
CANVAS_H = 1920


def _crop_expr(rect: CropRect) -> str:
    return (
        f"crop=w=iw*{rect.width}:h=ih*{rect.height}:"
        f"x=iw*{rect.x}:y=ih*{rect.y}"
    )


def build_segment_filter(segment: SegmentInput) -> str:
    if segment.layout_template == "standard":
        chain = (
            f"[0:v]scale={CANVAS_W}:{CANVAS_H}:force_original_aspect_ratio=increase,"
            f"crop={CANVAS_W}:{CANVAS_H}[base]"
        )

    elif segment.layout_template == "gameplay_full_focus":
        if segment.has_secondary:
            chain = f"[0:v]scale={CANVAS_W}:{CANVAS_H}[base]"
        else:
            if segment.crop_gameplay_rect is None:
                raise ValueError("gameplay_full_focus requires crop_gameplay_rect")
            chain = f"[0:v]{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{CANVAS_H}[base]"

    elif segment.layout_template == "gameplay_facecam_split":
        top_h = int(CANVAS_H * 0.6)
        bottom_h = CANVAS_H - top_h
        if segment.has_secondary:
            chain = (
                f"[0:v]scale={CANVAS_W}:{top_h}[top];"
                f"[1:v]scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2[base]"
            )
        else:
            if segment.crop_gameplay_rect is None or segment.crop_facecam_rect is None:
                raise ValueError(
                    "gameplay_facecam_split requires crop_gameplay_rect and crop_facecam_rect"
                )
            chain = (
                f"[0:v]split=2[src1][src2];"
                f"[src1]{_crop_expr(segment.crop_gameplay_rect)},scale={CANVAS_W}:{top_h}[top];"
                f"[src2]{_crop_expr(segment.crop_facecam_rect)},scale={CANVAS_W}:{bottom_h}[bottom];"
                "[top][bottom]vstack=inputs=2[base]"
            )

    elif segment.layout_template == "cinematic_letterbox":
        chain = (
            f"[0:v]scale={CANVAS_W}:-1:force_original_aspect_ratio=decrease,"
            f"pad={CANVAS_W}:{CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black[base]"
        )

    else:
        raise ValueError(f"unknown layout_template: {segment.layout_template}")

    if segment.title_overlay_path:
        png_input_index = 2 if segment.has_secondary else 1
        chain += f";[base][{png_input_index}:v]overlay=0:0[out]"
    else:
        chain += ";[base]null[out]"

    return chain
