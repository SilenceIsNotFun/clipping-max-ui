from PIL import Image, ImageDraw, ImageFont

CANVAS_W = 1080
CANVAS_H = 1920
FONT_SIZE = 84
TITLE_Y = 80
STROKE_WIDTH = 5
SHADOW_OFFSET = 4


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


def render_title_png(title_text: str, output_path: str) -> None:
    """Renders title_text onto a transparent 1080x1920 PNG canvas: white fill,
    black stroke, drop shadow, horizontally centered near the top. Unlike
    ffmpeg's drawtext filter, this has no filter-graph escaping concerns --
    apostrophes, colons, percent signs, etc. are handled natively by Pillow."""
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _load_font()

    bbox = draw.textbbox((0, 0), title_text, font=font, stroke_width=STROKE_WIDTH)
    text_w = bbox[2] - bbox[0]
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
        fill=(255, 255, 255, 255),
        stroke_width=STROKE_WIDTH,
        stroke_fill=(0, 0, 0, 255),
    )

    img.save(output_path, "PNG")
