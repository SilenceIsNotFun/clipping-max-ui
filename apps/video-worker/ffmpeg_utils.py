import json
import subprocess


def probe_duration(file_path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            file_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def run_ffmpeg(args: list[str]) -> None:
    subprocess.run(args, capture_output=True, text=True, check=True)


def build_trim_args(input_path: str, start: float, end: float, output_path: str) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-ss",
        str(start),
        "-to",
        str(end),
        "-i",
        input_path,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        output_path,
    ]


def build_concat_args(input_paths: list[str], output_path: str) -> list[str]:
    filter_inputs = "".join(f"[{i}:v][{i}:a]" for i in range(len(input_paths)))
    filter_complex = f"{filter_inputs}concat=n={len(input_paths)}:v=1:a=1[outv][outa]"
    args = ["ffmpeg", "-y"]
    for path in input_paths:
        args += ["-i", path]
    args += [
        "-filter_complex",
        filter_complex,
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        output_path,
    ]
    return args
