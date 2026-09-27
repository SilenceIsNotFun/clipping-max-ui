# Watermark Overlay & Title Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator upload a logo/watermark image, drag a free-form box on a video preview to position and size it, and have it burned into the final rendered video for a chosen render job. Also let the operator freely reposition each segment's title text (previously fixed top-center), using the exact same drag-a-box pattern.

**Architecture:** A new `asset_type` value (`"watermark"`) reuses the existing asset upload pipeline with one branch change (skip the ffprobe duration check for images). Placement reuses the existing `CropRect` type and `CropCanvas` component (already built for crop-region selection) rather than inventing a new position picker. The render job stores which watermark and rect were chosen; video-worker adds one more overlay stage to the final ffmpeg mux, applied once to the whole assembled video. Title positioning (Tasks 7-9) reuses the identical `CropRect`/`CropCanvas` pattern, scoped per-segment instead of per-render-job, and changes only *where within its own canvas* `render_title_png` draws text — the existing full-canvas overlay mechanism in `layout.py` is untouched.

**Tech Stack:** No new dependencies — same Express/FastAPI/Next.js stack, same ffmpeg `overlay`/`scale` filters already used for title-PNG overlays.

**Spec:** `docs/superpowers/specs/2026-09-27-watermark-overlay-design.md`

## Global Constraints

- Watermark placement is per-render-job, not per-campaign or per-segment.
- No aspect-ratio lock on the drawn rect — the logo stretches to fill it (ffmpeg `scale` with explicit `w:h` does this by default); not treated as a bug.
- Watermark image validated as PNG/JPEG only at upload time.
- No opacity/blend-mode control in this MVP — the image is overlaid as-is.
- Applied once to the whole final assembled video, not per-segment.

## Review Focus

- **Watermark asset uploaded with a video/audio file by mistake (wrong `asset_type` selected)** — the upload must reject a non-image file for `asset_type: "watermark"` with a clear error, not silently store an unusable multi-gigabyte "watermark" with `duration_seconds: 0`.
- **Render submitted with a `watermark_asset_id` that doesn't belong to the campaign (or doesn't exist)** — the render route must reject with a clear error before calling video-worker, not send a bogus/undefined `file_path` into the render pipeline.
- **Render submitted with no watermark at all (the common case)** — the existing no-watermark render path must produce byte-for-byte the same ffmpeg command as before this feature shipped; a task's tests must assert the *absence* of the new input/filter stage when `watermark_path` is unset, not just the presence when it is set.
- **`watermark_rect` at the edge of the frame (e.g. `x: 0.9, width: 0.3` — logo would extend past the right edge)** — ffmpeg's `overlay` filter does not error on this (it just clips), so no crash is expected, but a task should still confirm the geometry computation produces the values ffmpeg actually receives, not silently wrong ones.
- **`render_jobs` created on a DB that predates this feature** — `watermark_asset_id`/`watermark_rect` must both be nullable additive columns via the same idempotent migration pattern already established, not a fresh `CREATE TABLE`.
- **A segment with `title_text` set but no `title_rect` (the common case — most existing segments and any operator who doesn't bother repositioning)** — `render_title_png` must fall back to its exact current fixed-position behavior (full-width centering, `TITLE_Y`), not crash or silently render nothing when `rect` is `None`.

---

## File Structure

```
apps/api/
  src/
    db.ts                        # MODIFY: render_jobs gains watermark_asset_id, watermark_rect (migration); segment_assignments gains title_rect (migration)
    types.ts                       # MODIFY: VideoAsset.asset_type widened, RenderJob watermark fields, SegmentAssignment.title_rect
    routes/
      assets.ts                     # MODIFY: accept "watermark" asset_type, skip ffprobe for images
      render.ts                       # MODIFY: accept + thread watermark_asset_id/watermark_rect
      segments.ts                     # MODIFY: accept + persist title_rect
    services/
      videoWorkerClient.ts               # MODIFY: submitRender gains watermarkPath/watermarkRect params; RenderSegmentPayload gains title_rect
  tests/
    assets.test.ts, db.test.ts, render.test.ts, videoWorkerClient.test.ts, segments.test.ts   # all MODIFY

apps/video-worker/
  schemas.py                    # MODIFY: RenderJobInput gains watermark_path/watermark_rect; RenderSegmentInput gains title_rect
  title_render.py                 # MODIFY: render_title_png accepts an optional positioning rect
  render.py                         # MODIFY: render_video applies watermark overlay when present; _render_single_segment passes title_rect through
  tests/
    test_render.py                  # MODIFY
    test_title_render.py              # MODIFY

apps/web-ui/
  lib/apiClient.ts               # MODIFY: VideoAsset.asset_type widened, submitRenderJob signature, SegmentDraft.title_rect
  components/
    AssetUpload.tsx                # MODIFY: "watermark" option in asset_type select
    SegmentEditor.tsx                # MODIFY: CropCanvas for title-text placement
  app/campaigns/[id]/segments/
    page.tsx                       # MODIFY: watermark dropdown + CropCanvas, wired into handleSubmit
```

---

### Task 1: Accept watermark asset uploads

**Files:**
- Modify: `apps/api/src/routes/assets.ts`
- Modify: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Produces: `POST /` accepts `asset_type: "watermark"`, skips the `ffprobe` duration probe for it, validates the file's mimetype is `image/png` or `image/jpeg`, stores `duration_seconds: 0`, and (same as `"music"` today) does not trigger `analyzeAsset`.

- [ ] **Step 1: Write failing tests**

Add to `apps/api/tests/assets.test.ts`, inside the existing `describe("asset routes"` block:
```typescript
  it("uploads a watermark image without probing duration", async () => {
    const app = createApp();
    const pngPath = path.join(os.tmpdir(), "logo.png");
    // Minimal valid 1x1 PNG (smallest legal PNG file bytes).
    fs.writeFileSync(
      pngPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      )
    );

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "watermark")
      .attach("file", pngPath);

    expect(res.status).toBe(201);
    expect(res.body.asset_type).toBe("watermark");
    expect(res.body.duration_seconds).toBe(0);
    expect(res.body.analysis_status).toBe("done");
  });

  it("rejects a watermark upload that isn't an image", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "watermark")
      .attach("file", fixture);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/assets.test.ts -t "watermark"`
Expected: FAIL — currently any `asset_type` other than `"music"` falls through to `"footage"`, which requires a real playable video/audio file via `ffprobe` (a 1x1 PNG has no duration, so it gets wrongly rejected as "not a readable audio/video file"; the actual mp4 fixture wrongly gets accepted as "footage" instead of rejected).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/assets.ts`, replace:
```typescript
    const assetType = req.body.asset_type === "music" ? "music" : "footage";
    const duration = probeDurationSeconds(file.path);
    if (duration <= 0) {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: "file is not a readable audio/video file" });
      return;
    }
```
with:
```typescript
    const assetType: "footage" | "music" | "watermark" =
      req.body.asset_type === "music" ? "music" : req.body.asset_type === "watermark" ? "watermark" : "footage";

    let duration = 0;
    if (assetType === "watermark") {
      if (file.mimetype !== "image/png" && file.mimetype !== "image/jpeg") {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: "watermark must be a PNG or JPEG image" });
        return;
      }
    } else {
      duration = probeDurationSeconds(file.path);
      if (duration <= 0) {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: "file is not a readable audio/video file" });
        return;
      }
    }
```
Then update the INSERT's `analysis_status` value — replace:
```typescript
    ).run(id, campaignId, finalPath, assetType, duration, assetType === "footage" ? "pending" : "done", now);
```
with (unchanged logic, `assetType === "footage"` already correctly leaves `"watermark"` in the `"done"` branch alongside `"music"` — no code change needed here, this line stays exactly as it is; verify it during Step 4 rather than editing it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: all tests PASS, including the two new ones and all pre-existing ones. If the bare host lacks `ffprobe`, other pre-existing tests in this file will fail regardless (known environment gap, not from this change) — verify via Docker if needed (build the `api` image, run the suite inside a container, established pattern from every prior `assets.test.ts` change).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/assets.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): accept watermark image uploads without requiring ffprobe duration"
```

---

### Task 2: `render_jobs` schema — watermark columns

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/tests/db.test.ts`

**Interfaces:**
- Produces: `render_jobs.watermark_asset_id TEXT REFERENCES video_assets(id)` (nullable), `render_jobs.watermark_rect TEXT` (nullable, JSON-stringified `CropRect`), both migrated for pre-existing DBs. `VideoAsset.asset_type` widened to include `"watermark"` in `types.ts`.

- [ ] **Step 1: Write failing tests**

Add to `apps/api/tests/db.test.ts`:
```typescript
  it("adds watermark_asset_id and watermark_rect columns to render_jobs, migrated on an existing DB", () => {
    resetDbCacheForTests();
    const oldDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "old-render-db-")), "app.db");
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE render_jobs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        status TEXT NOT NULL,
        tts_voice TEXT NOT NULL,
        music_asset_id TEXT,
        output_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    oldDb.close();

    const reopened = getDb(oldDbPath);
    const columns = reopened.prepare("PRAGMA table_info(render_jobs)").all().map((row: any) => row.name);
    expect(columns).toContain("watermark_asset_id");
    expect(columns).toContain("watermark_rect");
    reopened.close();
  });
```
(This file already imports `Database` from `better-sqlite3`, `fs`, `os`, `path` per Task 4 of the Find Hooks plan, if that plan was implemented first — check the top of the file first; add any of those four imports only if actually missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts -t "watermark_asset_id"`
Expected: FAIL — columns don't exist.

- [ ] **Step 3: Implement**

In `apps/api/src/db.ts`, change the `render_jobs` table definition:
```sql
CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL,
  tts_voice TEXT NOT NULL,
  music_asset_id TEXT REFERENCES video_assets(id),
  output_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
to:
```sql
CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL,
  tts_voice TEXT NOT NULL,
  music_asset_id TEXT REFERENCES video_assets(id),
  watermark_asset_id TEXT REFERENCES video_assets(id),
  watermark_rect TEXT,
  output_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
In `getDb`, add a migration block (alongside the existing `caption_style`/`hook_status` migration blocks, same pattern):
```typescript
  const renderJobColumns = db.prepare("PRAGMA table_info(render_jobs)").all() as { name: string }[];
  if (!renderJobColumns.some((c) => c.name === "watermark_asset_id")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN watermark_asset_id TEXT REFERENCES video_assets(id)");
  }
  if (!renderJobColumns.some((c) => c.name === "watermark_rect")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN watermark_rect TEXT");
  }
```

In `apps/api/src/types.ts`, change `VideoAsset.asset_type` from `"footage" | "music"` to `"footage" | "music" | "watermark"`. Add two fields to the existing `RenderJob` interface: `watermark_asset_id: string | null;`, `watermark_rect: string | null; // JSON-encoded CropRect`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/tests/db.test.ts
git commit -m "feat(api): add watermark_asset_id and watermark_rect columns to render_jobs"
```

---

### Task 3: video-worker — watermark overlay in the render pipeline

**Files:**
- Modify: `apps/video-worker/schemas.py`
- Modify: `apps/video-worker/render.py`
- Modify: `apps/video-worker/tests/test_render.py`

**Interfaces:**
- Consumes: `CropRect` (already exists in `schemas.py`).
- Produces: `RenderJobInput.watermark_path: Optional[str] = None`, `RenderJobInput.watermark_rect: Optional[CropRect] = None`. `render_video` overlays the watermark onto the final output when both are set; produces byte-for-byte the same ffmpeg command as before when either is unset.

- [ ] **Step 1: Add the new fields to `RenderJobInput`**

In `apps/video-worker/schemas.py`, change:
```python
class RenderJobInput(BaseModel):
    segments: list[RenderSegmentInput]
    tts_voice: str
    voices_dir: str
    music_path: Optional[str] = None
    output_path: str
```
to:
```python
class RenderJobInput(BaseModel):
    segments: list[RenderSegmentInput]
    tts_voice: str
    voices_dir: str
    music_path: Optional[str] = None
    watermark_path: Optional[str] = None
    watermark_rect: Optional[CropRect] = None
    output_path: str
```

- [ ] **Step 2: Write failing tests**

Read `apps/video-worker/tests/test_render.py`'s existing `test_render_video_produces_output_and_offsets_captions` test first to see its exact `RenderJobInput`-construction and fixture-path conventions (segment inputs, `voices_dir`, etc.) and match them exactly in the two new tests below.

Add to `apps/video-worker/tests/test_render.py`:
```python
def test_render_video_overlays_watermark_when_present(tmp_path):
    from schemas import CropRect, RenderJobInput, RenderSegmentInput
    from render import render_video

    fixtures = os.path.join(os.path.dirname(__file__), "fixtures")
    watermark_path = os.path.join(fixtures, "sample_watermark.png")

    segment = RenderSegmentInput(
        file_path=os.path.join(fixtures, "short_clip.mp4"),
        trim_start=0,
        trim_end=1,
        order_index=0,
        script_text="hello",
        layout_template="standard",
    )
    job = RenderJobInput(
        segments=[segment],
        tts_voice="id_ID-news_tts-medium",
        voices_dir=os.environ.get("PIPER_VOICES_DIR", "/app/voices"),
        watermark_path=watermark_path,
        watermark_rect=CropRect(x=0.7, y=0.05, width=0.25, height=0.1),
        output_path=str(tmp_path / "output.mp4"),
    )

    result = render_video(job, str(tmp_path))
    assert os.path.exists(result.output_path)
    # A real ffprobe check that the output is a valid, playable video is
    # sufient here -- pixel-level verification of *where* the watermark
    # landed is out of scope for an automated test in this project
    # (established pattern: prior layout/title tests verify the filter
    # string, not rendered pixels).
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", result.output_path],
        capture_output=True,
        text=True,
    )
    assert probe.returncode == 0
    assert float(probe.stdout.strip()) > 0


def test_build_watermark_overlay_filter_computes_pixel_geometry():
    from schemas import CropRect
    from render import _build_watermark_filter

    rect = CropRect(x=0.7, y=0.05, width=0.25, height=0.1)
    filter_str, watermark_input_index = _build_watermark_filter(rect, base_label="v", watermark_input_index=3)

    assert "scale=270:192" in filter_str  # 0.25*1080=270, 0.1*1920=192
    assert "overlay=756:96" in filter_str  # 0.7*1080=756, 0.05*1920=96
    assert "[3:v]" in filter_str
    assert watermark_input_index == 3
```
Add `import subprocess` and `import os` to the top of `test_render.py` if not already present (check first — this file likely already imports `os` given its existing fixture-path usage).

Also add a fixture: a small real PNG the test can pass to `render_video`. Create `apps/video-worker/tests/fixtures/sample_watermark.png` with this exact content (a minimal valid 100x100 PNG is not required — ffmpeg's `scale` filter works on any valid image regardless of source size):
```bash
python3 -c "
from PIL import Image
img = Image.new('RGBA', (200, 100), (255, 0, 0, 200))
img.save('apps/video-worker/tests/fixtures/sample_watermark.png')
"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v -k watermark`
Expected: `ImportError: cannot import name '_build_watermark_filter'` (and the fixture file won't exist yet if Step 2's Python snippet wasn't run — run it now if you haven't).

- [ ] **Step 4: Implement**

Read the current `render_video` function in `apps/video-worker/render.py` in full first (it was last modified by the ASS-karaoke-captions task; confirm the exact current with-music/without-music branches before editing, since line numbers shift between plans).

Add this helper function above `render_video`:
```python
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
```
(`CropRect` is already imported at the top of `render.py` via `from schemas import ...` — check the existing import line and add `CropRect` to it if it isn't already there.)

In `render_video`, both the with-music and without-music `-filter_complex` branches currently end at label `[v]` before `-map`. Modify both branches so that when `job.watermark_path` is set, one more input is added (always last) and the filter chain is extended to `[vout]`, and `-map` uses `[vout]` instead of `[v]`; when `job.watermark_path` is not set, both branches are completely unchanged from their current form.

Replace:
```python
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
                "-stream_loop",
                "-1",
                "-i",
                job.music_path,
                "-filter_complex",
                f"[0:v]subtitles='{escaped_ass_path}'[v];"
                "[2:a]volume=0.2[music];[1:a][music]amix=inputs=2:duration=first[a]",
                "-map",
                "[v]",
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
                "-filter_complex",
                f"[0:v]subtitles='{escaped_ass_path}'[v]",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-shortest",
                final_output,
            ]
        )

    return RenderResult(output_path=final_output, caption_words=all_caption_words)
```
with:
```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v`
Expected: all tests PASS, including the pre-existing full-pipeline test (confirming the no-watermark path is unchanged) and the two new watermark tests. Requires real `ffmpeg` — use the Docker fallback (build the `video-worker` image, run pytest inside a container) if the bare host lacks it, per this project's established pattern.

- [ ] **Step 6: Commit**

```bash
git add apps/video-worker/schemas.py apps/video-worker/render.py apps/video-worker/tests/test_render.py apps/video-worker/tests/fixtures/sample_watermark.png
git commit -m "feat(video-worker): overlay watermark onto final render output when provided"
```

---

### Task 4: api — thread watermark through render submission

**Files:**
- Modify: `apps/api/src/services/videoWorkerClient.ts`
- Modify: `apps/api/src/routes/render.ts`
- Modify: `apps/api/tests/videoWorkerClient.test.ts`
- Modify: `apps/api/tests/render.test.ts`

**Interfaces:**
- Consumes: `render_jobs.watermark_asset_id`/`watermark_rect` (Task 2), video-worker's extended `RenderJobInput` (Task 3).
- Produces: `submitRender`'s signature gains `watermarkPath: string | null`, `watermarkRect: Record<string, number> | null` (two new parameters, appended after the existing `musicPath` parameter). `POST /api/campaigns/:id/render` accepts `watermark_asset_id`/`watermark_rect` in its body.

- [ ] **Step 1: Write failing tests for `submitRender`**

Read `apps/api/tests/videoWorkerClient.test.ts`'s existing `submitRender` test first to match its exact conventions, then add:
```typescript
  it("submitRender includes watermark_path and watermark_rect when provided", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await submitRender(
      "http://video-worker:8100",
      "job-1",
      [],
      "id_ID-news_tts-medium",
      null,
      "/app/video-assets/logo.png",
      { x: 0.7, y: 0.05, width: 0.25, height: 0.1 },
      "http://cb"
    );

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.watermark_path).toBe("/app/video-assets/logo.png");
    expect(body.watermark_rect).toEqual({ x: 0.7, y: 0.05, width: 0.25, height: 0.1 });
  });

  it("submitRender sends null watermark fields when not provided", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await submitRender("http://video-worker:8100", "job-1", [], "id_ID-news_tts-medium", null, null, null, "http://cb");

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.watermark_path).toBeNull();
    expect(body.watermark_rect).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: FAIL — `submitRender` doesn't accept the new arguments (TypeScript will actually fail to compile the test file first; that's the expected failure here).

- [ ] **Step 3: Implement `submitRender`'s new parameters**

In `apps/api/src/services/videoWorkerClient.ts`, change:
```typescript
export async function submitRender(
  videoWorkerUrl: string,
  jobId: string,
  segments: RenderSegmentPayload[],
  ttsVoice: string,
  musicPath: string | null,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      segments,
      tts_voice: ttsVoice,
      music_path: musicPath,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /render failed with status ${res.status}`);
}
```
to:
```typescript
export async function submitRender(
  videoWorkerUrl: string,
  jobId: string,
  segments: RenderSegmentPayload[],
  ttsVoice: string,
  musicPath: string | null,
  watermarkPath: string | null,
  watermarkRect: Record<string, number> | null,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      segments,
      tts_voice: ttsVoice,
      music_path: musicPath,
      watermark_path: watermarkPath,
      watermark_rect: watermarkRect,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /render failed with status ${res.status}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write failing test for the render route**

Read `apps/api/src/routes/render.ts`'s existing `POST /` handler and `apps/api/tests/render.test.ts`'s existing tests in full first (this route already resolves `music_asset_id` to a `musicPath` via `assetPathById` — mirror that exact pattern for the watermark fields). Add to `apps/api/tests/render.test.ts`:
```typescript
  it("resolves watermark_asset_id to a file path and passes watermark_rect through to submitRender", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("watermark-asset-1", campaignId, "/app/video-assets/logo.png", "watermark", 0, "done", now);

    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({
        tts_voice: "id_ID-news_tts-medium",
        watermark_asset_id: "watermark-asset-1",
        watermark_rect: { x: 0.7, y: 0.05, width: 0.25, height: 0.1 },
      });

    expect(res.status).toBe(202);
    const callArgs = (submitRender as jest.Mock).mock.calls[0];
    expect(callArgs[5]).toBe("/app/video-assets/logo.png"); // watermarkPath
    expect(callArgs[6]).toEqual({ x: 0.7, y: 0.05, width: 0.25, height: 0.1 }); // watermarkRect

    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(res.body.job_id) as any;
    expect(job.watermark_asset_id).toBe("watermark-asset-1");
    expect(JSON.parse(job.watermark_rect)).toEqual({ x: 0.7, y: 0.05, width: 0.25, height: 0.1 });
  });

  it("submits a render with no watermark and passes null watermark fields", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    const app = createApp();
    const res = await request(app).post(`/api/campaigns/${campaignId}/render`).send({ tts_voice: "id_ID-news_tts-medium" });

    expect(res.status).toBe(202);
    const callArgs = (submitRender as jest.Mock).mock.calls[0];
    expect(callArgs[5]).toBeNull();
    expect(callArgs[6]).toBeNull();
  });
```
(Match the file's existing `beforeEach` setup for `campaignId`/`dbPath`/the segment-assignment row a render needs to exist — this test brief assumes the same variable names and setup the file's current passing tests already use; read the file first to confirm.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/render.test.ts`
Expected: FAIL — `submitRender` called without the new arguments, `render_jobs` insert doesn't include the new columns.

- [ ] **Step 7: Implement**

In `apps/api/src/routes/render.ts`, find the existing lines:
```typescript
    const musicAssetId: string | null = req.body.music_asset_id ?? null;
    const ttsVoice: string = req.body.tts_voice ?? "id_ID-news_tts-medium";

    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, campaignId, "rendering", ttsVoice, musicAssetId, null, null, now, now);
```
and replace with:
```typescript
    const musicAssetId: string | null = req.body.music_asset_id ?? null;
    const watermarkAssetId: string | null = req.body.watermark_asset_id ?? null;
    const watermarkRect: Record<string, number> | null = req.body.watermark_rect ?? null;
    const ttsVoice: string = req.body.tts_voice ?? "id_ID-news_tts-medium";

    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, watermark_asset_id, watermark_rect, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      jobId,
      campaignId,
      "rendering",
      ttsVoice,
      musicAssetId,
      watermarkAssetId,
      watermarkRect ? JSON.stringify(watermarkRect) : null,
      null,
      null,
      now,
      now
    );
```
Find the existing lines:
```typescript
    const musicPath = musicAssetId ? assetPathById.get(musicAssetId) ?? null : null;

    try {
      await submitRender(
        videoWorkerUrl,
        jobId,
        segmentPayloads,
        ttsVoice,
        musicPath,
        `${callbackBase}/render/${jobId}/complete`
      );
```
and replace with:
```typescript
    const musicPath = musicAssetId ? assetPathById.get(musicAssetId) ?? null : null;
    const watermarkPath = watermarkAssetId ? assetPathById.get(watermarkAssetId) ?? null : null;

    try {
      await submitRender(
        videoWorkerUrl,
        jobId,
        segmentPayloads,
        ttsVoice,
        musicPath,
        watermarkPath,
        watermarkRect,
        `${callbackBase}/render/${jobId}/complete`
      );
```
(`assetPathById` is already populated earlier in this handler from every `video_assets` row for the campaign — it will already contain the watermark asset's path with no further change needed, since it's queried by `campaign_id` alone, not filtered by `asset_type`.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/render.test.ts`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/videoWorkerClient.ts apps/api/src/routes/render.ts apps/api/tests/videoWorkerClient.test.ts apps/api/tests/render.test.ts
git commit -m "feat(api): thread watermark_asset_id/watermark_rect through render submission"
```

---

### Task 5: web-ui — apiClient additions

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`

**Interfaces:**
- Produces: `VideoAsset.asset_type` widened to `"footage" | "music" | "watermark"`; `submitRenderJob` gains two new optional parameters, `watermarkAssetId?: string` and `watermarkRect?: CropRect`.

- [ ] **Step 1: Implement**

In `apps/web-ui/lib/apiClient.ts`, change the `VideoAsset` interface's `asset_type` field from `"footage" | "music"` to `"footage" | "music" | "watermark"`.

Change:
```typescript
export async function submitRenderJob(
  campaignId: string,
  ttsVoice: string,
  musicAssetId?: string
): Promise<{ job_id: string; status: string }> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tts_voice: ttsVoice, music_asset_id: musicAssetId }),
  });
  if (!res.ok) throw new Error(`render submit failed with status ${res.status}`);
  return res.json();
}
```
to:
```typescript
export async function submitRenderJob(
  campaignId: string,
  ttsVoice: string,
  musicAssetId?: string,
  watermarkAssetId?: string,
  watermarkRect?: CropRect
): Promise<{ job_id: string; status: string }> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tts_voice: ttsVoice,
      music_asset_id: musicAssetId,
      watermark_asset_id: watermarkAssetId,
      watermark_rect: watermarkRect,
    }),
  });
  if (!res.ok) throw new Error(`render submit failed with status ${res.status}`);
  return res.json();
}
```
(`CropRect` is already defined and exported earlier in this same file — no new import needed.)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts
git commit -m "feat(web-ui): widen VideoAsset.asset_type and extend submitRenderJob for watermark"
```

---

### Task 6: web-ui — watermark upload option and placement UI

**Files:**
- Modify: `apps/web-ui/components/AssetUpload.tsx`
- Modify: `apps/web-ui/app/campaigns/[id]/segments/page.tsx`

**Interfaces:**
- Consumes: `submitRenderJob` (Task 5), `CropCanvas` (existing component, unmodified), `CropRect` (existing type).
- Produces: a third option in the asset-type upload select; a watermark-selection dropdown + `CropCanvas` on the segments page, wired so the drawn rect and chosen asset flow into `handleSubmit`'s `submitRenderJob` call.

- [ ] **Step 1: Add the upload option**

In `apps/web-ui/components/AssetUpload.tsx`, change:
```tsx
      <select
        name="asset_type"
        defaultValue="footage"
        className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
      >
        <option value="footage">🎬 Footage</option>
        <option value="music">🎵 Music</option>
      </select>
```
to:
```tsx
      <select
        name="asset_type"
        defaultValue="footage"
        className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
      >
        <option value="footage">🎬 Footage</option>
        <option value="music">🎵 Music</option>
        <option value="watermark">💧 Watermark</option>
      </select>
```

- [ ] **Step 2: Add watermark selection + placement to the segments page**

In `apps/web-ui/app/campaigns/[id]/segments/page.tsx`, update the imports:
```tsx
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CropRect,
  SegmentDraft,
  VideoAsset,
  getCampaign,
  listAssets,
  saveSegments,
  submitRenderJob,
} from "../../../../lib/apiClient";
import { SegmentEditor } from "../../../../components/SegmentEditor";
import { CropCanvas } from "../../../../components/CropCanvas";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

function mediaUrl(filePath: string): string {
  return `${API_BASE_URL}/media${filePath.replace("/app/video-assets", "")}`;
}
```
Add new state, alongside the existing `musicAssetId` state:
```tsx
  const [watermarkAssetId, setWatermarkAssetId] = useState<string>("");
  const [watermarkRect, setWatermarkRect] = useState<CropRect | null>(null);
  const watermarkAssets = assets.filter((a) => a.asset_type === "watermark");
  const previewFootageAsset = assets.find((a) => a.asset_type === "footage");
```
Change `handleSubmit`:
```tsx
  async function handleSubmit() {
    setError(null);
    try {
      await saveSegments(params.id, Object.values(drafts));
      const job = await submitRenderJob(
        params.id,
        "id_ID-news_tts-medium",
        musicAssetId || undefined,
        watermarkAssetId || undefined,
        watermarkAssetId && watermarkRect ? watermarkRect : undefined
      );
      router.push(`/campaigns/${params.id}/preview/${job.job_id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }
```
Add a watermark section to the JSX, right after the existing background-music `<div>` block and before the "Submit Render" button:
```tsx
      <div className="rounded-2xl border border-sky-100 bg-sky-50/50 p-5">
        <label className="flex flex-col gap-2 text-sm font-medium text-slate-600 sm:flex-row sm:items-center sm:gap-3">
          Watermark
          <select
            value={watermarkAssetId}
            onChange={(e) => {
              setWatermarkAssetId(e.target.value);
              setWatermarkRect(null);
            }}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
          >
            <option value="">No watermark</option>
            {watermarkAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.file_path.split("/").pop()}
              </option>
            ))}
          </select>
        </label>
        {watermarkAssetId && previewFootageAsset && (
          <div className="mt-3 rounded-xl bg-white p-3">
            <p className="mb-2 text-xs text-slate-400">
              Drag a box for where the watermark should appear (preview uses any selected footage as a visual reference).
            </p>
            <CropCanvas
              imageSrc={mediaUrl(previewFootageAsset.file_path)}
              label="Watermark placement"
              onChange={setWatermarkRect}
            />
          </div>
        )}
        {watermarkAssetId && !previewFootageAsset && (
          <p className="mt-2 text-xs text-rose-500">Assign a footage asset to a segment first to preview placement.</p>
        )}
      </div>
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 4: Manual verification**

No component test framework in this project (established pattern). If a dev server is reachable: upload a watermark image, select it on the segments page, confirm `CropCanvas` appears and drawing a box works, submit a render, and confirm (via `GET .../render/:jobId` or the `render_jobs` table directly) that `watermark_asset_id`/`watermark_rect` were persisted. If a live check isn't possible in this environment, say so honestly rather than claiming it was verified.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/AssetUpload.tsx apps/web-ui/app/campaigns/[id]/segments/page.tsx
git commit -m "feat(web-ui): add watermark upload option and free-form placement UI"
```

---

### Task 7: `segment_assignments.title_rect` schema

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/tests/db.test.ts`

**Interfaces:**
- Produces: `segment_assignments.title_rect TEXT` (nullable, JSON-stringified `CropRect`), migrated for pre-existing DBs.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/db.test.ts`:
```typescript
  it("adds title_rect to segment_assignments, migrated on an existing DB", () => {
    resetDbCacheForTests();
    const oldDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "old-segments-db-")), "app.db");
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE segment_assignments (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        segment_key TEXT NOT NULL,
        video_asset_id TEXT NOT NULL,
        secondary_video_asset_id TEXT,
        trim_start REAL NOT NULL,
        trim_end REAL NOT NULL,
        order_index INTEGER NOT NULL,
        layout_template TEXT NOT NULL,
        crop_gameplay_rect TEXT,
        crop_facecam_rect TEXT,
        title_text TEXT,
        caption_style TEXT
      );
    `);
    oldDb.close();

    const reopened = getDb(oldDbPath);
    const columns = reopened.prepare("PRAGMA table_info(segment_assignments)").all().map((row: any) => row.name);
    expect(columns).toContain("title_rect");
    reopened.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts -t "title_rect"`
Expected: FAIL — column doesn't exist.

- [ ] **Step 3: Implement**

In `apps/api/src/db.ts`, change the `segment_assignments` table definition's final line from:
```sql
  title_text TEXT,
  caption_style TEXT
);
```
to:
```sql
  title_text TEXT,
  caption_style TEXT,
  title_rect TEXT
);
```
Add a migration block alongside the existing ones in `getDb`:
```typescript
  if (!segmentAssignmentColumns.some((c) => c.name === "title_rect")) {
    db.exec("ALTER TABLE segment_assignments ADD COLUMN title_rect TEXT");
  }
```
(Reuse the existing `segmentAssignmentColumns` variable already computed for the `caption_style` migration just above it — do not re-query `PRAGMA table_info` a second time.)

In `apps/api/src/types.ts`, add `title_rect: string | null; // JSON-encoded CropRect` to the existing `SegmentAssignment` interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/tests/db.test.ts
git commit -m "feat(api): add title_rect column to segment_assignments"
```

---

### Task 8: video-worker — `render_title_png` accepts a positioning rect

**Files:**
- Modify: `apps/video-worker/title_render.py`
- Modify: `apps/video-worker/tests/test_title_render.py`

**Interfaces:**
- Consumes: `CropRect` (already exists in `schemas.py`).
- Produces: `render_title_png(title_text: str, output_path: str, rect: Optional[CropRect] = None) -> None`. Task 9 depends on this exact signature; the `rect=None` default keeps every existing caller (and existing test) working unchanged.

- [ ] **Step 1: Write failing tests**

Add to `apps/video-worker/tests/test_title_render.py`:
```python
from schemas import CropRect


def test_render_title_png_without_rect_uses_default_top_position(tmp_path):
    output_path = str(tmp_path / "title.png")
    render_title_png("Top Text", output_path)

    img = Image.open(output_path)
    bbox = img.split()[-1].getbbox()
    assert bbox is not None
    assert bbox[1] < 200  # near the default TITLE_Y=80


def test_render_title_png_with_rect_positions_text_at_rect_y(tmp_path):
    output_path = str(tmp_path / "title.png")
    rect = CropRect(x=0.1, y=0.8, width=0.8, height=0.1)
    render_title_png("Bottom Text", output_path, rect=rect)

    img = Image.open(output_path)
    bbox = img.split()[-1].getbbox()
    assert bbox is not None
    # y=0.8 of 1920 = 1536 -- well below the default top-of-frame position
    assert bbox[1] > 1000


def test_render_title_png_with_rect_centers_within_rect_width(tmp_path):
    output_path = str(tmp_path / "title.png")
    rect = CropRect(x=0.5, y=0.1, width=0.4, height=0.1)  # right half of the frame only
    render_title_png("Right", output_path, rect=rect)

    img = Image.open(output_path)
    bbox = img.split()[-1].getbbox()
    assert bbox is not None
    # centered within [0.5*1080, 0.9*1080] = [540, 972] -- text must start at or after 540,
    # not centered across the full 0-1080 canvas (which would start well before 540)
    assert bbox[0] >= 540
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_title_render.py -v -k rect`
Expected: `TypeError: render_title_png() got an unexpected keyword argument 'rect'`.

- [ ] **Step 3: Implement**

Read the current `apps/video-worker/title_render.py` in full first (shown in this plan's spec background — confirm it matches before editing, since line numbers may have shifted since Sub-proyek 3).

Add the import at the top:
```python
from typing import Optional

from schemas import CropRect
```
Change:
```python
def render_title_png(title_text: str, output_path: str) -> None:
    """Renders title_text onto a transparent 1080x1920 PNG canvas: white fill,
    black stroke, drop shadow, horizontally centered near the top. Unlike
    ffmpeg's drawtext filter, this has no filter-graph escaping concerns --
    apostrophes, colons, percent signs, etc. are handled natively by Pillow."""
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _load_font()

    bbox = draw.textbbox((0, 0), title_text, font=font, stroke_width=STROKE_WIDTH)
    text_w = bbox[2] - bbox[0]
    x = (CANVAS_W - text_w) / 2 - bbox[0]
    y = TITLE_Y
```
to:
```python
def render_title_png(title_text: str, output_path: str, rect: Optional[CropRect] = None) -> None:
    """Renders title_text onto a transparent 1080x1920 PNG canvas: white fill,
    black stroke, drop shadow. Unlike ffmpeg's drawtext filter, this has no
    filter-graph escaping concerns -- apostrophes, colons, percent signs,
    etc. are handled natively by Pillow.

    When `rect` is given, the text is horizontally centered within
    [rect.x*CANVAS_W, (rect.x+rect.width)*CANVAS_W] and vertically anchored
    at rect.y*CANVAS_H, instead of the default full-width-centered/fixed-Y
    position. rect.height is unused (title text is single-line)."""
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _load_font()

    bbox = draw.textbbox((0, 0), title_text, font=font, stroke_width=STROKE_WIDTH)
    text_w = bbox[2] - bbox[0]

    if rect is not None:
        region_x0 = rect.x * CANVAS_W
        region_w = rect.width * CANVAS_W
        x = region_x0 + (region_w - text_w) / 2 - bbox[0]
        y = rect.y * CANVAS_H
    else:
        x = (CANVAS_W - text_w) / 2 - bbox[0]
        y = TITLE_Y
```
(The rest of the function — the two `draw.text(...)` calls and `img.save(...)` — stays exactly as it is; only the signature, docstring, and the `x`/`y` computation change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_title_render.py -v`
Expected: all 6 tests PASS (3 pre-existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/title_render.py apps/video-worker/tests/test_title_render.py
git commit -m "feat(video-worker): let render_title_png position text via an optional rect"
```

---

### Task 9: Thread `title_rect` through video-worker and api

**Files:**
- Modify: `apps/video-worker/schemas.py`
- Modify: `apps/video-worker/render.py`
- Modify: `apps/video-worker/tests/test_render.py`
- Modify: `apps/api/src/routes/segments.ts`
- Modify: `apps/api/tests/segments.test.ts`
- Modify: `apps/api/src/routes/render.ts`
- Modify: `apps/api/tests/render.test.ts`
- Modify: `apps/api/src/services/videoWorkerClient.ts`
- Modify: `apps/api/tests/videoWorkerClient.test.ts`

**Interfaces:**
- Consumes: `render_title_png`'s `rect` parameter (Task 8), `title_rect` DB column (Task 7).
- Produces: `RenderSegmentInput.title_rect: Optional[CropRect] = None` (video-worker wire schema); `_render_single_segment` passes `segment.title_rect` into `render_title_png`; `segments.ts` persists `title_rect` from the PUT body; `render.ts`/`videoWorkerClient.ts` carry it from the DB into the video-worker `/render` payload.

- [ ] **Step 1: video-worker schema**

In `apps/video-worker/schemas.py`, add `title_rect: Optional[CropRect] = None` to `RenderSegmentInput`, right after the existing `title_text: Optional[str] = None` field.

- [ ] **Step 2: Write failing test for the render.py wiring**

Read `apps/video-worker/render.py`'s current `_render_single_segment` function in full first (shown in this plan's Task 3 discussion — confirm the exact current lines before editing). Add to `apps/video-worker/tests/test_render.py`:
```python
def test_render_single_segment_passes_title_rect_to_render_title_png():
    from unittest.mock import patch
    from schemas import CropRect, RenderSegmentInput
    from render import _render_single_segment

    fixtures = os.path.join(os.path.dirname(__file__), "fixtures")
    segment = RenderSegmentInput(
        file_path=os.path.join(fixtures, "short_clip.mp4"),
        trim_start=0,
        trim_end=1,
        order_index=0,
        script_text="hello",
        layout_template="standard",
        title_text="Hello",
        title_rect=CropRect(x=0.1, y=0.8, width=0.8, height=0.1),
    )

    with patch("render.render_title_png") as mock_render_title, patch("render.generate_tts"), patch(
        "render.run_ffmpeg"
    ):
        _render_single_segment(segment, 0, "id_ID-news_tts-medium", "/app/voices", "/tmp")

    mock_render_title.assert_called_once()
    call_args = mock_render_title.call_args
    assert call_args[0][0] == "Hello"
    assert call_args[0][2] == segment.title_rect
```
(Check the exact current parameter order/names `render_title_png` is called with inside `_render_single_segment` before writing this assertion — the brief above assumes it's called positionally as `render_title_png(segment.title_text, title_overlay_path, segment.title_rect)`; adjust `call_args[0][N]`'s index if the actual call passes `rect=` as a keyword instead, in which case assert `call_args.kwargs["rect"] == segment.title_rect` instead.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v -k title_rect`
Expected: FAIL — `render_title_png` mock not called with the rect (still called with only 2 args).

- [ ] **Step 4: Implement**

In `apps/video-worker/render.py`, find:
```python
    title_overlay_path = None
    if segment.title_text:
        title_overlay_path = os.path.join(work_dir, f"segment_{index}_title.png")
        render_title_png(segment.title_text, title_overlay_path)
```
and change to:
```python
    title_overlay_path = None
    if segment.title_text:
        title_overlay_path = os.path.join(work_dir, f"segment_{index}_title.png")
        render_title_png(segment.title_text, title_overlay_path, segment.title_rect)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_render.py -v`
Expected: all tests PASS.

- [ ] **Step 6: Commit the video-worker half**

```bash
git add apps/video-worker/schemas.py apps/video-worker/render.py apps/video-worker/tests/test_render.py
git commit -m "feat(video-worker): thread title_rect from RenderSegmentInput to render_title_png"
```

- [ ] **Step 7: Write failing tests for the api half**

Add `title_rect?: Record<string, number>;` to the `SegmentPayload` interface in `apps/api/src/routes/segments.ts` mentally before writing the test (the test below exercises the behavior this implies). Add to `apps/api/tests/segments.test.ts` (find the existing test that saves segment assignments and posts a full segment payload, matching its exact request-body/assertion conventions):
```typescript
  it("persists title_rect when provided", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          {
            segment_key: "hook",
            video_asset_id: assetId,
            trim_start: 0,
            trim_end: 5,
            order_index: 0,
            layout_template: "standard",
            title_text: "Hello",
            title_rect: { x: 0.1, y: 0.8, width: 0.8, height: 0.1 },
          },
        ],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const row = db.prepare("SELECT * FROM segment_assignments WHERE campaign_id = ?").get(campaignId) as any;
    expect(JSON.parse(row.title_rect)).toEqual({ x: 0.1, y: 0.8, width: 0.8, height: 0.1 });
  });
```
(Match the file's existing `beforeEach`-established `campaignId`/`assetId`/`dbPath` variable names and plan-seeding setup — read the file first to confirm; this brief assumes the same names its other passing tests already use.)

- [ ] **Step 8: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/segments.test.ts -t "title_rect"`
Expected: FAIL — `title_rect` never inserted (column exists from Task 7, but nothing writes to it yet).

- [ ] **Step 9: Implement the api segments.ts change**

Add `title_rect?: Record<string, number>;` to `SegmentPayload` in `apps/api/src/routes/segments.ts`. Change the INSERT statement:
```typescript
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text, caption_style)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
```
to:
```typescript
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text, caption_style, title_rect)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
```
and add `s.title_rect ? JSON.stringify(s.title_rect) : null` as a new final argument to the `insert.run(...)` call.

- [ ] **Step 10: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/segments.test.ts`
Expected: all tests PASS.

- [ ] **Step 11: Write failing tests for render.ts / videoWorkerClient.ts**

Read `apps/api/src/routes/render.ts`'s `segmentPayloads` mapping and `apps/api/src/services/videoWorkerClient.ts`'s `RenderSegmentPayload` interface in full first (both shown earlier in this plan's Task 4 discussion — reconfirm exact current state, since Task 4 of this same plan may have already been applied by the time this task starts). Add to `apps/api/tests/render.test.ts`:
```typescript
  it("includes title_rect in the segment payload sent to submitRender", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    const db = getDb(dbPath);
    db.prepare("UPDATE segment_assignments SET title_rect = ? WHERE campaign_id = ?").run(
      JSON.stringify({ x: 0.1, y: 0.8, width: 0.8, height: 0.1 }),
      campaignId
    );

    const app = createApp();
    await request(app).post(`/api/campaigns/${campaignId}/render`).send({ tts_voice: "id_ID-news_tts-medium" });

    const callArgs = (submitRender as jest.Mock).mock.calls[0];
    const segmentPayloads = callArgs[2];
    expect(segmentPayloads[0].title_rect).toEqual({ x: 0.1, y: 0.8, width: 0.8, height: 0.1 });
  });
```
(This assumes the existing `beforeEach` in `render.test.ts` already seeds one `segment_assignments` row for `campaignId` with a real `video_asset_id` — read the file first to confirm and reuse that exact setup, per the file's own established convention from its other passing tests.)

- [ ] **Step 12: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/render.test.ts -t "title_rect"`
Expected: FAIL — `title_rect` not present in the mapped payload.

- [ ] **Step 13: Implement**

Add `title_rect?: Record<string, number>;` to `RenderSegmentPayload` in `apps/api/src/services/videoWorkerClient.ts`. In `apps/api/src/routes/render.ts`'s `segmentPayloads` map, add a line:
```typescript
      title_rect: s.title_rect ? JSON.parse(s.title_rect) : undefined,
```
(alongside the existing `title_text: s.title_text ?? undefined,` and `caption_style: s.caption_style ?? undefined,` lines in that same object literal).

- [ ] **Step 14: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/render.test.ts`
Expected: all tests PASS.

- [ ] **Step 15: Commit the api half**

```bash
git add apps/api/src/routes/segments.ts apps/api/tests/segments.test.ts apps/api/src/routes/render.ts apps/api/tests/render.test.ts apps/api/src/services/videoWorkerClient.ts
git commit -m "feat(api): thread title_rect from segment assignment through to render submission"
```

---

### Task 10: web-ui — title placement UI

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`
- Modify: `apps/web-ui/components/SegmentEditor.tsx`

**Interfaces:**
- Consumes: `CropCanvas`, `CropRect` (existing).
- Produces: `SegmentDraft.title_rect?: CropRect`; a second `CropCanvas` in `SegmentEditor`, shown whenever `draft.title_text` is non-empty, writing into `draft.title_rect`.

- [ ] **Step 1: Add the field to `apiClient.ts`**

In `apps/web-ui/lib/apiClient.ts`, add `title_rect?: CropRect;` to the existing `SegmentDraft` interface, alongside `title_text?: string;`.

- [ ] **Step 2: Add the UI**

In `apps/web-ui/components/SegmentEditor.tsx`, find the existing title-text `<input>`:
```tsx
        <input
          type="text"
          placeholder="Title text (optional)"
          value={draft.title_text ?? ""}
          onChange={(e) => onChange({ ...draft, title_text: e.target.value })}
          className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        />
```
Leave it exactly as it is, but add a `CropCanvas` right after the `</div>` that closes the `grid gap-3 sm:grid-cols-2` block containing it (i.e., after the title-text input + caption-style select pair), gated on `draft.title_text` being non-empty and `asset` being available:
```tsx
      {draft.title_text && asset && (
        <div className="rounded-xl bg-slate-50 p-3">
          <CropCanvas
            imageSrc={mediaUrl(asset.file_path)}
            label="Title placement"
            initialRect={draft.title_rect ?? null}
            onChange={(rect: CropRect) => onChange({ ...draft, title_rect: rect })}
          />
        </div>
      )}
```
(`CropCanvas` is already imported at the top of this file from Sub-proyek 3; `mediaUrl` and `asset` are already defined earlier in this same component — no new imports needed beyond what's already there.)

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 4: Manual verification**

No component test framework in this project. If a dev server is reachable: type a title, confirm the placement `CropCanvas` appears, drag a box, save segments, and confirm (via the `segment_assignments` table or a `GET` on the campaign) that `title_rect` persisted. If a live check isn't possible in this environment, say so honestly rather than claiming it was verified.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts apps/web-ui/components/SegmentEditor.tsx
git commit -m "feat(web-ui): add free-form title text placement to segment editor"
```

---

## Self-Review Notes

- **Spec coverage — watermark:** free-form placement via `CropCanvas` reuse (not a 4-corner picker) ✓ Task 6; per-render-job (not per-campaign) watermark+rect ✓ Task 2's schema is on `render_jobs`, not `campaigns`/`video_assets`, and Task 6's state lives in the segments-page component, reset per session; applied once to the whole final video, not per-segment ✓ Task 3 modifies only the final mux step, `_render_single_segment`/`layout.py` untouched; PNG/JPEG-only validation ✓ Task 1; no-watermark path byte-for-byte unchanged ✓ Task 3's Review-Focus-driven test asserts this explicitly.
- **Spec coverage — title positioning:** per-segment (not per-render-job/per-campaign) ✓ Task 7's column is on `segment_assignments`, not `render_jobs`; free-form drag via `CropCanvas` reuse ✓ Task 10; `layout.py`'s overlay mechanism untouched, only `render_title_png`'s internal draw position changes ✓ Task 8 modifies only `title_render.py`; falls back to exact current fixed-position behavior when no rect is given (the Review-Focus item added for this addendum) ✓ Task 8's own first test (`test_render_title_png_without_rect_uses_default_top_position`) pins this explicitly.
- **Placeholder scan:** no TBD/TODO; every step has complete code or an exact command.
- **Type consistency:** `watermark_path`/`watermark_rect` (snake_case, matching this project's existing wire-format convention) are identical across Task 3 (Python `RenderJobInput`), Task 4 (Express route body + `submitRender`'s JSON payload), Task 5/6 (web-ui). `submitRender`'s new parameter order (`watermarkPath` then `watermarkRect`, both after `musicPath`, before `callbackUrl`) matches exactly between Task 4's implementation and Task 4's own test assertions on `callArgs[5]`/`callArgs[6]`. `title_rect` is identical across Task 7 (DB column + TS type), Task 8 (Python `render_title_png`'s `rect` parameter — note the DB/wire field is named `title_rect` but the function parameter is named `rect`; Task 9's call site (`render_title_png(segment.title_text, title_overlay_path, segment.title_rect)`) is the exact point where the field name maps onto the parameter name, and no other task needs to know the parameter is called `rect` internally), Task 9 (`RenderSegmentInput.title_rect`, Express route + `RenderSegmentPayload.title_rect`), Task 10 (web-ui `SegmentDraft.title_rect`).
