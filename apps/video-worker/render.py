import os

from alignment import align_words
from ffmpeg_utils import probe_duration, run_ffmpeg
from layout import build_segment_filter
from schemas import CaptionWord, RenderJobInput, RenderResult, SegmentInput
from tts import generate_tts


def _render_single_segment(
    segment, index: int, tts_voice: str, voices_dir: str, work_dir: str
) -> tuple[str, str]:
    tts_path = os.path.join(work_dir, f"segment_{index}_tts.wav")
    generate_tts(segment.script_text, tts_voice, voices_dir, tts_path)

    segment_filter_input = SegmentInput(
        layout_template=segment.layout_template,
        crop_gameplay_rect=segment.crop_gameplay_rect,
        crop_facecam_rect=segment.crop_facecam_rect,
        has_secondary=segment.secondary_file_path is not None,
        title_text=segment.title_text,
    )
    video_filter = build_segment_filter(segment_filter_input)

    trimmed_path = os.path.join(work_dir, f"segment_{index}_video.mp4")
    # ffmpeg applies -ss/-to only to the -i that immediately follows them, so
    # each input needs its own copy of the trim window -- a single leading
    # -ss/-to (as an earlier version of this function had) silently leaves
    # every input after the first untrimmed, which breaks the two-source
    # gameplay_facecam_split case (the facecam clip would play from its own
    # start instead of the operator-selected window).
    inputs = ["-ss", str(segment.trim_start), "-to", str(segment.trim_end), "-i", segment.file_path]
    if segment.secondary_file_path:
        inputs += ["-ss", str(segment.trim_start), "-to", str(segment.trim_end), "-i", segment.secondary_file_path]

    args = ["ffmpeg", "-y"] + inputs + ["-filter_complex", video_filter, "-an", trimmed_path]
    run_ffmpeg(args)
    return trimmed_path, tts_path


def _concat_video_only(video_paths: list[str], output_path: str) -> None:
    """Concat video-only streams (segments are rendered with -an, so the
    generic av-concat in ffmpeg_utils.build_concat_args does not apply)."""
    filter_inputs = "".join(f"[{i}:v]" for i in range(len(video_paths)))
    filter_complex = f"{filter_inputs}concat=n={len(video_paths)}:v=1:a=0[outv]"
    args = ["ffmpeg", "-y"]
    for path in video_paths:
        args += ["-i", path]
    args += ["-filter_complex", filter_complex, "-map", "[outv]", output_path]
    run_ffmpeg(args)


def _concat_audio_only(audio_paths: list[str], output_path: str) -> None:
    """Concat the per-segment TTS voiceover clips into one continuous track."""
    filter_inputs = "".join(f"[{i}:a]" for i in range(len(audio_paths)))
    filter_complex = f"{filter_inputs}concat=n={len(audio_paths)}:v=0:a=1[outa]"
    args = ["ffmpeg", "-y"]
    for path in audio_paths:
        args += ["-i", path]
    args += ["-filter_complex", filter_complex, "-map", "[outa]", output_path]
    run_ffmpeg(args)


def render_video(job: RenderJobInput, work_dir: str) -> RenderResult:
    ordered_segments = sorted(job.segments, key=lambda s: s.order_index)

    video_paths: list[str] = []
    tts_paths: list[str] = []
    all_caption_words: list[CaptionWord] = []
    offset_ms = 0

    for index, segment in enumerate(ordered_segments):
        video_path, tts_path = _render_single_segment(
            segment, index, job.tts_voice, job.voices_dir, work_dir
        )
        video_paths.append(video_path)
        tts_paths.append(tts_path)

        words = align_words(tts_path)
        for word in words:
            all_caption_words.append(
                CaptionWord(
                    word=word.word,
                    start_ms=word.start_ms + offset_ms,
                    end_ms=word.end_ms + offset_ms,
                )
            )
        offset_ms += int(probe_duration(video_path) * 1000)

    concat_video = os.path.join(work_dir, "concatenated_video.mp4")
    _concat_video_only(video_paths, concat_video)

    concat_voiceover = os.path.join(work_dir, "concatenated_voiceover.wav")
    _concat_audio_only(tts_paths, concat_voiceover)

    final_output = job.output_path
    if job.music_path:
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-i",
                concat_video,
                "-i",
                concat_voiceover,
                "-i",
                job.music_path,
                "-filter_complex",
                "[2:a]volume=0.2[music];[1:a][music]amix=inputs=2:duration=first[a]",
                "-map",
                "0:v",
                "-map",
                "[a]",
                "-shortest",
                final_output,
            ]
        )
    else:
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-i",
                concat_video,
                "-i",
                concat_voiceover,
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-shortest",
                final_output,
            ]
        )

    return RenderResult(output_path=final_output, caption_words=all_caption_words)
