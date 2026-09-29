from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from schemas import CropRect

CANVAS_W = 1080
CANVAS_H = 1920
FONT_SIZE = 84
TITLE_Y = 80
STROKE_WIDTH = 5
SHADOW_OFFSET = 4


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
    """Renders title_text onto a transparent 1080x1920 PNG canvas: white fill,
    black stroke, drop shadow. Unlike ffmpeg's drawtext filter, this has no
    filter-graph escaping concerns -- apostrophes, colons, percent signs,
    etc. are handled natively by Pillow.

    When `rect` is given, the text is horizontally centered within
    [rect.x*CANVAS_W, (rect.x+rect.width)*CANVAS_W] and vertically anchored
    at rect.y*CANVAS_H, instead of the default full-width-centered/fixed-Y
    position. rect.height is unused (title text is single-line)."""
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _load_font(font_path)
    fill_color = (color or (255, 255, 255)) + (255,)

    bbox = draw.textbbox((0, 0), title_text, font=font, stroke_width=STROKE_WIDTH)
    text_w = bbox[2] - bbox[0]

    if rect is not None:
        region_x0 = rect.x * CANVAS_W
        region_w = rect.width * CANVAS_W
        x = region_x0 + (region_w - text_w) / 2 - bbox[0]
        y = rect.y * CANVAS_H
    else:
        x = (CANVAS_W - text_w) / 2 - bbox[0]
        y = TITLE_Y

    draw.text(
        (x + SHADOW_OFFSET, y + SHADOW_OFFSET),
        title_text,
        font=font,
        fill=(0, 0, 0, 160),
        stroke_width=STROKE_WIDTH,
        stroke_fill=(0, 0, 0, 160),
    )
    draw.text(
        (x, y),
        title_text,
        font=font,
        fill=fill_color,
        stroke_width=STROKE_WIDTH,
        stroke_fill=(0, 0, 0, 255),
    )

    img.save(output_path, "PNG")
