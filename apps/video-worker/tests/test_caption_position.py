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
