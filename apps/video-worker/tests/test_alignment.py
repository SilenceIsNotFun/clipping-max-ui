from unittest.mock import MagicMock, patch

from alignment import align_words


def test_align_words_returns_word_timestamps():
    fake_word_1 = MagicMock(word=" hello", start=0.0, end=0.5)
    fake_word_2 = MagicMock(word=" world", start=0.5, end=1.0)
    fake_segment = MagicMock(words=[fake_word_1, fake_word_2])

    with patch("alignment.WhisperModel") as MockModel:
        instance = MockModel.return_value
        instance.transcribe.return_value = ([fake_segment], MagicMock())

        result = align_words("/tmp/audio.wav")

        assert len(result) == 2
        assert result[0].word == "hello"
        assert result[0].start_ms == 0
        assert result[0].end_ms == 500
        assert result[1].word == "world"
        assert result[1].start_ms == 500
        assert result[1].end_ms == 1000
        instance.transcribe.assert_called_once_with("/tmp/audio.wav", word_timestamps=True)
