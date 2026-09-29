"""Resolves a segment's title_font/caption_font field value into something the
respective renderer can actually use. Three recognized forms, checked in
order: a bundled preset name, an http(s) URL (downloaded once and cached),
or a local file path (from an uploaded font, already on the shared
video-assets volume). Anything else -- unset, unrecognized, or a failed
resolution -- returns None (title) or the current default family name
(caption), so a font problem degrades styling, it never fails a render.
"""

import hashlib
import os
import urllib.request

from fontTools.ttLib import TTFont

FONT_CACHE_DIR = os.environ.get("FONT_CACHE_DIR", "/app/font-cache")
DOWNLOAD_TIMEOUT_SECONDS = 10

# Preset name -> (file path for Pillow, family name for libass/fontconfig).
# Both bundled by Task 1's Dockerfile changes.
_PRESET_FONTS: dict[str, tuple[str, str]] = {
    "dejavu": ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVu Sans"),
    "anton": ("/app/fonts/Anton-Regular.ttf", "Anton"),
    "montserrat": ("/app/fonts/Montserrat-Bold.ttf", "Montserrat"),
}

DEFAULT_CAPTION_FONT_FAMILY = "DejaVu Sans"


def _cached_download_path(url: str) -> str:
    digest = hashlib.sha256(url.encode()).hexdigest()
    return os.path.join(FONT_CACHE_DIR, f"{digest}.ttf")


def _download_and_cache(url: str) -> str | None:
    cache_path = _cached_download_path(url)
    if os.path.isfile(cache_path):
        return cache_path
    try:
        os.makedirs(FONT_CACHE_DIR, exist_ok=True)
        with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            data = response.read()
        with open(cache_path, "wb") as f:
            f.write(data)
        return cache_path
    except Exception:  # noqa: BLE001 - any download/write failure is a soft fallback
        return None


def resolve_title_font(value: str | None) -> str | None:
    if not value:
        return None
    if value in _PRESET_FONTS:
        return _PRESET_FONTS[value][0]
    if value.startswith("http://") or value.startswith("https://"):
        return _download_and_cache(value)
    if os.path.isfile(value):
        return value
    return None


def resolve_caption_font(value: str | None) -> str:
    if not value:
        return DEFAULT_CAPTION_FONT_FAMILY
    if value in _PRESET_FONTS:
        return _PRESET_FONTS[value][1]

    resolved_path: str | None = None
    if value.startswith("http://") or value.startswith("https://"):
        resolved_path = _download_and_cache(value)
    elif os.path.isfile(value):
        resolved_path = value

    if resolved_path is None:
        return DEFAULT_CAPTION_FONT_FAMILY

    try:
        font = TTFont(resolved_path)
        name = font["name"].getDebugName(1)
        return name or DEFAULT_CAPTION_FONT_FAMILY
    except Exception:  # noqa: BLE001 - a corrupt/unreadable font file is a soft fallback
        return DEFAULT_CAPTION_FONT_FAMILY
