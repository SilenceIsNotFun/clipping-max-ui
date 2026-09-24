import os
from parser import parse_document

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def test_parse_pdf_extracts_text_and_links():
    result = parse_document(os.path.join(FIXTURES, "sample.pdf"), "pdf")
    assert "Reward Campaign" in result.raw_text
    assert "https://example.com/brief-video" in result.extracted_links
    assert result.parsing_confidence > 0.5


def test_parse_docx_extracts_text_and_links():
    result = parse_document(os.path.join(FIXTURES, "sample.docx"), "docx")
    assert "Reward Campaign" in result.raw_text
    assert "https://example.com/brief-video" in result.extracted_links
    assert result.parsing_confidence > 0.5


def test_parse_image_uses_ocr():
    result = parse_document(os.path.join(FIXTURES, "sample.png"), "image")
    assert "REWARD" in result.raw_text.upper()
    assert 0.0 <= result.parsing_confidence <= 1.0


def test_parse_unknown_type_raises():
    import pytest

    with pytest.raises(ValueError):
        parse_document(os.path.join(FIXTURES, "sample.pdf"), "csv")
