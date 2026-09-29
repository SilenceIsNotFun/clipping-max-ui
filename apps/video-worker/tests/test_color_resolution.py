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
