import os

from PIL import Image

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
