# YouTube Link Asset Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator paste a YouTube URL instead of a file upload, see live download progress, and end up with a normal `footage` asset once it completes.

**Architecture:** video-worker gains a standalone `youtube_download.py` module (subprocess `yt-dlp` invocation with progress parsing and a hard timeout, adapted directly from the proven `clipper-service` reference implementation) plus a `/download-youtube` route; api gains a `youtube_download_jobs` table and trigger/status/progress-callback routes; web-ui's `AssetUpload` gains a link-vs-file mode toggle with a progress bar.

**Tech Stack:** yt-dlp (subprocess, not the in-process Python API), Deno (yt-dlp's JS-challenge solver dependency), TypeScript/Express/better-sqlite3 (api), Python/FastAPI (video-worker), Next.js/React (web-ui).

**Spec:** docs/superpowers/specs/2026-09-28-youtube-link-import-design.md

## Execution Note — sequencing against the companion plan

This plan's Tasks 8-9 modify `apps/web-ui/components/AssetUpload.tsx` and `apps/web-ui/components/SegmentEditor.tsx`, both of which the companion plan (`docs/superpowers/plans/2026-09-28-dynamic-segments-asset-categories.md`, Tasks 8 and 10) also substantially rewrites. Unlike the earlier Find Hooks/Watermark sub-projects (which shared no files and were safely built in parallel worktrees), **execute this plan after the companion plan has fully merged**, not in a parallel worktree — Tasks 8-9 below assume the companion plan's changes to these two files already exist and are written to read the files fresh rather than against any snapshot in this plan.

## Global Constraints

- Downloaded assets are always `asset_type: "footage"` (same category as an uploaded long-form video).
- Find Hooks eligibility is restricted to `asset_type === "footage"` — a `clip` or `broll` asset never offers Find Hooks.
- No video length or file size cap in this MVP, consistent with the existing upload route.
- `yt-dlp` pinned to `>=2025.1.1`; Deno installed in the video-worker Dockerfile for its JS-challenge solver — no cookie handling needed.
- `yt-dlp` runs as a subprocess (never the in-process `yt_dlp` Python API), so a hung download can be killed from outside via a hard wall-clock deadline — this is the exact fix `clipper-service` needed after a real incident left a download stuck in "processing" for 14+ hours.

## Review Focus

- A yt-dlp subprocess that hangs (network stall, an interactive prompt it's waiting on) must not block the download forever — the hard timeout must actually kill the process, not just stop reading its output.
- Progress callbacks must be throttled — yt-dlp can emit far more `PROGRESS` lines per second than are useful to persist; an unthrottled POST-per-line would hammer the api for every download.
- A cut duration/YouTube video whose actual downloaded file is unreadable by `ffprobe` (corrupt merge, unsupported codec) must surface as a clear `failed` status, not a `video_assets` row with a bogus `0` or `NaN` duration that then breaks every downstream timeline calculation.
- Deleting a `video_assets` row that a `youtube_download_jobs.result_asset_id` references must not 500 on the foreign-key constraint (the exact bug class already fixed once for `hook_suggestions` and again for `cut_jobs` in this same codebase).
- A malformed/non-URL string in the trigger request must 400 with a clear message rather than being handed to yt-dlp raw and failing confusingly deep inside the subprocess.

---

### Task 1: `youtube_download_jobs` schema + asset-delete FK safety fix

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/routes/assets.ts`
- Test: `apps/api/tests/db.test.ts`
- Test: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Produces: `youtube_download_jobs` table (`id`, `campaign_id`, `url`, `status`, `downloaded_bytes`, `total_bytes`, `speed_bytes_per_sec`, `result_asset_id`, `error_message`, `created_at`, `updated_at`). `YoutubeDownloadJob` TS interface in `types.ts`.

- [ ] **Step 1: Write the failing schema test**

Add to `apps/api/tests/db.test.ts`:
```typescript
  it("creates the youtube_download_jobs table, migrated on an existing DB", () => {
    resetDbCacheForTests();
    const oldDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "old-ytjobs-db-")), "app.db");
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        source_file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    oldDb.close();

    const reopened = getDb(oldDbPath);
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toContain("youtube_download_jobs");
    reopened.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts -t "youtube_download_jobs"`
Expected: FAIL — table doesn't exist.

- [ ] **Step 3: Add the table to the schema**

In `apps/api/src/db.ts`, add to the `SCHEMA` template string, after the `cut_jobs` table (added by the companion plan's Task 1 — if that plan hasn't merged yet when this task starts, add after `caption_words` instead and note the discrepancy):
```sql

CREATE TABLE IF NOT EXISTS youtube_download_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  downloaded_bytes INTEGER,
  total_bytes INTEGER,
  speed_bytes_per_sec REAL,
  result_asset_id TEXT REFERENCES video_assets(id),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
(No `ALTER TABLE` migration block needed — this is a brand-new table, and `CREATE TABLE IF NOT EXISTS` alone handles both fresh and pre-existing DBs, same reasoning as every other new-table addition in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Add the `YoutubeDownloadJob` type**

In `apps/api/src/types.ts`, add:
```typescript
export interface YoutubeDownloadJob {
  id: string;
  campaign_id: string;
  url: string;
  status: "pending" | "downloading" | "done" | "failed";
  downloaded_bytes: number | null;
  total_bytes: number | null;
  speed_bytes_per_sec: number | null;
  result_asset_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 6: Write the failing FK-safety test**

Read `apps/api/src/routes/assets.ts`'s existing `DELETE /:assetId` route in full first — by the time this task runs, it already deletes `moment_candidates`, `crop_suggestions`, `hook_suggestions`, and (if the companion plan has merged) `cut_jobs` rows before deleting the `video_assets` row, inside one transaction. Add to `apps/api/tests/assets.test.ts` (match the file's existing delete-test conventions exactly — reuse whatever `campaignId`/`dbPath` variable names its `beforeEach` establishes):
```typescript
  it("deletes an asset that is referenced by a youtube_download_jobs row without a foreign key error", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);
    const assetId = uploadRes.body.id;

    const db = getDb(process.env.DB_PATH as string);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO youtube_download_jobs (id, campaign_id, url, status, result_asset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("ytjob-1", campaignId, "https://youtube.com/watch?v=x", "done", assetId, now, now);

    const res = await request(app).delete(`/api/campaigns/${campaignId}/assets/${assetId}`);
    expect(res.status).toBe(204);

    const remaining = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get("ytjob-1");
    expect(remaining).toBeUndefined();
  });
```
(Confirm the exact expected success status code against this file's existing passing delete test before assuming `204` — adjust if it actually asserts a different code.)

- [ ] **Step 7: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/assets.test.ts -t "youtube_download_jobs row"`
Expected: FAIL — `SqliteError: FOREIGN KEY constraint failed`.

- [ ] **Step 8: Fix the DELETE route**

In `apps/api/src/routes/assets.ts`'s `DELETE /:assetId` route, inside the existing transaction, add:
```typescript
    db.prepare("DELETE FROM youtube_download_jobs WHERE result_asset_id = ?").run(assetId);
```
(Add this alongside the other pre-delete cleanup statements already there, before the `video_assets` row is deleted.)

- [ ] **Step 9: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/src/routes/assets.ts apps/api/tests/db.test.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): add youtube_download_jobs table and fix asset-delete FK safety"
```

---

### Task 2: video-worker — `youtube_download.py` module

**Files:**
- Create: `apps/video-worker/youtube_download.py`
- Modify: `apps/video-worker/Dockerfile`
- Modify: `apps/video-worker/requirements.txt`
- Test: `apps/video-worker/tests/test_youtube_download.py`

**Interfaces:**
- Produces: `download_youtube_video(url: str, output_path: str, on_progress: Optional[Callable[[dict], None]] = None, timeout_seconds: float = DOWNLOAD_TIMEOUT_SECONDS) -> None`. Raises `RuntimeError` on a non-zero yt-dlp exit or on exceeding `timeout_seconds`. Calls `on_progress({"downloaded_bytes": int|None, "total_bytes": int|None, "speed_bytes_per_sec": float|None})` for each parsed progress line.

- [ ] **Step 1: Write the failing tests**

Create `apps/video-worker/tests/test_youtube_download.py`:
```python
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
    # reports time already past it, so the loop raises on its first
    # iteration instead of processing further lines or actually sleeping.
    monotonic_values = iter([0, 1000, 1000, 1000])
    monkeypatch.setattr("youtube_download.time.monotonic", lambda: next(monotonic_values, 1000))

    with pytest.raises(RuntimeError, match="timed out"):
        download_youtube_video("https://youtube.com/watch?v=x", "/tmp/out.mp4", timeout_seconds=1800)

    assert fake_proc.killed is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_youtube_download.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'youtube_download'`.

- [ ] **Step 3: Implement**

Create `apps/video-worker/youtube_download.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_youtube_download.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Pin yt-dlp and install Deno**

In `apps/video-worker/requirements.txt`, add:
```
yt-dlp>=2025.1.1
```

In `apps/video-worker/Dockerfile`, add after the existing `RUN mkdir -p /app/voices && python3 -c ...` block (the Piper voice download) and before the final `CMD`:
```dockerfile
# yt-dlp's bundled JS-challenge solver (for YouTube's bot-detection) needs a
# JS runtime to execute the challenge script -- Deno is the one clipper-service
# (a sibling project on this same host) already validated works, avoiding any
# manual cookies.txt export.
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- --no-modify-path
```
(`curl` is already installed in this Dockerfile's base — check the existing `apt-get install` line; if `curl` isn't already present, add it to that same `apt-get install -y --no-install-recommends` list rather than a second `RUN apt-get` layer.)

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/youtube_download.py apps/video-worker/tests/test_youtube_download.py apps/video-worker/requirements.txt apps/video-worker/Dockerfile
git commit -m "feat(video-worker): add youtube_download module with subprocess yt-dlp + Deno JS-challenge solver"
```

---

### Task 3: video-worker — `POST /download-youtube` route

**Files:**
- Modify: `apps/video-worker/main.py`
- Test: `apps/video-worker/tests/test_main.py`

**Interfaces:**
- Consumes: `download_youtube_video` (Task 2), `probe_duration` (existing, `ffmpeg_utils.py`).
- Produces: `POST /download-youtube` — body `{job_id, url, callback_url}`. 202 immediately; background task posts throttled `{job_id, status: "downloading", downloaded_bytes, total_bytes, speed_bytes_per_sec}` updates, then a final `{job_id, status: "done", output_path, duration_seconds}` or `{job_id, status: "failed", error}`.

- [ ] **Step 1: Write the failing tests**

Read `apps/video-worker/main.py`'s existing route handlers in full first (this follows the same dict-payload/`BackgroundTasks`/`_post_callback` shape as `/cut` and `/find-hooks`). Add to `apps/video-worker/tests/test_main.py`:
```python
def test_download_youtube_returns_202_and_posts_progress_then_done(client, monkeypatch, tmp_path):
    from unittest.mock import MagicMock

    def fake_download(url, output_path, on_progress=None, timeout_seconds=1800):
        # Simulate two progress ticks (both should be throttled to at most
        # one POST given they happen "instantly" in a test) then success.
        if on_progress:
            on_progress({"downloaded_bytes": 100, "total_bytes": 1000, "speed_bytes_per_sec": 50.0})
            on_progress({"downloaded_bytes": 200, "total_bytes": 1000, "speed_bytes_per_sec": 55.0})

    monkeypatch.setattr("main.download_youtube_video", fake_download)
    monkeypatch.setattr("main.probe_duration", MagicMock(return_value=42.0))
    monkeypatch.setenv("VIDEO_ASSETS_DIR", str(tmp_path))

    posted = []

    def fake_post(url, json, timeout):
        posted.append(json)
        class FakeResponse:
            def raise_for_status(self):
                pass
        return FakeResponse()

    monkeypatch.setattr("main.requests.post", fake_post)

    res = client.post(
        "/download-youtube",
        json={"job_id": "job-1", "url": "https://youtube.com/watch?v=x", "callback_url": "http://api:4000/api/internal/youtube-jobs/job-1/progress"},
    )
    assert res.status_code == 202

    # Both progress ticks happen back-to-back with no real time elapsed, so
    # the throttle should have posted at most one "downloading" update, then
    # exactly one final "done".
    downloading_posts = [p for p in posted if p.get("status") == "downloading"]
    done_posts = [p for p in posted if p.get("status") == "done"]
    assert len(downloading_posts) <= 1
    assert len(done_posts) == 1
    assert done_posts[0]["job_id"] == "job-1"
    assert done_posts[0]["duration_seconds"] == 42.0
    assert "output_path" in done_posts[0]


def test_download_youtube_reports_error_on_failure(client, monkeypatch):
    def fake_download(url, output_path, on_progress=None, timeout_seconds=1800):
        raise RuntimeError("yt-dlp exited 1: Video unavailable")

    monkeypatch.setattr("main.download_youtube_video", fake_download)

    posted = {}

    def fake_post(url, json, timeout):
        posted["json"] = json
        class FakeResponse:
            def raise_for_status(self):
                pass
        return FakeResponse()

    monkeypatch.setattr("main.requests.post", fake_post)

    res = client.post(
        "/download-youtube",
        json={"job_id": "job-2", "url": "https://youtube.com/watch?v=bad", "callback_url": "http://api:4000/api/internal/youtube-jobs/job-2/progress"},
    )
    assert res.status_code == 202
    assert posted["json"]["job_id"] == "job-2"
    assert posted["json"]["status"] == "failed"
    assert "error" in posted["json"]


def test_download_youtube_reports_error_when_downloaded_file_is_unreadable(client, monkeypatch, tmp_path):
    # A "successful" yt-dlp exit whose output file ffprobe can't read (corrupt
    # merge, unsupported codec) must still surface as failed -- not a
    # video_assets row with a bogus duration that breaks every later
    # timeline calculation.
    def fake_download(url, output_path, on_progress=None, timeout_seconds=1800):
        pass  # "succeeds" without producing a readable file

    def fake_probe_duration(path):
        raise RuntimeError("ffprobe: Invalid data found when processing input")

    monkeypatch.setattr("main.download_youtube_video", fake_download)
    monkeypatch.setattr("main.probe_duration", fake_probe_duration)
    monkeypatch.setenv("VIDEO_ASSETS_DIR", str(tmp_path))

    posted = {}

    def fake_post(url, json, timeout):
        posted["json"] = json
        class FakeResponse:
            def raise_for_status(self):
                pass
        return FakeResponse()

    monkeypatch.setattr("main.requests.post", fake_post)

    res = client.post(
        "/download-youtube",
        json={"job_id": "job-3", "url": "https://youtube.com/watch?v=x", "callback_url": "http://api:4000/api/internal/youtube-jobs/job-3/progress"},
    )
    assert res.status_code == 202
    assert posted["json"]["job_id"] == "job-3"
    assert posted["json"]["status"] == "failed"
    assert "Invalid data" in posted["json"]["error"]
```
(Check the file's existing `client` fixture and confirm `BackgroundTasks` execute synchronously in this test setup, matching however the `/cut`/`/find-hooks` tests already verify their background task ran.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python3 -m pytest tests/test_main.py -v -k download_youtube`
Expected: FAIL — `404 Not Found`, route doesn't exist.

- [ ] **Step 3: Implement**

In `apps/video-worker/main.py`, add to the imports:
```python
import time

from youtube_download import download_youtube_video
```
Add after the existing `/cut` route handler (or after `/find-hooks` if the companion plan's `/cut` task hasn't merged yet):
```python
YOUTUBE_PROGRESS_THROTTLE_SECONDS = 2.0


def _run_youtube_download(job_id: str, url: str, output_path: str, callback_url: str) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    last_post_time = {"value": 0.0}

    def on_progress(progress: dict) -> None:
        now = time.monotonic()
        if now - last_post_time["value"] < YOUTUBE_PROGRESS_THROTTLE_SECONDS:
            return
        last_post_time["value"] = now
        _post_callback(callback_url, {"job_id": job_id, "status": "downloading", **progress})

    try:
        download_youtube_video(url, output_path, on_progress=on_progress)
        duration = probe_duration(output_path)
        _post_callback(
            callback_url,
            {"job_id": job_id, "status": "done", "output_path": output_path, "duration_seconds": duration},
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        logger.exception("youtube download failed for job_id=%s", job_id)
        _post_callback(callback_url, {"job_id": job_id, "status": "failed", "error": str(exc)})


@app.post("/download-youtube", status_code=202)
def download_youtube_route(payload: dict, background_tasks: BackgroundTasks) -> dict:
    output_dir = os.environ.get("VIDEO_ASSETS_DIR", "/app/video-assets")
    output_path = os.path.join(output_dir, "downloads", f"{payload['job_id']}.mp4")
    background_tasks.add_task(_run_youtube_download, payload["job_id"], payload["url"], output_path, payload["callback_url"])
    return {"status": "accepted"}
```
(`probe_duration` must already be imported in `main.py` — it is, if the companion plan's Task 2 (`/cut` endpoint) has merged; if not, add `from ffmpeg_utils import probe_duration` alongside whatever other `ffmpeg_utils` imports already exist in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_main.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/main.py apps/video-worker/tests/test_main.py
git commit -m "feat(video-worker): add /download-youtube route with throttled progress callbacks"
```

---

### Task 4: api — trigger route + `videoWorkerClient.ts` addition

**Files:**
- Modify: `apps/api/src/services/videoWorkerClient.ts`
- Modify: `apps/api/src/routes/assets.ts`
- Test: `apps/api/tests/videoWorkerClient.test.ts`
- Test: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Consumes: video-worker's `POST /download-youtube` (Task 3).
- Produces: `triggerYoutubeDownload(videoWorkerUrl, jobId, url, callbackUrl): Promise<void>`. `POST /api/campaigns/:id/assets/youtube` — body `{url}`. 400 if `url` is empty or not a valid URL, 202 with `{job_id}` on success.

- [ ] **Step 1: Write the failing test for `triggerYoutubeDownload`**

Read `apps/api/tests/videoWorkerClient.test.ts`'s existing `triggerCut`/`findHooks` tests first to match conventions exactly. Add:
```typescript
  it("triggerYoutubeDownload posts the expected body to video-worker's /download-youtube", async () => {
    const { triggerYoutubeDownload } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await triggerYoutubeDownload(
      "http://video-worker:8100",
      "job-1",
      "https://youtube.com/watch?v=x",
      "http://api:4000/api/internal/youtube-jobs/job-1/progress"
    );

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("http://video-worker:8100/download-youtube");
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      job_id: "job-1",
      url: "https://youtube.com/watch?v=x",
      callback_url: "http://api:4000/api/internal/youtube-jobs/job-1/progress",
    });
  });

  it("triggerYoutubeDownload throws when video-worker responds with a non-ok status", async () => {
    const { triggerYoutubeDownload } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      triggerYoutubeDownload("http://video-worker:8100", "job-1", "https://youtube.com/watch?v=x", "http://cb")
    ).rejects.toThrow("video-worker /download-youtube failed with status 500");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts -t "triggerYoutubeDownload"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/services/videoWorkerClient.ts`, add:
```typescript
export async function triggerYoutubeDownload(
  videoWorkerUrl: string,
  jobId: string,
  url: string,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/download-youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, url, callback_url: callbackUrl }),
  });
  if (!res.ok) throw new Error(`video-worker /download-youtube failed with status ${res.status}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write failing tests for the trigger route**

Add to `apps/api/tests/assets.test.ts`. The file's `jest.mock` factory for `videoWorkerClient` at the top of the file needs `triggerYoutubeDownload` added alongside whatever other functions it already mocks (extend the existing factory, do not add a second `jest.mock` call):
```typescript
  it("triggers a youtube download and returns 202 with a job_id", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets/youtube`)
      .send({ url: "https://youtube.com/watch?v=x" });
    expect(res.status).toBe(202);
    expect(res.body.job_id).toBeDefined();

    const db = getDb(process.env.DB_PATH as string);
    const job = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get(res.body.job_id) as any;
    expect(job.url).toBe("https://youtube.com/watch?v=x");
    expect(job.status).toBe("pending");
  });

  it("returns 400 for an empty url", async () => {
    const app = createApp();
    const res = await request(app).post(`/api/campaigns/${campaignId}/assets/youtube`).send({ url: "" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed url", async () => {
    const app = createApp();
    const res = await request(app).post(`/api/campaigns/${campaignId}/assets/youtube`).send({ url: "not a url" });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/assets.test.ts -t "youtube download"`
Expected: FAIL — route doesn't exist.

- [ ] **Step 7: Implement**

In `apps/api/src/routes/assets.ts`, add `triggerYoutubeDownload` to the existing `videoWorkerClient` import line. Add after the `/categories` route (or after the upload route if the companion plan's category task hasn't merged yet):
```typescript
  router.post("/youtube", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const url = typeof req.body.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      res.status(400).json({ error: "url is not a valid URL" });
      return;
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO youtube_download_jobs (id, campaign_id, url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(jobId, campaignId, url, "pending", now, now);

    try {
      await triggerYoutubeDownload(videoWorkerUrl, jobId, url, `${callbackBase}/youtube-jobs/${jobId}/progress`);
    } catch (err) {
      db.prepare("UPDATE youtube_download_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        (err as Error).message,
        new Date().toISOString(),
        jobId
      );
      res.status(202).json({ job_id: jobId });
      return;
    }

    res.status(202).json({ job_id: jobId });
  }));
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/videoWorkerClient.ts apps/api/src/routes/assets.ts apps/api/tests/videoWorkerClient.test.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): add youtube-download trigger route and client function"
```

---

### Task 5: api — status route + progress/completion callback

**Files:**
- Modify: `apps/api/src/routes/assets.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Test: `apps/api/tests/assets.test.ts`
- Test: `apps/api/tests/internal.test.ts`

**Interfaces:**
- Consumes: video-worker's callback payload (Task 3): `{job_id, status: "downloading", downloaded_bytes, total_bytes, speed_bytes_per_sec}`, `{job_id, status: "done", output_path, duration_seconds}`, or `{job_id, status: "failed", error}`.
- Produces: `GET /api/campaigns/:id/assets/youtube-jobs/:jobId` — the job row (404 if not found). `POST /api/internal/youtube-jobs/:jobId/progress` — updates progress fields on `"downloading"`, inserts a `footage` `video_assets` row and triggers `analyzeAsset` on `"done"`, sets `failed` + `error_message` on `"failed"`.

- [ ] **Step 1: Write the failing tests**

Read `apps/api/src/routes/internal.ts`'s existing `/assets/:assetId/analysis-complete` handler in full first (its shape — insert a `video_assets` row, then call `analyzeAsset` — is exactly what the `"done"` case here needs) and `apps/api/src/routes/assets.ts`'s upload route (to see how `videoWorkerUrl`/`callbackBase` env vars are already read, since `internal.ts` doesn't currently define them and this task needs to add that). Add to `apps/api/tests/internal.test.ts`:
```typescript
  it("updates progress fields on a downloading update", async () => {
    const app = createApp();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO youtube_download_jobs (id, campaign_id, url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ytjob-1", campaignId, "https://youtube.com/watch?v=x", "pending", now, now);

    const res = await request(app)
      .post(`/api/internal/youtube-jobs/ytjob-1/progress`)
      .send({ job_id: "ytjob-1", status: "downloading", downloaded_bytes: 1000, total_bytes: 5000, speed_bytes_per_sec: 200 });

    expect(res.status).toBe(200);
    const job = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get("ytjob-1") as any;
    expect(job.status).toBe("downloading");
    expect(job.downloaded_bytes).toBe(1000);
    expect(job.total_bytes).toBe(5000);
  });

  it("creates a footage asset and marks the job done on success", async () => {
    const app = createApp();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO youtube_download_jobs (id, campaign_id, url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ytjob-2", campaignId, "https://youtube.com/watch?v=x", "downloading", now, now);

    const res = await request(app)
      .post(`/api/internal/youtube-jobs/ytjob-2/progress`)
      .send({ job_id: "ytjob-2", status: "done", output_path: "/app/video-assets/downloads/ytjob-2.mp4", duration_seconds: 120.5 });

    expect(res.status).toBe(200);
    const job = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get("ytjob-2") as any;
    expect(job.status).toBe("done");
    expect(job.result_asset_id).toBeTruthy();

    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(job.result_asset_id) as any;
    expect(asset.asset_type).toBe("footage");
    expect(asset.file_path).toBe("/app/video-assets/downloads/ytjob-2.mp4");
    expect(asset.duration_seconds).toBe(120.5);
    expect(asset.campaign_id).toBe(campaignId);
  });

  it("marks the job failed on error, creating no asset", async () => {
    const app = createApp();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO youtube_download_jobs (id, campaign_id, url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ytjob-3", campaignId, "https://youtube.com/watch?v=x", "downloading", now, now);

    const res = await request(app)
      .post(`/api/internal/youtube-jobs/ytjob-3/progress`)
      .send({ job_id: "ytjob-3", status: "failed", error: "yt-dlp exited 1" });

    expect(res.status).toBe(200);
    const job = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get("ytjob-3") as any;
    expect(job.status).toBe("failed");
    expect(job.error_message).toBe("yt-dlp exited 1");
    expect(job.result_asset_id).toBeNull();
  });
```
Add to `apps/api/tests/assets.test.ts`:
```typescript
  it("returns a youtube_download_jobs row by id", async () => {
    const app = createApp();
    const db = getDb(process.env.DB_PATH as string);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO youtube_download_jobs (id, campaign_id, url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ytjob-4", campaignId, "https://youtube.com/watch?v=x", "pending", now, now);

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/youtube-jobs/ytjob-4`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
  });

  it("returns 404 for an unknown youtube_download_jobs id", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/youtube-jobs/does-not-exist`);
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/internal.test.ts tests/assets.test.ts -t "youtube"`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement the status route**

In `apps/api/src/routes/assets.ts`, add after the `/youtube` trigger route:
```typescript
  router.get("/youtube-jobs/:jobId", (req, res) => {
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "youtube download job not found" });
      return;
    }
    res.json(job);
  });
```

- [ ] **Step 4: Implement the internal callback**

In `apps/api/src/routes/internal.ts`, add the `videoWorkerUrl`/`callbackBase` env-var reads this file currently lacks (add near the top of `createInternalRouter`, alongside the existing `dbPath` constant), and import `analyzeAsset`:
```typescript
import { analyzeAsset } from "../services/videoWorkerClient";
```
```typescript
  const videoWorkerUrl = process.env.VIDEO_WORKER_URL ?? "http://video-worker:8100";
  const callbackBase = process.env.API_INTERNAL_CALLBACK_URL ?? "http://api:4000/api/internal";
```
Add after the existing `/render/:jobId/complete` handler:
```typescript
  router.post("/youtube-jobs/:jobId/progress", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const { jobId } = req.params;
    const now = new Date().toISOString();

    if (req.body.status === "downloading") {
      db.prepare(
        `UPDATE youtube_download_jobs
         SET status = ?, downloaded_bytes = ?, total_bytes = ?, speed_bytes_per_sec = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        "downloading",
        req.body.downloaded_bytes ?? null,
        req.body.total_bytes ?? null,
        req.body.speed_bytes_per_sec ?? null,
        now,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    if (req.body.status === "failed") {
      console.error(`youtube download failed for job ${jobId}:`, req.body.error);
      db.prepare("UPDATE youtube_download_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        req.body.error,
        now,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    const job = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get(jobId) as
      | { campaign_id: string }
      | undefined;
    if (!job) {
      res.status(404).json({ error: "youtube download job not found" });
      return;
    }

    const assetId = randomUUID();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, job.campaign_id, req.body.output_path, "footage", req.body.duration_seconds, "pending", now);

    db.prepare("UPDATE youtube_download_jobs SET status = ?, result_asset_id = ?, updated_at = ? WHERE id = ?").run(
      "done",
      assetId,
      now,
      jobId
    );

    try {
      await analyzeAsset(videoWorkerUrl, assetId, req.body.output_path, `${callbackBase}/assets/${assetId}/analysis-complete`);
    } catch (err) {
      console.error(`analyze trigger failed for downloaded asset ${assetId}:`, err);
      db.prepare("UPDATE video_assets SET analysis_status = ? WHERE id = ?").run("failed", assetId);
    }

    res.json({ status: "recorded" });
  }));
```
(This route needs `asyncHandler` — check `internal.ts`'s current imports; if it doesn't already import `asyncHandler` from `../asyncHandler`, add that import. Every other handler in this file is synchronous and doesn't need it, but this one calls `await analyzeAsset(...)`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/internal.test.ts tests/assets.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/assets.ts apps/api/src/routes/internal.ts apps/api/tests/assets.test.ts apps/api/tests/internal.test.ts
git commit -m "feat(api): add youtube-job status route and progress/completion callback"
```

---

### Task 6: web-ui — `apiClient.ts` additions

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`

**Interfaces:**
- Consumes: `GET .../assets/youtube-jobs/:jobId`, `POST .../assets/youtube` (Tasks 4-5).
- Produces: `YoutubeDownloadJob` interface; `triggerYoutubeDownload(campaignId, url): Promise<{job_id: string}>`; `getYoutubeDownloadJob(campaignId, jobId): Promise<YoutubeDownloadJob>`.

- [ ] **Step 1: Implement**

In `apps/web-ui/lib/apiClient.ts`, add after the existing `getAssetCategories` function (added by the companion plan's Task 7 — if that hasn't merged yet, add after `getCutJob` instead, or after `getHookSuggestions` if neither has merged):
```typescript
export interface YoutubeDownloadJob {
  id: string;
  campaign_id: string;
  url: string;
  status: "pending" | "downloading" | "done" | "failed";
  downloaded_bytes: number | null;
  total_bytes: number | null;
  speed_bytes_per_sec: number | null;
  result_asset_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export async function triggerYoutubeDownload(campaignId: string, url: string): Promise<{ job_id: string }> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `youtube download trigger failed with status ${res.status}`);
  }
  return res.json();
}

export async function getYoutubeDownloadJob(campaignId: string, jobId: string): Promise<YoutubeDownloadJob> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/youtube-jobs/${jobId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get youtube download job failed with status ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts
git commit -m "feat(web-ui): add youtube-download apiClient functions"
```

---

### Task 7: web-ui — `AssetUpload` link-vs-file mode + progress UI

**Files:**
- Modify: `apps/web-ui/components/AssetUpload.tsx`

**Interfaces:**
- Consumes: `triggerYoutubeDownload`, `getYoutubeDownloadJob` (Task 6).
- Produces: a mode toggle ("Upload File" / "Paste YouTube Link") with a progress bar + speed readout while a link download is in flight.

- [ ] **Step 1: Implement**

Read the current full file first — by the time this task runs, it already has the companion plan's Task 8 category-combobox changes (the `<input list="asset-categories">`/`<datalist>` pair and the `getAssetCategories` fetch). Add the mode toggle and link-download flow alongside the existing file-upload form, without removing the existing upload path:
```tsx
"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { VideoAsset, getAssetCategories, getYoutubeDownloadJob, triggerYoutubeDownload, uploadAsset } from "../lib/apiClient";

export function AssetUpload({
  campaignId,
  onUploaded,
}: {
  campaignId: string;
  onUploaded: (asset: VideoAsset) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(["footage", "clip", "broll", "music", "watermark"]);
  const [mode, setMode] = useState<"file" | "youtube">("file");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded_bytes: number | null;
    total_bytes: number | null;
    speed_bytes_per_sec: number | null;
  } | null>(null);
  const youtubePollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getAssetCategories(campaignId).then(setCategories).catch(() => {});
  }, [campaignId]);

  useEffect(() => {
    return () => {
      if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
    };
  }, []);

  async function handleFileSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData(form);
      const asset = await uploadAsset(campaignId, formData);
      onUploaded(asset);
      form.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleYoutubeSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setDownloading(true);
    setDownloadProgress(null);
    let jobId: string;
    try {
      const result = await triggerYoutubeDownload(campaignId, youtubeUrl);
      jobId = result.job_id;
    } catch (err) {
      setError((err as Error).message);
      setDownloading(false);
      return;
    }

    if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
    youtubePollIntervalRef.current = setInterval(async () => {
      try {
        const job = await getYoutubeDownloadJob(campaignId, jobId);
        if (job.status === "downloading") {
          setDownloadProgress({
            downloaded_bytes: job.downloaded_bytes,
            total_bytes: job.total_bytes,
            speed_bytes_per_sec: job.speed_bytes_per_sec,
          });
        } else if (job.status === "done") {
          if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
          setDownloading(false);
          setDownloadProgress(null);
          setYoutubeUrl("");
          onUploaded({
            id: job.result_asset_id as string,
            campaign_id: campaignId,
            file_path: "",
            asset_type: "footage",
            duration_seconds: 0,
            analysis_status: "pending",
            hook_status: "none",
            created_at: job.created_at,
          });
        } else if (job.status === "failed") {
          if (youtubePollIntervalRef.current !== null) clearInterval(youtubePollIntervalRef.current);
          setDownloading(false);
          setError(job.error_message ?? "youtube download failed");
        }
      } catch {
        // transient poll failure -- keep trying
      }
    }, 2000);
  }

  function formatBytes(bytes: number | null): string {
    if (bytes === null) return "?";
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-orange-200 bg-orange-50/50 p-5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("file")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "file" ? "bg-orange-500 text-white" : "bg-white text-slate-500"}`}
        >
          Upload File
        </button>
        <button
          type="button"
          onClick={() => setMode("youtube")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "youtube" ? "bg-orange-500 text-white" : "bg-white text-slate-500"}`}
        >
          Paste YouTube Link
        </button>
      </div>

      {mode === "file" && (
        <form onSubmit={handleFileSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            list="asset-categories"
            name="asset_type"
            defaultValue="footage"
            placeholder="Category (e.g. footage, broll, music)"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
          <datalist id="asset-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input
            type="file"
            name="file"
            required
            className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
          <button
            type="submit"
            disabled={submitting}
            className="whitespace-nowrap rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-orange-100 transition hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Uploading..." : "Upload"}
          </button>
        </form>
      )}

      {mode === "youtube" && (
        <form onSubmit={handleYoutubeSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="url"
            required
            placeholder="https://youtube.com/watch?v=..."
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            disabled={downloading}
            className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
          <button
            type="submit"
            disabled={downloading}
            className="whitespace-nowrap rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-orange-100 transition hover:opacity-90 disabled:opacity-50"
          >
            {downloading ? "Downloading..." : "Download"}
          </button>
        </form>
      )}

      {downloading && (
        <div className="rounded-xl bg-white p-3 text-xs text-slate-500">
          {downloadProgress ? (
            <p>
              {formatBytes(downloadProgress.downloaded_bytes)} / {formatBytes(downloadProgress.total_bytes)}
              {downloadProgress.speed_bytes_per_sec !== null &&
                ` — ${(downloadProgress.speed_bytes_per_sec / 1024 / 1024).toFixed(1)}MB/s`}
            </p>
          ) : (
            <p>Starting download...</p>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm font-medium text-rose-500">{error}</p>}
    </div>
  );
}
```
(Note: on a successful YouTube-link download, this synthesizes a placeholder `VideoAsset` object to pass to `onUploaded` rather than re-fetching the real one — its `file_path`/`duration_seconds` are stand-ins, not the real values. Check how the parent page (`apps/web-ui/app/campaigns/[id]/assets/page.tsx`) actually uses `onUploaded`: if it just calls `refresh()` (re-fetches the full asset list from the server) rather than using the passed asset object directly, replace this synthesized object with a call to whatever refresh mechanism the page already exposes instead — read that page's current `onUploaded={refresh}` wiring before finalizing this, since a stand-in object is only acceptable if nothing downstream actually reads its placeholder fields.)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Manual verification**

No component test framework in this project. If a dev server is reachable, and a real YouTube URL + working network access is available: paste a short public video's URL, confirm the progress bar advances and the resulting asset behaves like an uploaded one. This is explicitly the operator's own post-merge verification step per the spec (not exercisable in this development sandbox) — if not possible here, say so honestly.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/AssetUpload.tsx
git commit -m "feat(web-ui): add YouTube link import mode with live download progress"
```

---

### Task 8: web-ui — restrict Find Hooks to `footage` assets

**Files:**
- Modify: `apps/web-ui/components/SegmentEditor.tsx`

**Interfaces:**
- Produces: the "Find Hooks 🎯" button/panel is gated on `asset.analysis_status === "done" && asset.asset_type === "footage"` (previously gated on `analysis_status` alone).

- [ ] **Step 1: Implement**

Read the current full file first — by the time this task runs, it already has the companion plan's Task 10 changes (editable `segment_key` label, soft-filtered source picker, cut-trigger controls). Find the existing Find Hooks gating condition:
```tsx
      {asset && asset.analysis_status === "done" && (
```
Change to:
```tsx
      {asset && asset.analysis_status === "done" && asset.asset_type === "footage" && (
```
(This is the only line this task changes — everything else in the Find Hooks block is untouched. The reasoning, per the spec: finding a hook moment only makes sense on a long, un-cut source, whether it arrived by upload or by YouTube-link import; a `clip` (already cut to size) or `broll` asset never offers Find Hooks.)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Manual verification**

No component test framework in this project. If a dev server is reachable: confirm the Find Hooks button disappears for a segment whose selected asset is a `clip` or `broll`, and still appears for a `footage` asset with `analysis_status === "done"`. If not possible in this environment, say so honestly.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/SegmentEditor.tsx
git commit -m "feat(web-ui): restrict Find Hooks eligibility to footage assets"
```
