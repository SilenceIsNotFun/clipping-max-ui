import pytest


class _FakeProcess:
    def __init__(self, lines, returncode=0):
        self.stdout = iter(lines)
        self.returncode = returncode
        self.killed = False

    def wait(self):
        pass

    def kill(self):
        self.killed = True


def test_download_youtube_video_calls_on_progress_for_each_progress_line(monkeypatch):
    from youtube_download import download_youtube_video

    lines = [
        "PROGRESS 1000 5000 200.5\n",
        "PROGRESS 2500 5000 210.0\n",
        "[download] Destination: /tmp/out.mp4\n",
    ]
    fake_proc = _FakeProcess(lines, returncode=0)
    monkeypatch.setattr("youtube_download.subprocess.Popen", lambda *a, **k: fake_proc)

    events = []
    download_youtube_video("https://youtube.com/watch?v=x", "/tmp/out.mp4", on_progress=events.append)

    assert len(events) == 2
    assert events[0] == {"downloaded_bytes": 1000, "total_bytes": 5000, "speed_bytes_per_sec": 200.5}
    assert events[1]["downloaded_bytes"] == 2500


def test_download_youtube_video_handles_na_progress_fields(monkeypatch):
    from youtube_download import download_youtube_video

    fake_proc = _FakeProcess(["PROGRESS 500 NA NA\n"], returncode=0)
    monkeypatch.setattr("youtube_download.subprocess.Popen", lambda *a, **k: fake_proc)

    events = []
    download_youtube_video("https://youtube.com/watch?v=x", "/tmp/out.mp4", on_progress=events.append)

    assert events[0] == {"downloaded_bytes": 500, "total_bytes": None, "speed_bytes_per_sec": None}


def test_download_youtube_video_raises_on_nonzero_exit(monkeypatch):
    from youtube_download import download_youtube_video

    fake_proc = _FakeProcess(["ERROR: Video unavailable\n"], returncode=1)
    monkeypatch.setattr("youtube_download.subprocess.Popen", lambda *a, **k: fake_proc)

    with pytest.raises(RuntimeError, match="yt-dlp exited 1"):
        download_youtube_video("https://youtube.com/watch?v=x", "/tmp/out.mp4")


def test_download_youtube_video_raises_on_timeout(monkeypatch):
    from youtube_download import download_youtube_video

    fake_proc = _FakeProcess(["PROGRESS 100 NA NA\n", "PROGRESS 200 NA NA\n"], returncode=0)
    monkeypatch.setattr("youtube_download.subprocess.Popen", lambda *a, **k: fake_proc)

    # First time.monotonic() call establishes the deadline; every call after
    # reports a huge jump past it, so the loop raises on its first
    # iteration instead of processing further lines or actually sleeping.
    monotonic_values = iter([0, 10**9, 10**9, 10**9])
    monkeypatch.setattr("youtube_download.time.monotonic", lambda: next(monotonic_values, 1000))

    with pytest.raises(RuntimeError, match="timed out"):
        download_youtube_video("https://youtube.com/watch?v=x", "/tmp/out.mp4", timeout_seconds=1800)

    assert fake_proc.killed is True
