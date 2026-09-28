"""Downloads a YouTube (or any yt-dlp-supported) URL to a local file.

Runs yt-dlp as a subprocess rather than using its in-process Python API --
the in-process API gives no reliable way to kill a stuck download from the
outside (a hung network call blocks forever). This mirrors the exact fix
the sibling clipper-service project needed after a real incident left a
download stuck in "processing" for 14+ hours: subprocess.Popen with a
manual, checkable deadline, so a hang can be SIGKILL'd deterministically.
"""

import os
import subprocess
import time
from typing import Callable, Optional

DOWNLOAD_TIMEOUT_SECONDS = int(os.environ.get("YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS", "1800"))


def _parse_progress_field(field: str, cast):
    # yt-dlp prints "NA" for any field it doesn't know yet (e.g. total_bytes
    # before the server reports Content-Length, or speed on the very first update).
    return cast(field) if field != "NA" else None


def download_youtube_video(
    url: str,
    output_path: str,
    on_progress: Optional[Callable[[dict], None]] = None,
    timeout_seconds: float = DOWNLOAD_TIMEOUT_SECONDS,
) -> None:
    proc = subprocess.Popen(
        [
            "yt-dlp",
            "--format",
            "bestvideo[height<=1080]+bestaudio/best",
            # Without this, yt-dlp may merge the selected streams into .mkv,
            # leaving the .mp4 we asked for absent.
            "--merge-output-format",
            "mp4",
            "--output",
            output_path,
            "--no-warnings",
            # One line per progress update (no \r overwrite-in-place), so
            # reading line-by-line below sees every update.
            "--newline",
            "--progress-template",
            "download:PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.speed)s",
            url,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    # Everything NOT recognized as a progress line, kept for the error
    # message on a non-zero exit.
    other_lines: list[str] = []
    deadline = time.monotonic() + timeout_seconds
    for line in proc.stdout:
        if time.monotonic() > deadline:
            proc.kill()
            proc.wait()
            raise RuntimeError(f"download timed out after {timeout_seconds}s")
        if line.startswith("PROGRESS "):
            _, downloaded, total, speed = line.split()
            if on_progress is not None:
                on_progress(
                    {
                        "downloaded_bytes": _parse_progress_field(downloaded, int),
                        "total_bytes": _parse_progress_field(total, int),
                        "speed_bytes_per_sec": _parse_progress_field(speed, float),
                    }
                )
        else:
            other_lines.append(line)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp exited {proc.returncode}: {''.join(other_lines)[-500:]}")
