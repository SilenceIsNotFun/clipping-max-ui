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


class _StuckFakeProcess:
    """Simulates a subprocess whose stdout never produces another line and
    is never closed -- e.g. a dead socket or a wedged yt-dlp extractor. The
    only way out is for something external (the threading.Timer-driven
    kill) to call .kill(), which we model by making the stdout iterator
    raise StopIteration once killed, mimicking the killed process's stdout
    closing and unblocking `for line in proc.stdout`."""

    def __init__(self):
        self.returncode = 0
        self.killed = False

    @property
    def stdout(self):
        return self

    def __iter__(self):
        return self

    def __next__(self):
        if self.killed:
            raise StopIteration
        # Would block forever on a real stuck subprocess; the fake timer
        # below calls .kill() synchronously instead of actually waiting,
        # so this branch is never reached in the test.
        raise AssertionError("stdout iterator was consumed without a timeout firing")

    def wait(self):
        pass

    def kill(self):
        self.killed = True


def test_download_youtube_video_raises_on_timeout(monkeypatch):
    from youtube_download import download_youtube_video

    fake_proc = _StuckFakeProcess()
    monkeypatch.setattr("youtube_download.subprocess.Popen", lambda *a, **k: fake_proc)

    # Replace threading.Timer with a fake that invokes its callback
    # synchronously and immediately, instead of waiting `timeout_seconds`
    # on a real background thread. This proves download_youtube_video wires
    # up a real out-of-band timer (independent of stdout activity) without
    # the test actually sleeping.
    class _ImmediateTimer:
        def __init__(self, interval, function):
            self.interval = interval
            self.function = function

        def start(self):
            self.function()

        def cancel(self):
            pass

    monkeypatch.setattr("youtube_download.threading.Timer", _ImmediateTimer)

    with pytest.raises(RuntimeError, match="timed out"):
        download_youtube_video("https://youtube.com/watch?v=x", "/tmp/out.mp4", timeout_seconds=1800)

    assert fake_proc.killed is True
