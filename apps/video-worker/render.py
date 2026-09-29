import os

from alignment import align_words
from color_resolution import resolve_caption_style
from ffmpeg_utils import probe_duration, run_ffmpeg
from layout import build_segment_filter
from schemas import CaptionWord, CropRect, RenderJobInput, RenderResult, SegmentInput
from title_render import render_title_png
from tts import generate_tts


CAPTION_STYLES: dict[str, dict[str, str]] = {
    "default": {"primary": "&H00FFFFFF", "highlight": "&H0000FFFF", "outline": "&H00000000"},
    "energetic": {"primary": "&H00FFFFFF", "highlight": "&H000080FF", "outline": "&H00000000"},
    "warning": {"primary": "&H0080FFFF", "highlight": "&H000000FF", "outline": "&H00000000"},
}


def _format_ass_timestamp(ms: int) -> str:
    hours, rem_ms = divmod(ms, 3_600_000)
    minutes, rem_ms = divmod(rem_ms, 60_000)
    seconds, centis_ms = divmod(rem_ms, 1_000)
    centis = centis_ms // 10
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centis:02d}"


WORDS_PER_LINE = 4


def _write_ass(caption_words: list[CaptionWord], style_name: str, ass_path: str) -> None:
    """Writes an ASS (Advanced SubStation Alpha) subtitle file with karaoke-style
    per-word highlighting: consecutive words are grouped into short lines (fixed
    chunks of WORDS_PER_LINE words), and for each word's own [start, end] window
    a Dialogue event is emitted showing the FULL line, with that word wrapped in
    the highlight color override tag and the rest of the line left at the
    style's default PrimaryColour (no override tag needed there)."""
    style = resolve_caption_style(style_name)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 2\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,DejaVu Sans,72,{style['primary']},{style['outline']},1,1,3,0,2,40,40,120,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = [header]
    for line_start in range(0, len(caption_words), WORDS_PER_LINE):
        line_words = caption_words[line_start : line_start + WORDS_PER_LINE]
        for active_index, active_word in enumerate(line_words):
            parts = []
            for i, w in enumerate(line_words):
                if i == active_index:
                    parts.append(f"{{\\c{style['highlight']}}}{w.word}{{\\c{style['primary']}}}")
                else:
                    parts.append(w.word)
            text = " ".join(parts)
            start_ts = _format_ass_timestamp(active_word.start_ms)
            end_ts = _format_ass_timestamp(active_word.end_ms)
            lines.append(f"Dialogue: 0,{start_ts},{end_ts},Default,,0,0,0,,{text}\n")

    with open(ass_path, "w", encoding="utf-8") as f:
        f.writelines(lines)


def _render_single_segment(
    segment, index: int, tts_voice: str, voices_dir: str, work_dir: str
) -> tuple[str, str]:
    tts_path = os.path.join(work_dir, f"segment_{index}_tts.wav")
    generate_tts(segment.script_text, tts_voice, voices_dir, tts_path)

    title_overlay_path = None
    if segment.title_text:
        title_overlay_path = os.path.join(work_dir, f"segment_{index}_title.png")
        render_title_png(segment.title_text, title_overlay_path, segment.title_rect)

    segment_filter_input = SegmentInput(
        layout_template=segment.layout_template,
        crop_gameplay_rect=segment.crop_gameplay_rect,
        crop_facecam_rect=segment.crop_facecam_rect,
        has_secondary=segment.secondary_file_path is not None,
        title_overlay_path=title_overlay_path,
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
    if title_overlay_path:
        inputs += ["-i", title_overlay_path]

    args = ["ffmpeg", "-y"] + inputs + ["-filter_complex", video_filter, "-map", "[out]", trimmed_path]
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


def _build_watermark_filter(rect: "CropRect", base_label: str, watermark_input_index: int) -> tuple[str, int]:
    """Returns (filter graph fragment, the input index the watermark PNG
    must be added at). Scales the watermark to the rect's pixel size
    against the fixed 1080x1920 canvas and overlays it onto `base_label`,
    producing a new output label `[vout]`."""
    w = round(rect.width * 1080)
    h = round(rect.height * 1920)
    x = round(rect.x * 1080)
    y = round(rect.y * 1920)
    filter_str = (
        f";[{watermark_input_index}:v]scale={w}:{h}[wm];"
        f"[{base_label}][wm]overlay={x}:{y}[vout]"
    )
    return filter_str, watermark_input_index


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
        offset_ms += int(probe_duration(tts_path) * 1000)

    concat_video = os.path.join(work_dir, "concatenated_video.mp4")
    _concat_video_only(video_paths, concat_video)

    concat_voiceover = os.path.join(work_dir, "concatenated_voiceover.wav")
    _concat_audio_only(tts_paths, concat_voiceover)

    caption_style = (
        ordered_segments[0].caption_style if ordered_segments and ordered_segments[0].caption_style else "default"
    )
    ass_path = os.path.join(work_dir, "captions.ass")
    _write_ass(all_caption_words, caption_style, ass_path)
    escaped_ass_path = ass_path.replace("\\", "\\\\").replace("'", "'\\''")

    final_output = job.output_path
    if job.music_path:
        args = [
            "ffmpeg",
            "-y",
            "-i",
            concat_video,
            "-i",
            concat_voiceover,
            "-stream_loop",
            "-1",
            "-i",
            job.music_path,
        ]
        input_count = 3  # concat_video, concat_voiceover, music_path -- do NOT derive this from len(args); -stream_loop/-1 are extra non-input elements that throw off any arithmetic on the list length
        video_filter = f"[0:v]subtitles='{escaped_ass_path}'[v]"
        video_out_label = "v"
        if job.watermark_path and job.watermark_rect:
            args += ["-i", job.watermark_path]
            wm_filter, _ = _build_watermark_filter(job.watermark_rect, "v", input_count)
            video_filter += wm_filter
            video_out_label = "vout"
        args += [
            "-filter_complex",
            f"{video_filter};[2:a]volume=0.2[music];[1:a][music]amix=inputs=2:duration=first[a]",
            "-map",
            f"[{video_out_label}]",
            "-map",
            "[a]",
            "-shortest",
            final_output,
        ]
        run_ffmpeg(args)
    else:
        args = ["ffmpeg", "-y", "-i", concat_video, "-i", concat_voiceover]
        input_count = 2  # concat_video, concat_voiceover
        video_filter = f"[0:v]subtitles='{escaped_ass_path}'[v]"
        video_out_label = "v"
        if job.watermark_path and job.watermark_rect:
            args += ["-i", job.watermark_path]
            wm_filter, _ = _build_watermark_filter(job.watermark_rect, "v", input_count)
            video_filter += wm_filter
            video_out_label = "vout"
        args += [
            "-filter_complex",
            video_filter,
            "-map",
            f"[{video_out_label}]",
            "-map",
            "1:a",
            "-shortest",
            final_output,
        ]
        run_ffmpeg(args)

    return RenderResult(output_path=final_output, caption_words=all_caption_words)
