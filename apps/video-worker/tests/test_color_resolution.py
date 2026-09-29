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
