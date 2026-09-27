import os

from PIL import Image

from schemas import CropRect
from title_render import render_title_png


def test_render_title_png_creates_transparent_rgba_canvas(tmp_path):
    output_path = str(tmp_path / "title.png")
    render_title_png("Hello World", output_path)

    assert os.path.exists(output_path)
    img = Image.open(output_path)
    assert img.mode == "RGBA"
    assert img.size == (1080, 1920)


def test_render_title_png_draws_non_transparent_pixels(tmp_path):
    output_path = str(tmp_path / "title.png")
    render_title_png("VISIBLE TEXT", output_path)

    img = Image.open(output_path)
    alpha_channel = img.split()[-1]
    extrema = alpha_channel.getextrema()
    # At least some pixels must be non-transparent (the drawn text/stroke)
    assert extrema[1] > 0


def test_render_title_png_handles_apostrophes_and_special_chars(tmp_path):
    output_path = str(tmp_path / "title.png")
    # This must not raise -- unlike the old drawtext-based approach, PNG
    # rendering has no ffmpeg filter-graph escaping to worry about.
    render_title_png("Ryan's 100% clutch: GG!", output_path)
    assert os.path.exists(output_path)


def test_render_title_png_without_rect_uses_default_top_position(tmp_path):
    output_path = str(tmp_path / "title.png")
    render_title_png("Top Text", output_path)

    img = Image.open(output_path)
    bbox = img.split()[-1].getbbox()
    assert bbox is not None
    assert bbox[1] < 200  # near the default TITLE_Y=80


def test_render_title_png_with_rect_positions_text_at_rect_y(tmp_path):
    output_path = str(tmp_path / "title.png")
    rect = CropRect(x=0.1, y=0.8, width=0.8, height=0.1)
    render_title_png("Bottom Text", output_path, rect=rect)

    img = Image.open(output_path)
    bbox = img.split()[-1].getbbox()
    assert bbox is not None
    # y=0.8 of 1920 = 1536 -- well below the default top-of-frame position
    assert bbox[1] > 1000


def test_render_title_png_with_rect_centers_within_rect_width(tmp_path):
    output_path = str(tmp_path / "title.png")
    rect = CropRect(x=0.5, y=0.1, width=0.4, height=0.1)  # right half of the frame only
    render_title_png("Right", output_path, rect=rect)

    img = Image.open(output_path)
    bbox = img.split()[-1].getbbox()
    assert bbox is not None
    # centered within [0.5*1080, 0.9*1080] = [540, 972] -- text must start at or after 540,
    # not centered across the full 0-1080 canvas (which would start well before 540)
    assert bbox[0] >= 540
