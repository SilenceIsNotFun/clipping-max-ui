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


def test_resolve_caption_font_copies_an_outside_local_font_into_font_cache_dir(tmp_path, monkeypatch):
    from font_resolution import resolve_caption_font

    cache_dir = tmp_path / "font-cache"
    monkeypatch.setattr("font_resolution.FONT_CACHE_DIR", str(cache_dir))

    upload_dir = tmp_path / "video-assets" / "fonts"
    upload_dir.mkdir(parents=True)
    uploaded_font_path = str(upload_dir / "custom.ttf")
    with open(uploaded_font_path, "wb") as f:
        f.write(b"fake-font-bytes")

    mock_ttfont = MagicMock()
    mock_ttfont.__getitem__.return_value.getDebugName.return_value = "Uploaded Family"

    with patch("font_resolution.TTFont", return_value=mock_ttfont):
        family = resolve_caption_font(uploaded_font_path)

    assert family == "Uploaded Family"
    # The whole point of this fix: libass's fontsdir=FONT_CACHE_DIR must
    # actually be able to find this font file, not just the original
    # uploaded path -- so a copy must land inside FONT_CACHE_DIR.
    cached_files = list(cache_dir.iterdir()) if cache_dir.exists() else []
    assert len(cached_files) == 1
    assert cached_files[0].read_bytes() == b"fake-font-bytes"
