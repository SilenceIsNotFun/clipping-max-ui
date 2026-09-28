# Title & Caption Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator choose a font and color for the title overlay, and a font, color, and approximate position for captions, per segment — each falling back to today's exact default when unset.

**Architecture:** video-worker gains three small resolution modules (font, color, caption-position) that turn a segment's raw field values into plain, render-ready data (a file path, an RGB tuple, an ASS alignment/margin set); the existing `render_title_png`/`_write_ass` functions accept this resolved data as new optional parameters with no other change to their bodies. Fonts resolve through three forms — a bundled preset, a downloaded URL, or an uploaded file — cached once and reused. Captions keep their existing ASS-based karaoke rendering; position is approximated to the nearest ASS alignment/margin rather than a literal pixel coordinate.

**Tech Stack:** Pillow (title, unchanged), libass via ffmpeg's `subtitles` filter (captions, unchanged), `fonttools` (new — reads a font file's family name so an arbitrary downloaded/uploaded font can be referenced correctly in the ASS style line), fontconfig (system font registration for bundled presets, same pattern already proven in the sibling `clipper-service` project).

**Spec:** docs/superpowers/specs/2026-09-29-title-caption-styling-design.md

## Global Constraints

- All four new fields (`title_font`, `title_color`, `caption_font`, `caption_rect`) are per-segment, matching `title_rect`/`caption_style`'s existing granularity. Note the existing, unchanged quirk this inherits: captions render ONCE for the whole concatenated video using only `ordered_segments[0]`'s values (already true for `caption_style` today) — `caption_font`/`caption_rect` follow the identical precedent, not a new limitation this plan introduces.
- Every resolution fails soft: an unrecognized value, a failed download, or an invalid font/color file falls back to today's exact current default. Nothing here may fail a render.
- Font upload accepts `.ttf`/`.otf` only.
- Font URL downloads are cached under `/app/font-cache/` (never re-downloaded once fetched) with a 10-second timeout.
- No opacity, blend-mode, gradient, or multi-color-per-word controls — solid colors only.
- The existing per-word karaoke caption highlight effect is preserved unchanged.
- When `caption_rect` is absent, the ASS output must be byte-for-byte identical to today's (`Alignment=2, MarginL=40, MarginR=40, MarginV=120`) — this must be pinned by a test.

## Review Focus

- A font resolution that silently returns a bad or empty path/family name must not crash the render (Pillow `ImageFont.truetype` raising `OSError` on a corrupt file; ffmpeg producing no visible captions if libass can't find the named family) — every fallback path needs its own test, not just the happy path.
- An invalid or malformed hex color string (`#GGGGGG`, `#FFF`, `not-a-color`) must fall back cleanly, not crash the render or produce a malformed ASS/RGB value.
- A `caption_rect` at each extreme (top-left corner, bottom-right corner, dead center) must produce sane, distinct ASS alignment/margin values — an untested conversion function is exactly the kind of thing that silently produces the same output for every input.
- Re-requesting the same font URL twice must not re-download it (the whole point of caching) — an implementation that "works" but re-fetches every render would defeat the design's own stated goal.
- An uploaded font file that isn't actually a valid font (e.g., a renamed `.txt` file with a `.ttf` extension) must be caught — either at upload time (extension/content check) or gracefully at render time (fonttools failing to parse it), never crashing either the upload route or the render.

---

### Task 1: video-worker — bundle Anton & Montserrat, register via fontconfig, add fonttools

**Files:**
- Modify: `apps/video-worker/Dockerfile`
- Modify: `apps/video-worker/requirements.txt`

**Interfaces:**
- Produces: two font files on disk in the built image, both usable directly by path (for Pillow/title) and resolvable by fontconfig via family name (for libass/captions): `/app/fonts/Anton-Regular.ttf` (family `"Anton"`) and `/app/fonts/Montserrat-Bold.ttf` (family `"Montserrat"`). `fonttools` importable as `from fontTools.ttLib import TTFont`.

- [ ] **Step 1: Add `fonttools` to requirements**

In `apps/video-worker/requirements.txt`, add:
```
fonttools==4.54.1
```

- [ ] **Step 2: Bundle and register the fonts in the Dockerfile**

Read the current `apps/video-worker/Dockerfile` in full first. Add `fontconfig` to the existing `apt-get install -y --no-install-recommends` list (alongside `ffmpeg`, `fonts-dejavu-core`, `curl`, `unzip`) — libass needs it to resolve font family names by name, exactly the reason the sibling `clipper-service` project already added it for the identical purpose.

Add this block after the existing Piper voice-download `RUN` block and before the Deno install block:
```dockerfile
# Anton and Montserrat Bold (both Google Fonts, OFL-licensed, freely
# redistributable) -- bundled as title/caption font presets. Registered both
# as plain files under /app/fonts (Pillow loads a font by direct file path)
# and via fontconfig (libass, used by ffmpeg's `subtitles` filter for
# captions, resolves fonts by family name, not by path). Montserrat ships
# from Google as a variable font with no separate "Montserrat Bold" file in
# the repo, so the specific static Bold instance is pulled via the CSS2 API
# (which always points at the current fonts.gstatic.com URL for that weight)
# rather than hardcoding a gstatic hash that can rotate -- this exact
# approach is already proven working in the sibling clipper-service project.
RUN mkdir -p /app/fonts /usr/share/fonts/truetype/crf \
    && curl -fsSL -o /app/fonts/Anton-Regular.ttf \
        https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf \
    && montserrat_bold_url=$(curl -fsSL -A "Mozilla/5.0" \
        "https://fonts.googleapis.com/css2?family=Montserrat:wght@700&display=swap" \
        | grep -o 'https://fonts.gstatic.com/[^)]*') \
    && curl -fsSL -o /app/fonts/Montserrat-Bold.ttf "$montserrat_bold_url" \
    && cp /app/fonts/Anton-Regular.ttf /app/fonts/Montserrat-Bold.ttf /usr/share/fonts/truetype/crf/ \
    && fc-cache -f /usr/share/fonts/truetype/crf
```

- [ ] **Step 3: Build and verify**

Run: `cd apps/video-worker && docker build -t crf-video-worker-fonts-check -f Dockerfile .` (from `apps/video-worker`, or use `docker compose -f docker/docker-compose.yml build video-worker` from the repo root — either works, but the build must actually succeed, matching this project's established lesson that a passing test suite alone does not prove a Dockerfile change works).

Then verify both registration paths work:
```bash
docker run --rm crf-video-worker-fonts-check ls /app/fonts/Anton-Regular.ttf /app/fonts/Montserrat-Bold.ttf
docker run --rm crf-video-worker-fonts-check fc-list | grep -i -E "anton|montserrat"
```
Expected: both files listed by `ls`, and `fc-list` shows both family names (`Anton`, `Montserrat`).

- [ ] **Step 4: Commit**

```bash
git add apps/video-worker/Dockerfile apps/video-worker/requirements.txt
git commit -m "feat(video-worker): bundle Anton/Montserrat fonts and fonttools dependency"
```

---

### Task 2: video-worker — font resolution module

**Files:**
- Create: `apps/video-worker/font_resolution.py`
- Test: `apps/video-worker/tests/test_font_resolution.py`

**Interfaces:**
- Consumes: nothing from earlier tasks at the code level (Task 1's bundled files are referenced by the constants this task defines).
- Produces: `resolve_title_font(value: Optional[str]) -> Optional[str]` — returns an absolute file path for Pillow to load, or `None` if resolution fails or `value` is falsy (the caller then uses its own existing default). `resolve_caption_font(value: Optional[str]) -> str` — always returns a usable ASS font family name (never `None`; falls back to `"DejaVu Sans"`, the current hardcoded value).

- [ ] **Step 1: Write the failing tests**

Create `apps/video-worker/tests/test_font_resolution.py`:
```python
import hashlib
import os
from unittest.mock import MagicMock, patch

import pytest


def test_resolve_title_font_returns_none_for_empty_value():
    from font_resolution import resolve_title_font

    assert resolve_title_font(None) is None
    assert resolve_title_font("") is None


def test_resolve_title_font_returns_bundled_path_for_known_preset():
    from font_resolution import resolve_title_font

    assert resolve_title_font("anton") == "/app/fonts/Anton-Regular.ttf"
    assert resolve_title_font("montserrat") == "/app/fonts/Montserrat-Bold.ttf"


def test_resolve_title_font_returns_none_for_unknown_preset():
    from font_resolution import resolve_title_font

    assert resolve_title_font("not-a-real-preset") is None


def test_resolve_title_font_returns_existing_local_path_directly():
    from font_resolution import resolve_title_font

    with patch("font_resolution.os.path.isfile", return_value=True):
        assert resolve_title_font("/app/video-assets/fonts/abc.ttf") == "/app/video-assets/fonts/abc.ttf"


def test_resolve_title_font_returns_none_for_nonexistent_local_path():
    from font_resolution import resolve_title_font

    with patch("font_resolution.os.path.isfile", return_value=False):
        assert resolve_title_font("/app/video-assets/fonts/does-not-exist.ttf") is None


def test_resolve_title_font_downloads_and_caches_url(tmp_path, monkeypatch):
    from font_resolution import resolve_title_font

    monkeypatch.setattr("font_resolution.FONT_CACHE_DIR", str(tmp_path))
    url = "https://example.com/MyFont.ttf"
    expected_cache_path = os.path.join(str(tmp_path), hashlib.sha256(url.encode()).hexdigest() + ".ttf")

    mock_response = MagicMock()
    mock_response.read.return_value = b"fake-font-bytes"
    mock_response.__enter__.return_value = mock_response
    with patch("font_resolution.urllib.request.urlopen", return_value=mock_response) as mock_urlopen:
        result = resolve_title_font(url)
        assert result == expected_cache_path
        assert os.path.exists(expected_cache_path)
        mock_urlopen.assert_called_once()

    # Second call must NOT re-download -- the cached file already exists.
    with patch("font_resolution.urllib.request.urlopen") as mock_urlopen_2:
        result2 = resolve_title_font(url)
        assert result2 == expected_cache_path
        mock_urlopen_2.assert_not_called()


def test_resolve_title_font_returns_none_on_download_failure(tmp_path, monkeypatch):
    from font_resolution import resolve_title_font

    monkeypatch.setattr("font_resolution.FONT_CACHE_DIR", str(tmp_path))
    with patch("font_resolution.urllib.request.urlopen", side_effect=OSError("connection refused")):
        assert resolve_title_font("https://example.com/dead-link.ttf") is None


def test_resolve_caption_font_returns_default_for_empty_value():
    from font_resolution import resolve_caption_font

    assert resolve_caption_font(None) == "DejaVu Sans"
    assert resolve_caption_font("") == "DejaVu Sans"


def test_resolve_caption_font_returns_bundled_family_name_for_known_preset():
    from font_resolution import resolve_caption_font

    assert resolve_caption_font("anton") == "Anton"
    assert resolve_caption_font("montserrat") == "Montserrat"


def test_resolve_caption_font_extracts_family_name_from_a_resolved_font_file(tmp_path, monkeypatch):
    from font_resolution import resolve_caption_font

    monkeypatch.setattr("font_resolution.FONT_CACHE_DIR", str(tmp_path))
    fake_font_path = str(tmp_path / "custom.ttf")
    with open(fake_font_path, "wb") as f:
        f.write(b"fake-font-bytes")

    mock_ttfont = MagicMock()
    mock_name_record = MagicMock()
    mock_name_record.toUnicode.return_value = "My Custom Font"
    mock_ttfont.__getitem__.return_value.getDebugName.return_value = "My Custom Font"

    with patch("font_resolution.os.path.isfile", return_value=True), patch(
        "font_resolution.TTFont", return_value=mock_ttfont
    ):
        assert resolve_caption_font(fake_font_path) == "My Custom Font"


def test_resolve_caption_font_falls_back_to_default_when_family_name_extraction_fails(tmp_path, monkeypatch):
    from font_resolution import resolve_caption_font

    monkeypatch.setattr("font_resolution.FONT_CACHE_DIR", str(tmp_path))
    fake_font_path = str(tmp_path / "corrupt.ttf")
    with open(fake_font_path, "wb") as f:
        f.write(b"not a real font file")

    with patch("font_resolution.os.path.isfile", return_value=True), patch(
        "font_resolution.TTFont", side_effect=Exception("bad font data")
    ):
        assert resolve_caption_font(fake_font_path) == "DejaVu Sans"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_font_resolution.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'font_resolution'`.

- [ ] **Step 3: Implement**

Create `apps/video-worker/font_resolution.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_font_resolution.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/font_resolution.py apps/video-worker/tests/test_font_resolution.py
git commit -m "feat(video-worker): add font resolution module (preset/URL/upload, title+caption)"
```

---

### Task 3: video-worker — wire resolved font/color into `render_title_png`

**Files:**
- Create: `apps/video-worker/color_resolution.py`
- Modify: `apps/video-worker/title_render.py`
- Test: `apps/video-worker/tests/test_color_resolution.py`
- Test: `apps/video-worker/tests/test_title_render.py`

**Interfaces:**
- Consumes: `resolve_title_font` (Task 2).
- Produces: `resolve_title_color(value: Optional[str]) -> tuple[int, int, int]` (always returns a usable RGB tuple, default `(255, 255, 255)` — today's white). `render_title_png(title_text, output_path, rect=None, font_path=None, color=None)` — two new optional parameters; when both are `None`, output is byte-for-byte identical to today's.

- [ ] **Step 1: Write the failing color-resolution tests**

Create `apps/video-worker/tests/test_color_resolution.py`:
```python
def test_resolve_title_color_defaults_to_white_for_empty_value():
    from color_resolution import resolve_title_color

    assert resolve_title_color(None) == (255, 255, 255)
    assert resolve_title_color("") == (255, 255, 255)


def test_resolve_title_color_returns_preset_rgb():
    from color_resolution import resolve_title_color

    assert resolve_title_color("yellow") == (255, 221, 0)
    assert resolve_title_color("black") == (0, 0, 0)
    assert resolve_title_color("red") == (220, 38, 38)


def test_resolve_title_color_parses_valid_hex():
    from color_resolution import resolve_title_color

    assert resolve_title_color("#00FF80") == (0, 255, 128)
    assert resolve_title_color("#abc123") == (171, 193, 35)


def test_resolve_title_color_falls_back_to_white_for_invalid_value():
    from color_resolution import resolve_title_color

    assert resolve_title_color("not-a-color") == (255, 255, 255)
    assert resolve_title_color("#GGGGGG") == (255, 255, 255)
    assert resolve_title_color("#FFF") == (255, 255, 255)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_color_resolution.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'color_resolution'`.

- [ ] **Step 3: Implement `color_resolution.py`**

Create `apps/video-worker/color_resolution.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_color_resolution.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Write the failing `render_title_png` tests**

Add to `apps/video-worker/tests/test_title_render.py`:
```python
def test_render_title_png_uses_default_font_and_color_when_none_given(tmp_path):
    from title_render import render_title_png

    output_path = str(tmp_path / "title.png")
    render_title_png("Hello", output_path)
    # This must produce byte-for-byte the same output as before this task --
    # compare against a second call with explicit None args (the old signature's
    # implicit default), which is exactly what render_video will keep doing for
    # any segment with no title_font/title_color set.
    output_path_explicit = str(tmp_path / "title_explicit.png")
    render_title_png("Hello", output_path_explicit, rect=None, font_path=None, color=None)
    assert open(output_path, "rb").read() == open(output_path_explicit, "rb").read()


def test_render_title_png_uses_custom_color(tmp_path):
    from PIL import Image

    from title_render import render_title_png

    output_path = str(tmp_path / "title.png")
    render_title_png("Hello", output_path, color=(0, 255, 0))
    img = Image.open(output_path)
    pixels = list(img.getdata())
    # At least one non-transparent pixel must carry the custom green fill
    # (allowing for anti-aliasing means checking the green channel dominates
    # rather than an exact RGB match on every pixel).
    green_pixels = [p for p in pixels if p[3] > 200 and p[1] > 200 and p[0] < 100 and p[2] < 100]
    assert len(green_pixels) > 0


def test_render_title_png_falls_back_to_default_font_on_invalid_font_path(tmp_path):
    from title_render import render_title_png

    bad_font_path = str(tmp_path / "not-a-font.ttf")
    with open(bad_font_path, "w") as f:
        f.write("this is not a font file")

    output_path = str(tmp_path / "title.png")
    # Must not raise -- an invalid font_path falls back to the default loader.
    render_title_png("Hello", output_path, font_path=bad_font_path)
    assert os.path.exists(output_path)
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_title_render.py -v -k "font_and_color or custom_color or invalid_font"`
Expected: FAIL — `render_title_png() got an unexpected keyword argument 'font_path'`.

- [ ] **Step 7: Implement**

In `apps/video-worker/title_render.py`, change:
```python
def _load_font() -> ImageFont.FreeTypeFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, FONT_SIZE)
        except OSError:
            continue
    return ImageFont.load_default()


def render_title_png(title_text: str, output_path: str, rect: Optional[CropRect] = None) -> None:
```
to:
```python
def _load_font(font_path: Optional[str] = None) -> ImageFont.FreeTypeFont:
    candidates = [
        font_path,
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        if not path:
            continue
        try:
            return ImageFont.truetype(path, FONT_SIZE)
        except OSError:
            continue
    return ImageFont.load_default()


def render_title_png(
    title_text: str,
    output_path: str,
    rect: Optional[CropRect] = None,
    font_path: Optional[str] = None,
    color: Optional[tuple[int, int, int]] = None,
) -> None:
```
Change the docstring's closing sentence and the body: replace
```python
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _load_font()
```
with
```python
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _load_font(font_path)
    fill_color = (color or (255, 255, 255)) + (255,)
```
and change the second `draw.text(...)` call's `fill=(255, 255, 255, 255)` to `fill=fill_color` (leave the shadow `draw.text(...)` call above it, with `fill=(0, 0, 0, 160)`, unchanged — the drop shadow stays black regardless of title color, matching the existing visual design).

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_title_render.py tests/test_color_resolution.py -v`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/video-worker/color_resolution.py apps/video-worker/title_render.py apps/video-worker/tests/test_color_resolution.py apps/video-worker/tests/test_title_render.py
git commit -m "feat(video-worker): add color resolution and wire font/color into render_title_png"
```

---

### Task 4: video-worker — caption color resolution (hex override on existing presets)

**Files:**
- Modify: `apps/video-worker/color_resolution.py`
- Modify: `apps/video-worker/render.py`
- Test: `apps/video-worker/tests/test_color_resolution.py`
- Test: `apps/video-worker/tests/test_render.py`

**Interfaces:**
- Produces: `resolve_caption_style(style_value: Optional[str]) -> dict[str, str]` — returns the same 3-key shape (`primary`/`highlight`/`outline`) `CAPTION_STYLES` values already have, so `_write_ass`'s existing body needs zero other changes.

- [ ] **Step 1: Write the failing tests**

Add to `apps/video-worker/tests/test_color_resolution.py`:
```python
def test_resolve_caption_style_returns_named_preset():
    from color_resolution import resolve_caption_style

    assert resolve_caption_style("energetic") == {
        "primary": "&H00FFFFFF",
        "highlight": "&H000080FF",
        "outline": "&H00000000",
    }


def test_resolve_caption_style_defaults_for_empty_or_unknown_value():
    from color_resolution import resolve_caption_style

    default = {"primary": "&H00FFFFFF", "highlight": "&H0000FFFF", "outline": "&H00000000"}
    assert resolve_caption_style(None) == default
    assert resolve_caption_style("") == default
    assert resolve_caption_style("not-a-real-style") == default


def test_resolve_caption_style_accepts_hex_as_primary_color_override():
    from color_resolution import resolve_caption_style

    result = resolve_caption_style("#00FF80")
    # ASS colors are &HBBGGRR (blue-green-red, reversed from RGB hex order).
    assert result["primary"] == "&H0080FF00"
    # Outline stays at the default preset's outline -- a lone hex value only
    # overrides the primary/text color, it doesn't need to also specify an
    # outline.
    assert result["outline"] == "&H00000000"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_color_resolution.py -v -k caption_style`
Expected: FAIL — `ImportError: cannot import name 'resolve_caption_style'`.

- [ ] **Step 3: Implement**

In `apps/video-worker/color_resolution.py`, add (this duplicates the 3 named presets from `render.py`'s `CAPTION_STYLES` deliberately — read the note in the code comment below for why):
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_color_resolution.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Replace `render.py`'s inline `CAPTION_STYLES` lookup**

Read `apps/video-worker/render.py`'s `_write_ass` function in full first. Change:
```python
def _write_ass(caption_words: list[CaptionWord], style_name: str, ass_path: str) -> None:
    ...
    style = CAPTION_STYLES.get(style_name, CAPTION_STYLES["default"])
```
to:
```python
def _write_ass(caption_words: list[CaptionWord], style_name: str, ass_path: str) -> None:
    ...
    style = resolve_caption_style(style_name)
```
Add the import at the top of `render.py`:
```python
from color_resolution import resolve_caption_style
```
Leave the module-level `CAPTION_STYLES` dict in `render.py` as-is for now (it's unused after this change but removing it is a separate, unrelated cleanup — not in scope for this task; a later task in this plan does NOT touch it either, so it will remain harmlessly present).

Add a test to `apps/video-worker/tests/test_render.py` confirming the existing named-preset behavior still works unchanged through the new code path — read the file's existing `_write_ass` tests (if any) first to match conventions; if none exist, add:
```python
def test_write_ass_still_uses_named_presets_via_resolve_caption_style():
    from render import _write_ass
    from schemas import CaptionWord

    words = [CaptionWord(word="hi", start_ms=0, end_ms=500)]
    ass_path = "/tmp/test_write_ass_preset.ass"
    _write_ass(words, "energetic", ass_path)
    with open(ass_path) as f:
        content = f.read()
    assert "&H000080FF" in content  # energetic preset's highlight color
    os.remove(ass_path)
```
(Add `import os` to the top of the test file if not already present.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_render.py -v -k write_ass`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/video-worker/color_resolution.py apps/video-worker/render.py apps/video-worker/tests/test_color_resolution.py apps/video-worker/tests/test_render.py
git commit -m "feat(video-worker): add caption color hex override via resolve_caption_style"
```

---

### Task 5: video-worker — caption position resolution

**Files:**
- Create: `apps/video-worker/caption_position.py`
- Test: `apps/video-worker/tests/test_caption_position.py`

**Interfaces:**
- Produces: `rect_to_ass_position(rect: Optional[CropRect]) -> dict[str, int]` — returns `{"alignment": int, "margin_l": int, "margin_r": int, "margin_v": int}`. When `rect` is `None`, returns exactly `{"alignment": 2, "margin_l": 40, "margin_r": 40, "margin_v": 120}` (today's hardcoded values, byte-for-byte).

- [ ] **Step 1: Write the failing tests**

Create `apps/video-worker/tests/test_caption_position.py`:
```python
from schemas import CropRect


def test_rect_to_ass_position_returns_current_default_when_rect_is_none():
    from caption_position import rect_to_ass_position

    assert rect_to_ass_position(None) == {"alignment": 2, "margin_l": 40, "margin_r": 40, "margin_v": 120}


def test_rect_to_ass_position_top_left():
    from caption_position import rect_to_ass_position

    # A rect anchored at the top-left eighth of the frame.
    rect = CropRect(x=0.0, y=0.0, width=0.3, height=0.1)
    result = rect_to_ass_position(rect)
    # ASS numpad alignment: 7 = top-left.
    assert result["alignment"] == 7


def test_rect_to_ass_position_bottom_right():
    from caption_position import rect_to_ass_position

    rect = CropRect(x=0.7, y=0.9, width=0.3, height=0.1)
    result = rect_to_ass_position(rect)
    # ASS numpad alignment: 3 = bottom-right.
    assert result["alignment"] == 3


def test_rect_to_ass_position_dead_center():
    from caption_position import rect_to_ass_position

    rect = CropRect(x=0.4, y=0.45, width=0.2, height=0.1)
    result = rect_to_ass_position(rect)
    # ASS numpad alignment: 5 = middle-center.
    assert result["alignment"] == 5


def test_rect_to_ass_position_margins_scale_with_rect_position():
    from caption_position import rect_to_ass_position

    # A rect near the very bottom edge should produce a small margin_v
    # (little gap from the bottom of the 1920px-tall canvas); a rect higher
    # up should produce a larger margin_v.
    near_bottom = rect_to_ass_position(CropRect(x=0.3, y=0.95, width=0.4, height=0.05))
    higher_up = rect_to_ass_position(CropRect(x=0.3, y=0.7, width=0.4, height=0.05))
    assert near_bottom["margin_v"] < higher_up["margin_v"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_caption_position.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'caption_position'`.

- [ ] **Step 3: Implement**

Create `apps/video-worker/caption_position.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_caption_position.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/caption_position.py apps/video-worker/tests/test_caption_position.py
git commit -m "feat(video-worker): add caption_rect-to-ASS-alignment approximation"
```

---

### Task 6: video-worker — wire font/color/position into `_write_ass` and the `subtitles` filter

**Files:**
- Modify: `apps/video-worker/render.py`
- Modify: `apps/video-worker/schemas.py`
- Test: `apps/video-worker/tests/test_render.py`

**Interfaces:**
- Consumes: `resolve_caption_font` (Task 2), `resolve_caption_style` (Task 4), `rect_to_ass_position` (Task 5), `resolve_title_font`/`resolve_title_color` (Tasks 2-3).
- Produces: `RenderSegmentInput` gains `title_font: Optional[str] = None`, `title_color: Optional[str] = None`, `caption_font: Optional[str] = None`, `caption_rect: Optional[CropRect] = None`. `_write_ass` and the two `subtitles` filter invocations use them (still sourced from `ordered_segments[0]`, matching `caption_style`'s existing precedent exactly).

- [ ] **Step 1: Add the new schema fields**

In `apps/video-worker/schemas.py`, add to `RenderSegmentInput` (alongside the existing `title_rect`/`caption_style` fields):
```python
    title_font: Optional[str] = None
    title_color: Optional[str] = None
    caption_font: Optional[str] = None
    caption_rect: Optional[CropRect] = None
```

- [ ] **Step 2: Write the failing tests**

Read `apps/video-worker/render.py`'s `render_video` and `_write_ass` functions, and the two `subtitles` filter lines, in full first (confirm exact current line numbers before editing — this file has grown across several prior sub-projects). Add to `apps/video-worker/tests/test_render.py`:
```python
def test_write_ass_accepts_font_and_position_overrides():
    from render import _write_ass
    from schemas import CaptionWord, CropRect

    words = [CaptionWord(word="hi", start_ms=0, end_ms=500)]
    ass_path = "/tmp/test_write_ass_overrides.ass"
    _write_ass(
        words,
        "default",
        ass_path,
        font_value="anton",
        position=CropRect(x=0.0, y=0.0, width=0.3, height=0.1),
    )
    with open(ass_path) as f:
        content = f.read()
    assert "Anton" in content
    assert "Alignment" not in content or ",7," in content  # numpad alignment 7 (top-left) present in the Style line
    os.remove(ass_path)


def test_write_ass_uses_defaults_when_font_value_and_position_are_none():
    from render import _write_ass
    from schemas import CaptionWord

    words = [CaptionWord(word="hi", start_ms=0, end_ms=500)]
    ass_path = "/tmp/test_write_ass_defaults.ass"
    _write_ass(words, "default", ass_path, font_value=None, position=None)
    with open(ass_path) as f:
        content = f.read()
    assert "DejaVu Sans" in content
    assert ",2,40,40,120," in content  # today's exact default Alignment/margins
    os.remove(ass_path)
```
(Adapt the `Alignment` assertion above to match the ASS `Style:` line's actual comma-separated field order once you've re-read the file — the Format line is `Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding`, so assert on the substring that actually appears given the other fixed values in that line.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_render.py -v -k "font_and_position or defaults_when_font"`
Expected: FAIL — `_write_ass() got an unexpected keyword argument 'font_value'`.

- [ ] **Step 4: Implement `_write_ass`'s new parameters**

In `apps/video-worker/render.py`, add the imports:
```python
from caption_position import rect_to_ass_position
from font_resolution import resolve_caption_font
```
Change:
```python
def _write_ass(caption_words: list[CaptionWord], style_name: str, ass_path: str) -> None:
    ...
    style = resolve_caption_style(style_name)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 2\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,DejaVu Sans,72,{style['primary']},{style['outline']},1,1,3,0,2,40,40,120,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
```
to:
```python
def _write_ass(
    caption_words: list[CaptionWord],
    style_name: str,
    ass_path: str,
    font_value: str | None = None,
    position: "CropRect | None" = None,
) -> None:
    ...
    style = resolve_caption_style(style_name)
    font_family = resolve_caption_font(font_value)
    pos = rect_to_ass_position(position)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 2\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_family},72,{style['primary']},{style['outline']},1,1,3,0,"
        f"{pos['alignment']},{pos['margin_l']},{pos['margin_r']},{pos['margin_v']},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
```
(The rest of `_write_ass`'s body — the per-line/per-word loop — is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_render.py -v -k "font_and_position or defaults_when_font"`
Expected: PASS.

- [ ] **Step 6: Wire `render_video`'s call site and the `subtitles` filter's `fontsdir`**

In `apps/video-worker/render.py`'s `render_video`, find:
```python
    caption_style = (
        ordered_segments[0].caption_style if ordered_segments and ordered_segments[0].caption_style else "default"
    )
    ass_path = os.path.join(work_dir, "captions.ass")
    _write_ass(all_caption_words, caption_style, ass_path)
```
and change to:
```python
    caption_style = (
        ordered_segments[0].caption_style if ordered_segments and ordered_segments[0].caption_style else "default"
    )
    caption_font = ordered_segments[0].caption_font if ordered_segments else None
    caption_rect = ordered_segments[0].caption_rect if ordered_segments else None
    ass_path = os.path.join(work_dir, "captions.ass")
    _write_ass(all_caption_words, caption_style, ass_path, font_value=caption_font, position=caption_rect)
```
Find the two identical lines:
```python
        video_filter = f"[0:v]subtitles='{escaped_ass_path}'[v]"
```
(one in the with-music branch, one in the without-music branch) and change BOTH to include `fontsdir`, so a downloaded/uploaded custom caption font (cached under `FONT_CACHE_DIR`, not system-registered) is still found by libass:
```python
        escaped_fontsdir = FONT_CACHE_DIR.replace("\\", "\\\\").replace("'", "'\\''")
        video_filter = f"[0:v]subtitles='{escaped_ass_path}':fontsdir='{escaped_fontsdir}'[v]"
```
Add the import: `from font_resolution import FONT_CACHE_DIR` (alongside the `resolve_caption_font` import added in Step 4).

- [ ] **Step 7: Wire `_render_single_segment`'s title call site**

Find:
```python
    title_overlay_path = None
    if segment.title_text:
        title_overlay_path = os.path.join(work_dir, f"segment_{index}_title.png")
        render_title_png(segment.title_text, title_overlay_path, segment.title_rect)
```
and change to:
```python
    title_overlay_path = None
    if segment.title_text:
        title_overlay_path = os.path.join(work_dir, f"segment_{index}_title.png")
        render_title_png(
            segment.title_text,
            title_overlay_path,
            segment.title_rect,
            font_path=resolve_title_font(segment.title_font),
            color=resolve_title_color(segment.title_color),
        )
```
Add the import: `from font_resolution import resolve_title_font` and `from color_resolution import resolve_title_color` (alongside the other new imports).

- [ ] **Step 8: Run the full test suite**

Run: `cd apps/video-worker && python3 -m pytest tests/ -v`
Expected: all tests pass except pre-existing environmental failures already documented throughout this project's history (missing ffmpeg/ffprobe/piper binaries on a bare host — verify via Docker if the bare host lacks them, this project's established fallback).

- [ ] **Step 9: Commit**

```bash
git add apps/video-worker/render.py apps/video-worker/schemas.py apps/video-worker/tests/test_render.py
git commit -m "feat(video-worker): thread resolved font/color/position into caption and title rendering"
```

---

### Task 7: api — DB schema + font upload route

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Create: `apps/api/src/routes/fonts.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/db.test.ts`
- Test: `apps/api/tests/fonts.test.ts`

**Interfaces:**
- Produces: `segment_assignments` gains `title_font TEXT`, `title_color TEXT`, `caption_font TEXT`, `caption_rect TEXT` columns. `POST /api/campaigns/:id/fonts` — multipart upload, `.ttf`/`.otf` only, returns `{path: string}` where `path` is the stored file's absolute path.

- [ ] **Step 1: Write the failing schema test**

Add to `apps/api/tests/db.test.ts`:
```typescript
  it("adds title_font, title_color, caption_font, caption_rect to segment_assignments on an existing DB", () => {
    resetDbCacheForTests();
    const oldDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "old-styling-db-")), "app.db");
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        source_file_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE video_assets (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, file_path TEXT NOT NULL,
        asset_type TEXT NOT NULL, duration_seconds REAL NOT NULL,
        analysis_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
      );
      CREATE TABLE segment_assignments (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, segment_key TEXT NOT NULL,
        video_asset_id TEXT NOT NULL, secondary_video_asset_id TEXT,
        trim_start REAL NOT NULL, trim_end REAL NOT NULL, order_index INTEGER NOT NULL,
        layout_template TEXT NOT NULL, crop_gameplay_rect TEXT, crop_facecam_rect TEXT,
        title_text TEXT, caption_style TEXT, title_rect TEXT
      );
    `);
    oldDb.close();

    const reopened = getDb(oldDbPath);
    const columns = reopened.prepare("PRAGMA table_info(segment_assignments)").all().map((row: any) => row.name);
    expect(columns).toContain("title_font");
    expect(columns).toContain("title_color");
    expect(columns).toContain("caption_font");
    expect(columns).toContain("caption_rect");
    reopened.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts -t "title_font, title_color"`
Expected: FAIL — columns don't exist.

- [ ] **Step 3: Add the migration**

In `apps/api/src/db.ts`, read the existing `segmentAssignmentColumns` migration block in full first (it already handles `caption_style`/`title_rect`). Add alongside it:
```typescript
  if (!segmentAssignmentColumns.some((c) => c.name === "title_font")) {
    db.exec("ALTER TABLE segment_assignments ADD COLUMN title_font TEXT");
  }
  if (!segmentAssignmentColumns.some((c) => c.name === "title_color")) {
    db.exec("ALTER TABLE segment_assignments ADD COLUMN title_color TEXT");
  }
  if (!segmentAssignmentColumns.some((c) => c.name === "caption_font")) {
    db.exec("ALTER TABLE segment_assignments ADD COLUMN caption_font TEXT");
  }
  if (!segmentAssignmentColumns.some((c) => c.name === "caption_rect")) {
    db.exec("ALTER TABLE segment_assignments ADD COLUMN caption_rect TEXT");
  }
```
(Reuse the existing `segmentAssignmentColumns` variable already computed above — do not re-query `PRAGMA table_info` a second time.) Also add the 4 new columns to the `SCHEMA` template string's `segment_assignments` table definition, right after `title_rect TEXT` (for fresh DBs).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Add the `SegmentAssignment` type fields**

In `apps/api/src/types.ts`, add to the existing `SegmentAssignment` interface:
```typescript
  title_font: string | null;
  title_color: string | null;
  caption_font: string | null;
  caption_rect: string | null; // JSON-encoded CropRect
```

- [ ] **Step 6: Write the failing font-upload tests**

Read `apps/api/src/routes/assets.ts`'s upload route in full first (the watermark PNG/JPEG mimetype check is the pattern to mirror for `.ttf`/`.otf`). Create `apps/api/tests/fonts.test.ts`:
```typescript
import fs from "fs";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

describe("font upload route", () => {
  let dataDir: string;
  let campaignId: string;
  let dbPath: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "font-test-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;
    process.env.VIDEO_ASSETS_DIR = path.join(dataDir, "video-assets");
    resetDbCacheForTests();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    campaignId = "campaign-1";
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test", "planned", "/x.pdf", now, now);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("accepts a .ttf upload and returns a usable path", async () => {
    const app = createApp();
    const fontPath = path.join(dataDir, "MyFont.ttf");
    fs.writeFileSync(fontPath, Buffer.from("fake-ttf-bytes"));

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/fonts`)
      .attach("file", fontPath);

    expect(res.status).toBe(201);
    expect(typeof res.body.path).toBe("string");
    expect(fs.existsSync(res.body.path)).toBe(true);
  });

  it("rejects a non-font file extension", async () => {
    const app = createApp();
    const badPath = path.join(dataDir, "not-a-font.txt");
    fs.writeFileSync(badPath, "plain text");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/fonts`)
      .attach("file", badPath);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ttf|otf/i);
  });

  it("returns 400 when no file is attached", async () => {
    const app = createApp();
    const res = await request(app).post(`/api/campaigns/${campaignId}/fonts`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/fonts.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/fonts'` or a 404.

- [ ] **Step 8: Implement the route**

Create `apps/api/src/routes/fonts.ts`:
```typescript
import fs from "fs";
import path from "path";
import express, { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../asyncHandler";

export function createFontsRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const videoAssetsDir = process.env.VIDEO_ASSETS_DIR ?? "/app/video-assets";
  const fontsDir = path.join(videoAssetsDir, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });

  const upload = multer({ dest: fontsDir });

  router.post("/", upload.single("file"), asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".ttf" && ext !== ".otf") {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: "font must be a .ttf or .otf file" });
      return;
    }
    const finalPath = path.join(fontsDir, `${file.filename}${ext}`);
    fs.renameSync(file.path, finalPath);
    res.status(201).json({ path: finalPath });
  }));

  return router;
}
```

- [ ] **Step 9: Mount the router**

In `apps/api/src/server.ts`, read the existing router-mounting block in full first. Add the import:
```typescript
import { createFontsRouter } from "./routes/fonts";
```
Add the mount line alongside the other campaign-scoped routers:
```typescript
app.use("/api/campaigns/:id/fonts", createFontsRouter());
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/fonts.test.ts tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/src/routes/fonts.ts apps/api/src/server.ts apps/api/tests/db.test.ts apps/api/tests/fonts.test.ts
git commit -m "feat(api): add title/caption styling columns and font upload route"
```

---

### Task 8: api — thread styling fields through segments and render submission

**Files:**
- Modify: `apps/api/src/routes/segments.ts`
- Modify: `apps/api/src/routes/render.ts`
- Modify: `apps/api/src/services/videoWorkerClient.ts`
- Test: `apps/api/tests/segments.test.ts`
- Test: `apps/api/tests/render.test.ts`

**Interfaces:**
- Consumes: `title_font`/`title_color`/`caption_font`/`caption_rect` columns (Task 7).
- Produces: `PUT /segments` accepts and persists the 4 new fields; `RenderSegmentPayload` (videoWorkerClient.ts) and `render.ts`'s `segmentPayloads` mapping carry them through to video-worker's `/render` call exactly like `title_rect`/`caption_style` already do.

- [ ] **Step 1: Write the failing segments test**

Read `apps/api/src/routes/segments.ts`'s `SegmentPayload` interface and INSERT statement in full first. Add to `apps/api/tests/segments.test.ts` (match the file's existing `beforeEach`/`campaignId`/`assetId` conventions):
```typescript
  it("persists title_font, title_color, caption_font, and caption_rect when provided", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          {
            segment_key: "hook",
            video_asset_id: assetId,
            trim_start: 0,
            trim_end: 5,
            order_index: 0,
            layout_template: "standard",
            title_font: "anton",
            title_color: "#FFD700",
            caption_font: "montserrat",
            caption_rect: { x: 0.1, y: 0.05, width: 0.8, height: 0.1 },
          },
        ],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const row = db.prepare("SELECT * FROM segment_assignments WHERE campaign_id = ?").get(campaignId) as any;
    expect(row.title_font).toBe("anton");
    expect(row.title_color).toBe("#FFD700");
    expect(row.caption_font).toBe("montserrat");
    expect(JSON.parse(row.caption_rect)).toEqual({ x: 0.1, y: 0.05, width: 0.8, height: 0.1 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/segments.test.ts -t "title_font, title_color"`
Expected: FAIL — columns not inserted (undefined/null instead of the sent values).

- [ ] **Step 3: Implement the segments.ts changes**

In `apps/api/src/routes/segments.ts`, add to `SegmentPayload`:
```typescript
  title_font?: string;
  title_color?: string;
  caption_font?: string;
  caption_rect?: Record<string, number>;
```
Change the INSERT statement:
```typescript
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text, caption_style, title_rect)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
```
to:
```typescript
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text, caption_style, title_rect, title_font, title_color, caption_font, caption_rect)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
```
and add the 4 new arguments to the `insert.run(...)` call, matching the existing pattern for `title_rect` (`s.title_rect ? JSON.stringify(s.title_rect) : null`):
```typescript
          s.title_font ?? null,
          s.title_color ?? null,
          s.caption_font ?? null,
          s.caption_rect ? JSON.stringify(s.caption_rect) : null,
```
(Read the file first to place these in the exact same argument order as the column list above, appended after the existing `title_rect` argument.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/segments.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write the failing render.ts test**

Read `apps/api/src/services/videoWorkerClient.ts`'s `RenderSegmentPayload` interface and `apps/api/src/routes/render.ts`'s `segmentPayloads` map in full first. Add to `apps/api/tests/render.test.ts`:
```typescript
  it("includes title_font, title_color, caption_font, and caption_rect in the segment payload", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    const db = getDb(dbPath);
    db.prepare(
      "UPDATE segment_assignments SET title_font = ?, title_color = ?, caption_font = ?, caption_rect = ? WHERE campaign_id = ?"
    ).run("anton", "#FFD700", "montserrat", JSON.stringify({ x: 0.1, y: 0.05, width: 0.8, height: 0.1 }), campaignId);

    const app = createApp();
    await request(app).post(`/api/campaigns/${campaignId}/render`).send({ tts_voice: "id_ID-news_tts-medium" });

    const callArgs = (submitRender as jest.Mock).mock.calls[0];
    const segmentPayloads = callArgs[2];
    expect(segmentPayloads[0].title_font).toBe("anton");
    expect(segmentPayloads[0].title_color).toBe("#FFD700");
    expect(segmentPayloads[0].caption_font).toBe("montserrat");
    expect(segmentPayloads[0].caption_rect).toEqual({ x: 0.1, y: 0.05, width: 0.8, height: 0.1 });
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/render.test.ts -t "title_font, title_color"`
Expected: FAIL — fields not present in the mapped payload.

- [ ] **Step 7: Implement**

In `apps/api/src/services/videoWorkerClient.ts`, add to `RenderSegmentPayload`:
```typescript
  title_font?: string;
  title_color?: string;
  caption_font?: string;
  caption_rect?: Record<string, number>;
```
In `apps/api/src/routes/render.ts`'s `segmentPayloads` map, add alongside the existing `title_rect`/`caption_style` lines:
```typescript
      title_font: s.title_font ?? undefined,
      title_color: s.title_color ?? undefined,
      caption_font: s.caption_font ?? undefined,
      caption_rect: s.caption_rect ? JSON.parse(s.caption_rect) : undefined,
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/render.test.ts`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/segments.ts apps/api/src/routes/render.ts apps/api/src/services/videoWorkerClient.ts apps/api/tests/segments.test.ts apps/api/tests/render.test.ts
git commit -m "feat(api): thread title/caption styling fields through segments and render submission"
```

---

### Task 9: web-ui — `apiClient.ts` additions

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`

**Interfaces:**
- Consumes: `POST .../fonts` (Task 7).
- Produces: `SegmentDraft` gains `title_font?: string`, `title_color?: string`, `caption_font?: string`, `caption_rect?: CropRect`. `uploadFont(campaignId: string, file: File): Promise<{path: string}>`.

- [ ] **Step 1: Implement**

In `apps/web-ui/lib/apiClient.ts`, add to the `SegmentDraft` interface (alongside the existing `title_rect`/`caption_style` fields):
```typescript
  title_font?: string;
  title_color?: string;
  caption_font?: string;
  caption_rect?: CropRect;
```
Add after the existing `saveSegments` function:
```typescript
export async function uploadFont(campaignId: string, file: File): Promise<{ path: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/fonts`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `font upload failed with status ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts
git commit -m "feat(web-ui): add uploadFont and title/caption styling SegmentDraft fields"
```

---

### Task 10: web-ui — `SegmentEditor` styling controls

**Files:**
- Modify: `apps/web-ui/components/SegmentEditor.tsx`

**Interfaces:**
- Consumes: `uploadFont` (Task 9).
- Produces: font/color comboboxes for both title and caption, a file input triggering `uploadFont` and filling the combobox with the result, and a reused `CropCanvas` for `caption_rect`.

- [ ] **Step 1: Implement**

Read the current full `SegmentEditor.tsx` in full first — it has grown substantially across several prior sub-projects (Find Hooks, cut-to-clip, watermark/title positioning) and you need to see the whole thing to place these additions correctly without colliding with existing state/JSX.

Add to the imports:
```tsx
import { uploadFont } from "../lib/apiClient";
```
Add new state, alongside the existing `cutError`/`appliedHookReasoning` state:
```tsx
  const [fontUploadError, setFontUploadError] = useState<string | null>(null);

  async function handleFontUpload(e: React.ChangeEvent<HTMLInputElement>, applyTo: "title" | "caption") {
    const file = e.target.files?.[0];
    if (!file) return;
    setFontUploadError(null);
    try {
      const result = await uploadFont(campaignId, file);
      if (applyTo === "title") {
        onChange({ ...draft, title_font: result.path });
      } else {
        onChange({ ...draft, caption_font: result.path });
      }
    } catch (err) {
      setFontUploadError((err as Error).message);
    } finally {
      e.target.value = "";
    }
  }
```
Add font/color datalist constants near the existing `CAPTION_STYLES` constant:
```tsx
const FONT_PRESETS = ["dejavu", "anton", "montserrat"];
const TITLE_COLOR_PRESETS = ["white", "yellow", "black", "red"];
```
Add the styling controls to the JSX, right after the existing `{draft.title_text && asset && (...title placement CropCanvas...)}` block:
```tsx
      {draft.title_text && (
        <div className="rounded-xl border border-purple-100 bg-purple-50/40 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-600">Title styling</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <input
                list="title-font-presets"
                type="text"
                placeholder="Font (e.g. anton) or paste a link"
                value={draft.title_font ?? ""}
                onChange={(e) => onChange({ ...draft, title_font: e.target.value })}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
              />
              <datalist id="title-font-presets">
                {FONT_PRESETS.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <input type="file" accept=".ttf,.otf" onChange={(e) => handleFontUpload(e, "title")} className="text-xs" />
            </div>
            <input
              list="title-color-presets"
              type="text"
              placeholder="Color (e.g. yellow or #FFD700)"
              value={draft.title_color ?? ""}
              onChange={(e) => onChange({ ...draft, title_color: e.target.value })}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
            />
            <datalist id="title-color-presets">
              {TITLE_COLOR_PRESETS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-sky-100 bg-sky-50/40 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-600">Caption styling</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <input
              list="caption-font-presets"
              type="text"
              placeholder="Font (e.g. montserrat) or paste a link"
              value={draft.caption_font ?? ""}
              onChange={(e) => onChange({ ...draft, caption_font: e.target.value })}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            />
            <datalist id="caption-font-presets">
              {FONT_PRESETS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <input type="file" accept=".ttf,.otf" onChange={(e) => handleFontUpload(e, "caption")} className="text-xs" />
          </div>
        </div>
        {fontUploadError && (
          <p role="alert" className="mt-2 text-xs font-medium text-rose-500">
            {fontUploadError}
          </p>
        )}
        {asset && (
          <div className="mt-2 rounded-xl bg-white p-3">
            <p className="mb-2 text-xs text-slate-400">Drag a box for where captions should appear.</p>
            <CropCanvas
              imageSrc={mediaUrl(asset.file_path)}
              label="Caption placement"
              initialRect={draft.caption_rect ?? null}
              onChange={(rect: CropRect) => onChange({ ...draft, caption_rect: rect })}
            />
          </div>
        )}
      </div>
```
(The existing `caption_style` `<select>` in the `grid gap-3 sm:grid-cols-2` block stays exactly as-is — that field's semantics extend to also accept a hex value per this plan's Task 4, but the input itself is unchanged: it's already a controlled text-driven `<select>` with named options, and accepting a hex string typed by the operator requires no UI change here, only the backend resolution already built. If you want to make this discoverable, you may change that `<select>` to a `<input list=...>` combobox matching this task's other new fields' pattern, with the same 3 preset `<option>`s in a `<datalist>` — this is a reasonable, small UX improvement consistent with the rest of this task, and left to your judgment.)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Manual verification**

No component test framework in this project. If a dev server is reachable: type a title, confirm the title styling block appears with font/color inputs and a file-upload control; confirm the caption styling block and its `CropCanvas` always appear (captions exist regardless of title); upload a `.ttf` file and confirm it fills the font field with a path. If a live check isn't possible in this environment, say so honestly rather than claiming it was verified.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/SegmentEditor.tsx
git commit -m "feat(web-ui): add title/caption font, color, and position controls to segment editor"
```
