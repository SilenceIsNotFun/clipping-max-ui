"""Resolves a segment's title_color/caption_style field into concrete color
values for the respective renderer. Unset or invalid values fall back to
today's current defaults -- a color problem degrades styling, it never
fails a render.
"""

import re

_HEX_RE = re.compile(r"^#([0-9a-fA-F]{6})$")

DEFAULT_TITLE_COLOR = (255, 255, 255)  # white, today's hardcoded value

_TITLE_COLOR_PRESETS: dict[str, tuple[int, int, int]] = {
    "white": (255, 255, 255),
    "yellow": (255, 221, 0),
    "black": (0, 0, 0),
    "red": (220, 38, 38),
}


def resolve_title_color(value: str | None) -> tuple[int, int, int]:
    if not value:
        return DEFAULT_TITLE_COLOR
    if value in _TITLE_COLOR_PRESETS:
        return _TITLE_COLOR_PRESETS[value]
    match = _HEX_RE.match(value)
    if match:
        hex_digits = match.group(1)
        return (int(hex_digits[0:2], 16), int(hex_digits[2:4], 16), int(hex_digits[4:6], 16))
    return DEFAULT_TITLE_COLOR


# Mirrors render.py's CAPTION_STYLES exactly. Duplicated here (not imported
# from render.py) to avoid a circular import: render.py will import
# resolve_caption_style from this module in the next task.
_CAPTION_STYLE_PRESETS: dict[str, dict[str, str]] = {
    "default": {"primary": "&H00FFFFFF", "highlight": "&H0000FFFF", "outline": "&H00000000"},
    "energetic": {"primary": "&H00FFFFFF", "highlight": "&H000080FF", "outline": "&H00000000"},
    "warning": {"primary": "&H0080FFFF", "highlight": "&H000000FF", "outline": "&H00000000"},
}


def resolve_caption_style(style_value: str | None) -> dict[str, str]:
    if not style_value:
        return _CAPTION_STYLE_PRESETS["default"]
    if style_value in _CAPTION_STYLE_PRESETS:
        return _CAPTION_STYLE_PRESETS[style_value]
    match = _HEX_RE.match(style_value)
    if match:
        hex_digits = match.group(1)
        r, g, b = hex_digits[0:2], hex_digits[2:4], hex_digits[4:6]
        # ASS colors are &HAABBGGRR (alpha-blue-green-red); no alpha override
        # here, matching the existing presets' leading "00".
        primary = f"&H00{b.upper()}{g.upper()}{r.upper()}"
        return {"primary": primary, "highlight": _CAPTION_STYLE_PRESETS["default"]["highlight"], "outline": _CAPTION_STYLE_PRESETS["default"]["outline"]}
    return _CAPTION_STYLE_PRESETS["default"]
