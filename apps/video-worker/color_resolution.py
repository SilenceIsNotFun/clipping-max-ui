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
