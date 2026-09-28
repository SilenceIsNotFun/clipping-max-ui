# YouTube Link Asset Import — Design

## Background

Right now the only way to get a video into a campaign is a direct file upload (`AssetUpload.tsx`, multipart to `POST /api/campaigns/:id/assets`). The operator's reference tool (mentioned earlier in this project's history alongside the Gemini-native Find Hooks pivot) supports pasting a YouTube URL instead — the tool downloads it server-side. The operator wants the same: paste a link, the server downloads it via `yt-dlp`, with a visible progress indicator while it downloads.

A related, separately-maintained project on this machine, `clipper-service` (`/home/silenceisnotfun/projects/clipper-service`), already solves the two hard parts of this in production:

- **Hanging downloads**: `yt_dlp`'s in-process Python API gives no reliable way to kill a stuck download from outside. clipper-service runs `yt-dlp` as a subprocess with a hard wall-clock timeout instead (commit history: "run yt-dlp with a hard timeout" — this fixed a real incident where a download stuck a task in `"processing"` for 14+ hours).
- **YouTube bot-detection ("Sign in to confirm you're not a bot")**: not solved with cookies. clipper-service's Dockerfile installs **Deno** (commit: "install deno for JS-runtime challenges") — recent `yt-dlp` versions bundle a JS solver (`yt_dlp/extractor/youtube/jsc/_builtin/vendor/yt.solver.deno.lib.js`) that runs YouTube's challenge script itself via any available JS runtime (Deno/Node/Bun). No manual cookie export needed.

This sub-project adopts both patterns directly. It depends on the asset-category work from the companion spec (`2026-09-28-dynamic-segments-asset-categories-design.md`) — a YouTube-downloaded video becomes an `asset_type: "footage"` asset, same category as an uploaded one, reusable identically in the segment/cut workflow that spec defines.

## Goal

Let the operator paste a YouTube URL instead of choosing a file, see live download progress (percentage, speed), and end up with a normal `footage` asset in the campaign's library once it completes — indistinguishable from an uploaded one for every downstream feature (Find Hooks, segment cutting, etc.).

## Architecture

- **video-worker** gains `POST /download-youtube` — runs `yt-dlp` as a subprocess (not `yt_dlp`'s in-process API, for the same kill-from-outside reason clipper-service adopted it), with a hard timeout, streaming progress to api via periodic callbacks.
- **api** gains a `youtube_download_jobs` table and three routes: trigger, status read, and an internal callback that handles both progress updates and the final result — same shape as `cut_jobs` from the companion spec, just with a richer in-flight status.
- **web-ui**: `AssetUpload.tsx` gains a mode toggle ("Upload File" / "Paste YouTube Link") and a progress UI for the link mode.

## Data Flow

1. Operator switches `AssetUpload` to "Paste YouTube Link" mode, pastes a URL, clicks "Download".
2. **web-ui** calls `POST /api/campaigns/:id/assets/youtube` with `{url}`.
3. **api**: creates a `youtube_download_jobs` row (`status: "pending"`), calls video-worker's `POST /download-youtube` with `{url, output_path, callback_url}` (`output_path` constructed the same way the existing upload route picks a destination path under the campaign's video-assets directory), returns `202 {job_id}` immediately.
4. **web-ui**: starts polling `GET /api/campaigns/:id/youtube-jobs/:jobId` every ~2 seconds, rendering a progress bar from `downloaded_bytes`/`total_bytes` (indeterminate bar if `total_bytes` isn't known yet — yt-dlp doesn't always know the total upfront) and the current `speed_bytes_per_sec`.
5. **video-worker**: background task —
   - Spawns `yt-dlp` as a subprocess: `--format "bestvideo[height<=1080]+bestaudio/best" --merge-output-format mp4 --output <output_path> --no-warnings --newline --progress-template "download:PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.speed)s"` (identical flags to clipper-service's proven-working invocation).
   - Enforces a hard deadline (`time.monotonic()`-based, configurable via `YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS`, default `1800`) — kills the subprocess (`SIGKILL`) and reports failure if exceeded, exactly like clipper-service's incident fix.
   - Reads the subprocess's stdout line by line. Each `PROGRESS <downloaded> <total> <speed>` line updates an in-memory counter; POSTs `{status: "downloading", downloaded_bytes, total_bytes, speed_bytes_per_sec}` to `callback_url`, throttled to at most once per 2 seconds (yt-dlp can emit progress lines far more often than that — POSTing every one would hammer api for no benefit).
   - On subprocess exit 0: probes the output file's duration (reuses `ffmpeg_utils.probe_duration`, the same primitive the existing upload route's analysis already uses), POSTs `{status: "done", output_path, duration_seconds}`.
   - On non-zero exit or timeout: POSTs `{status: "failed", error: "..."}` (last lines of stderr/stdout, same truncation convention `_run_render`'s error reporting already uses).
6. **api**'s callback route: a `"downloading"` update just updates the `youtube_download_jobs` row's progress fields. A `"done"` update inserts a new `video_assets` row (`asset_type: "footage"`, `file_path` = `output_path`, `duration_seconds`, `analysis_status: "pending"` — same as any other footage upload, so it still goes through the existing scene/audio moment-detection `analyzeAsset` trigger, kicked off right after insert, matching what the upload route already does today) and sets `youtube_download_jobs.status = "done"` + `result_asset_id`. A `"failed"` update sets `status = "failed"` + `error_message`.
7. **web-ui**: once polling sees `status: "done"`, stops polling and refreshes the asset list (the new footage asset now appears normally, including going through its own analysis/find-hooks lifecycle exactly like an uploaded one).

## Data Model

New table:

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

`status`: `pending` | `downloading` | `done` | `failed`.

## API Endpoints

- `POST /api/campaigns/:id/assets/youtube` (api, new) — body `{url: string}`. 400 if `url` is empty or obviously not a URL (basic `new URL()` parse check, not a YouTube-specific validator — yt-dlp itself is the real validator, and it supports far more than just youtube.com). Creates the job row, calls video-worker, returns `202 {job_id}`.
- `GET /api/campaigns/:id/youtube-jobs/:jobId` (api, new) — returns the `youtube_download_jobs` row, for web-ui polling.
- `POST /api/internal/youtube-jobs/:jobId/progress` (api, new, internal) — video-worker's callback target for both progress updates and the final result (differentiated by `status` in the body, as described in Data Flow step 6).
- `POST /download-youtube` (video-worker, new) — body `{url: string, output_path: string, callback_url: string}`. Returns 202 immediately; everything else happens in the background task described above.

## Global Constraints

- Downloaded assets are always `asset_type: "footage"` — same category as an uploaded long-form video, per the companion categories spec.
- **Find Hooks eligibility is restricted to `asset_type === "footage"`** — the button/trigger in `SegmentEditor.tsx` (currently gated only on `analysis_status === "done"`) additionally checks `asset_type === "footage"`. A `clip` (already cut to size) or `broll` asset never offers Find Hooks — finding a hook moment only makes sense on a long, un-cut source, whether it arrived by upload or by this YouTube-link import. This is a small, self-contained change to the same file the companion spec's segment-editor work touches — sequence this after or alongside that plan's `SegmentEditor.tsx` task to avoid a diff conflict, not before it.
- No video length or file size cap in this MVP — consistent with the existing upload route, which has none either (`multer({dest: videoAssetsDir})` with no `limits.fileSize`).
- `yt-dlp` pinned to `>=2025.1.1` in `requirements.txt` (same floor clipper-service uses, known to include the JS-challenge solver) and Deno installed in the video-worker Dockerfile (`ENV DENO_INSTALL=/usr/local`, official install script — copy clipper-service's Dockerfile lines verbatim).

## Error Handling

- yt-dlp exits non-zero (invalid/private/region-locked/deleted video, network error) → `status: "failed"`, `error_message` = last ~500 chars of yt-dlp's combined stdout/stderr (same truncation convention as this codebase's other subprocess error handling).
- Download exceeds `YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS` → subprocess killed, `status: "failed"`, `error_message: "download timed out after Ns"`.
- Progress callback POST itself fails (network blip between video-worker and api) → logged (`logger.exception`, matching this codebase's established callback-failure pattern), does not abort the download — only the final `done`/`failed` POST failing is worth surfacing loudly, since a missed progress tick just means the UI's bar temporarily stalls until the next one lands.
- Operator navigates away from the Assets page mid-download → the download keeps running server-side regardless (it's not tied to the browser tab); returning to the page and re-fetching `GET .../youtube-jobs/:jobId` (or just seeing the asset appear once done) picks it back up. web-ui does not need to persist in-flight job ids across a reload beyond what re-polling the campaign's jobs would show — out of scope for this MVP to list "your in-flight downloads" separately; the progress bar simply won't reappear after a reload until re-visiting is added as a follow-up, if that turns out to matter in practice.

## Testing

- video-worker: unit tests for `/download-youtube` (202 response, background task invoked), the subprocess invocation's exact flags, the timeout-kill path (mock `time.monotonic` to fast-forward, same technique already used for Find Hooks' Gemini-poll timeout test), and the throttled-progress-POST logic (assert it doesn't POST on every single line).
- api: route tests for the trigger (400 on bad url, 202 on success), the status-read route, and the internal callback's three cases (progress update, success → `video_assets` insert + `analyzeAsset` triggered, failure).
- web-ui: manual verification per this project's established pattern — paste a real (short, public) YouTube URL against a live dev environment, confirm the progress bar advances and the resulting asset behaves identically to an uploaded one. A real download against the actual YouTube service is the operator's own post-merge verification step, same as the Gemini API key check for Find Hooks — not exercisable in this development sandbox.

## Out of Scope (this sub-project)

- Any UI for browsing/cancelling in-flight downloads outside the single active one the operator just started (see Error Handling's last point).
- Non-YouTube URL sources — yt-dlp itself supports many sites, and nothing here special-cases YouTube specifically beyond the feature's name, but no other source is explicitly tested or promised.
- Cookie-based auth for private/members-only videos — the Deno JS-challenge solver addresses bot-detection, not access control; a private/unlisted-to-the-uploader-only video is still out of reach, same as it would be for any anonymous yt-dlp invocation.
