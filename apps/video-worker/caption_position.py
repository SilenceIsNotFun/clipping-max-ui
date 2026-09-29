"""Approximates an operator-dragged caption placement rect into the nearest
ASS alignment/margin combination. Captions render via ffmpeg's `subtitles`
filter (libass), which positions text using a numpad-style Alignment code
(1-9: bottom-left..top-right) plus margins, not an arbitrary pixel
coordinate -- unlike the title overlay, which is a composited PNG image and
can sit at any (x, y). This keeps the drag UI genuinely free-form while the
backend works within ASS's real constraints, preserving the existing
per-word karaoke highlight effect (which depends on staying in the ASS/libass
rendering path rather than switching to per-word PNG compositing).

When rect is None, returns exactly today's hardcoded values -- this MUST
stay unchanged; a test in this module pins it.
"""

from schemas import CropRect

CANVAS_W = 1080
CANVAS_H = 1920

_DEFAULT_POSITION = {"alignment": 2, "margin_l": 40, "margin_r": 40, "margin_v": 120}

# ASS numpad alignment codes, keyed by (horizontal_zone, vertical_zone).
_ALIGNMENT_TABLE = {
    ("left", "bottom"): 1,
    ("center", "bottom"): 2,
    ("right", "bottom"): 3,
    ("left", "middle"): 4,
    ("center", "middle"): 5,
    ("right", "middle"): 6,
    ("left", "top"): 7,
    ("center", "top"): 8,
    ("right", "top"): 9,
}


def _zone(fraction: float) -> str:
    """Splits [0, 1] into thirds."""
    if fraction < 1 / 3:
        return "low"  # left or top, depending on axis
    if fraction < 2 / 3:
        return "mid"
    return "high"  # right or bottom


def rect_to_ass_position(rect: CropRect | None) -> dict[str, int]:
    if rect is None:
        return dict(_DEFAULT_POSITION)

    center_x = rect.x + rect.width / 2
    center_y = rect.y + rect.height / 2

    horizontal_zone_map = {"low": "left", "mid": "center", "high": "right"}
    vertical_zone_map = {"low": "top", "mid": "middle", "high": "bottom"}

    horizontal = horizontal_zone_map[_zone(center_x)]
    vertical = vertical_zone_map[_zone(center_y)]
    alignment = _ALIGNMENT_TABLE[(horizontal, vertical)]

    # Margins: distance from the relevant edge, scaled to the canvas.
    # For a "bottom" alignment, margin_v is measured up from the bottom edge;
    # for "top", margin_v is measured down from the top edge; "middle"
    # alignments in libass ignore margin_v for vertical centering, but a
    # small consistent value keeps behavior sane if libass's handling of it
    # varies by version.
    if vertical == "bottom":
        margin_v = round((1 - (rect.y + rect.height)) * CANVAS_H)
    elif vertical == "top":
        margin_v = round(rect.y * CANVAS_H)
    else:
        margin_v = round(abs(0.5 - center_y) * CANVAS_H)

    margin_l = round(rect.x * CANVAS_W)
    margin_r = round((1 - (rect.x + rect.width)) * CANVAS_W)

    return {
        "alignment": alignment,
        "margin_l": max(margin_l, 0),
        "margin_r": max(margin_r, 0),
        "margin_v": max(margin_v, 0),
    }
