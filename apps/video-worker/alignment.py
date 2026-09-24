from faster_whisper import WhisperModel

from schemas import CaptionWord

_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel("small", device="auto", compute_type="int8")
    return _model


def align_words(audio_path: str) -> list[CaptionWord]:
    model = _get_model()
    segments, _ = model.transcribe(audio_path, word_timestamps=True)
    words: list[CaptionWord] = []
    for segment in segments:
        for word in segment.words:
            words.append(
                CaptionWord(
                    word=word.word.strip(),
                    start_ms=int(word.start * 1000),
                    end_ms=int(word.end * 1000),
                )
            )
    return words
