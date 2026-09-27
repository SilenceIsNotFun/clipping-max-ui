# Watermark Overlay — Design

> **Addendum:** this spec also covers free-form title-text positioning (see "Title Text Positioning" section below) — a small, analogous feature added after the initial design, reusing the exact same `CropRect`/`CropCanvas` pattern this spec already establishes for the watermark itself.

## Background

Real BRDs require a brand watermark burned into every clip (e.g. "Add Watermark every video you edit," confirmed against a real BRD). ContentRewardFarm currently has no concept of a non-video/non-music asset at all — `video_assets.asset_type` only ever holds `"footage"` or `"music"`, and every upload is validated as a playable audio/video file via `ffprobe`, which rejects a static image outright (0 duration).

## Goal

Let the operator upload a logo/watermark image, place it anywhere on the frame with a free-form drag (reusing the existing crop-drawing interaction, not a fixed corner picker), and have it burned into the final rendered video. Different render jobs of the same campaign may use different watermarks and/or different placements.

## Data Flow

1. **Upload**: operator uploads an image via the existing asset upload form with a new `asset_type` option, `"watermark"`.
2. **Segments page**: after picking segments and (optionally) background music, the operator picks a watermark asset from a dropdown (only shows assets with `asset_type = "watermark"`). Once picked, a `CropCanvas` appears showing a representative video frame (any already-selected segment's footage — purely a visual reference; the resulting rect is a normalized 0-1 fraction of the final 1080x1920 canvas, independent of which frame is shown) so the operator drags a box for where the watermark should sit and how big it should be.
3. **Submit Render**: the chosen `watermark_asset_id` and the drawn `watermark_rect` (reusing the existing `CropRect` shape/type, not a new one) are sent alongside the existing `music_asset_id`/`tts_voice` fields.
4. **api**: resolves `watermark_asset_id` to its `file_path`, stores both `watermark_asset_id` and `watermark_rect` (JSON-stringified, same convention as `segment_assignments.crop_gameplay_rect`) on the `render_jobs` row, and forwards `watermark_path` + `watermark_rect` to video-worker's `/render` call.
5. **video-worker**: after the existing subtitle-burn-in stage (and music mix, if present) produces `[v]`, add one more input (the watermark image) and one more filter stage that scales it to the rect's pixel size and overlays it onto `[v]`, producing the actual final output. Applied once to the whole assembled video — a watermark is not a per-segment concept.

## Data Model Changes

No new tables. Additive columns only:

```sql
-- video_assets.asset_type already has no CHECK constraint (plain TEXT) --
-- no schema change needed there; "watermark" is just a new value used in code.

ALTER TABLE render_jobs ADD COLUMN watermark_asset_id TEXT REFERENCES video_assets(id);
ALTER TABLE render_jobs ADD COLUMN watermark_rect TEXT; -- JSON-stringified CropRect, nullable
```

Both follow the same idempotent `PRAGMA table_info` + `ALTER TABLE` migration pattern already established in `getDb` for `segment_assignments.caption_style` — an existing deployed DB predates this feature.

## Upload Validation Changes

`apps/api/src/routes/assets.ts`'s `POST /` currently always calls `probeDurationSeconds` (via `ffprobe`) and rejects the upload (400) if duration is `<= 0` — correct for footage/music, wrong for a static image, which legitimately has no duration.

- When `req.body.asset_type === "watermark"`: skip the `ffprobe` duration probe entirely, store `duration_seconds: 0`, and skip the `analyzeAsset` call (identical to how `"music"` already skips analysis today — the existing `assetType === "footage" ? "pending" : "done"` branch already generalizes correctly to a third type with no code change needed there).
- Add a lightweight content-type check instead (`image/png` or `image/jpeg` only) so a video accidentally tagged "watermark" doesn't silently store an unusable multi-gigabyte file with `duration_seconds: 0`.

## API/Client Changes

- `POST /api/campaigns/:id/render` (api, existing route) gains two optional body fields: `watermark_asset_id`, `watermark_rect` (`{x, y, width, height}`, same shape as `CropRect`). Both flow straight into the existing `render_jobs` INSERT (two new columns) and the existing `submitRender` call (two new arguments).
- `submitRender` (api's `videoWorkerClient.ts`) gains two new parameters: `watermarkPath: string | null`, `watermarkRect: CropRect | null` — forwarded as `watermark_path`/`watermark_rect` in the JSON body to video-worker's `/render`.
- `RenderJobInput` (video-worker's `schemas.py`) gains `watermark_path: Optional[str] = None`, `watermark_rect: Optional[CropRect] = None` (reuses the existing `CropRect` model — no new schema class).

## Render Pipeline Change (video-worker)

In `render_video` (`render.py`), both the with-music and without-music branches currently end their `-filter_complex` chain at a label `[v]` (video-with-captions-burned-in) before `-map`. When `job.watermark_path` is set:

1. Add the watermark image as one more `-i` input (after `concat_voiceover` and, if present, `job.music_path` — always last, same "extra input always last" convention Sub-proyek 3 already established for the title-PNG overlay).
2. Compute pixel geometry from the normalized rect against the fixed 1080x1920 canvas: `w = round(watermark_rect.width * 1080)`, `h = round(watermark_rect.height * 1920)`, `x = round(watermark_rect.x * 1080)`, `y = round(watermark_rect.y * 1920)`.
3. Extend the filter graph: `;[N:v]scale={w}:{h}[wm];[v][wm]overlay={x}:{y}[vout]` (where `N` is the watermark input's index), and change `-map "[v]"` to `-map "[vout]"` for that branch.
4. When no watermark is set, the pipeline is byte-for-byte unchanged (no new input, no new filter stage, `-map "[v]"` as today) — this is purely additive, gated on `job.watermark_path`.

## Global Constraints

- Watermark placement is per-render-job, not per-campaign or per-segment (confirmed: different render jobs of the same campaign may use different watermarks/placements).
- No aspect-ratio lock enforced on the drawn rect — if the operator draws a rect with a different aspect ratio than the source logo image, the logo stretches to fill it (ffmpeg `scale` with explicit `w:h` does this by default). Acceptable for MVP; not treated as a bug.
- Watermark image validated as PNG/JPEG only at upload time.
- No watermark opacity/blend-mode control in this MVP — the image is overlaid as-is (a logo with a transparent PNG background composites correctly via ffmpeg's `overlay`; a plain JPEG watermark will be fully opaque, which is the operator's own choice of source asset).

## Testing

- api: route tests for the extended `POST /:id/render` (with and without watermark fields) and the upload-validation branch for `asset_type: "watermark"` (accepts an image with no duration probe, rejects a non-image content-type), following existing `assets.test.ts`/`render.test.ts` patterns.
- video-worker: unit tests for the geometry computation (rect → pixel x/y/w/h) and for `_build`-style filter-string assembly (mirroring how `layout.py`'s filter-string tests work), plus one real-ffmpeg end-to-end render test with a watermark asset (extending the existing full-pipeline test fixture set).
- web-ui: manual verification (no component test framework in this project) — confirm the watermark dropdown + `CropCanvas` reuse renders and the resulting rect round-trips through a render submission.

## Title Text Positioning (Addendum)

### Background

Title text (`segment_assignments.title_text`, rendered by `apps/video-worker/title_render.py`'s `render_title_png`) is currently always drawn at a fixed position: horizontally centered across the full 1080-wide canvas, `TITLE_Y = 80` pixels from the top. A real BRD-driven layout (e.g. a `cinematic_letterbox` clip with the explanatory title fixed at the top and a watermark at bottom-center) already works with this fixed position for the title half — but the operator should still be able to move it, for layouts where top-center isn't right.

### Design

Reuse the exact same pattern as watermark placement in this same spec: a `CropRect` drawn via `CropCanvas`, stored per-segment (title text is already a per-segment concept, unlike the watermark which is per-render-job), applied by changing where `render_title_png` draws the text within its existing full 1080x1920 transparent canvas — **not** by changing `layout.py`'s overlay mechanism at all, since the title PNG is already composited via a full-canvas `overlay=0:0`.

- `segment_assignments` gains one column: `title_rect TEXT` (nullable, JSON-stringified `CropRect`, same convention as `crop_gameplay_rect`).
- `render_title_png(title_text: str, output_path: str, rect: Optional[CropRect] = None) -> None` — when `rect` is provided, the text is horizontally centered within `[rect.x * 1080, (rect.x + rect.width) * 1080]` (instead of the full canvas width) and vertically anchored at `rect.y * 1920` (instead of the fixed `TITLE_Y`). `rect.height` is not used (title text is single-line; the box only constrains horizontal centering and vertical position). When `rect` is `None`, behavior is completely unchanged from today (full-width centering, fixed `TITLE_Y`) — this keeps the function backward compatible for any caller that doesn't pass a rect.
- `RenderSegmentInput` (video-worker's wire schema) gains `title_rect: Optional[CropRect] = None`. `_render_single_segment` passes `segment.title_rect` through to `render_title_png`.
- Web-ui: `SegmentEditor` gets a second `CropCanvas` (alongside the existing crop-region ones), shown whenever `title_text` is non-empty, storing the drawn rect into `draft.title_rect`.

### Global Constraints (title positioning)

- Per-segment, not per-campaign or per-render-job (title text itself is already per-segment; this stays consistent with that).
- No new visual constraint validation (e.g. text overflowing the frame edge) — same "ffmpeg just clips, no crash" acceptance as the watermark's edge-of-frame case.
