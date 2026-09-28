# Dynamic Segments & Asset Categories — Design

## Background

The Segments page (`apps/web-ui/app/campaigns/[id]/segments/page.tsx`) currently derives its list of required "segments" directly from `content_plan`'s object keys:

```ts
const segmentKeys = Object.keys(campaign.plan?.content_plan ?? {});
```

`content_plan` is an LLM-generated strategy summary with keys `hook`, `script`, `assets`, `schedule` (`apps/ai-worker/planner.py:43`) — none of `script`, `assets`, or `schedule` are meant to be video segments at all (they're plan metadata: a script outline, which assets to use, a posting schedule). But because the Segments page treats every `content_plan` key as a segment slot, every campaign ends up with four identical `SegmentEditor` instances — including two, `assets` and `schedule`, that make no sense as something you pick a video clip and crop rect for.

Meanwhile, the codebase's own test fixtures (`apps/api/tests/segments.test.ts`) have consistently used `"hook"` and `"body"` as the two real video-segment names since before this bug was noticed — confirming the actual intended segment model was always a short, operator-controlled list of video parts, not a mirror of `content_plan`'s keys.

Separately, the operator wants segments to be freely addable (e.g. insert a B-roll cutaway in the middle) rather than fixed to exactly two, and wants each segment tagged with a category (hook/body/broll/etc.) that narrows which uploaded assets are reasonable choices for it. And rather than typing raw `trim_start`/`trim_end` clock positions, the operator wants to pick a start point and a duration, with the system cutting that piece into its own reusable asset immediately.

## Goal

1. Decouple the Segments page from `content_plan` — segments become a freely add/remove/reorder-able list the operator builds themselves, not a fixed set of required slots.
2. Give assets a category (`asset_type`, already a free `TEXT` column) beyond the current fixed 3 (`footage`/`music`/`watermark`): add `broll` and `clip` as recognized defaults, and let the operator type any new category freely — no fixed enum, no separate categories table.
3. Give each segment a label (`segment_key`) that softly filters the asset-picker dropdown by category, without enforcing the match server-side.
4. Replace manual `trim_start`/`trim_end` entry with a start point (scrubber) + duration (seconds) input. Confirming a segment's start+duration triggers an actual cut: video-worker trims that piece into a new standalone file, registered as a new `video_assets` row with `asset_type: "clip"`, reusable anywhere else in the same campaign. The segment then references this new clip asset directly.

## Architecture

No new services. Three existing services, same responsibilities as every prior sub-project in this codebase:

- **video-worker** gains one new endpoint, `POST /cut` — trims a piece of an existing asset file into a new file. Reuses `ffmpeg_utils.py`'s existing trim-args building (the same primitive `_render_single_segment` already uses to cut a segment's source clip at render time), run as a background task with the established callback pattern.
- **api** gains: a rewritten (looser) `PUT /api/campaigns/:id/segments` validator, a new `GET /api/campaigns/:id/asset-categories` endpoint, a new `cut_jobs` table + `POST /api/campaigns/:id/assets/:assetId/cut` trigger route + `POST /api/internal/cut-jobs/:jobId/complete` callback route, and a loosened `asset_type` acceptance on the existing upload route.
- **web-ui** gets the bulk of the change: the Segments page becomes a dynamic list editor, `SegmentEditor` gains category/duration/cut-status UI, and `AssetUpload` gets a free-text-with-suggestions category picker instead of the current 3-option `<select>`.

`ai-worker`/`content_plan`'s prompt schema is **not** touched in this sub-project — `content_plan` keeps being generated and displayed as-is on the campaign detail page (strategy reference only); this sub-project only removes its use as a segment-key source.

## Data Flow

**Building the segment list:**

1. Operator opens Segments page. It starts empty (or with whatever segments were previously saved) — no longer seeded from `content_plan`.
2. Operator clicks "+ Add Segment". A new blank `SegmentEditor` row appears.
3. Operator types/picks a **label** (`segment_key`) — a combobox suggesting: this campaign's previously-used `segment_key` values (query `DISTINCT segment_key FROM segment_assignments WHERE campaign_id = ?`) plus `hook`/`body` as starting hints, but any free text is accepted.
4. The **source asset** dropdown is filtered client-side (soft filter only, no server enforcement): if the label case-insensitively equals `"broll"`, show assets with `asset_type = "broll"`; otherwise show assets with `asset_type IN ("footage", "clip")`.
5. Operator picks a source asset, then sets a **start point** (existing `TimelineScrubber` component, scrubbing the source asset's preview) and a **duration in seconds**.
6. On confirming duration (blur/enter), web-ui calls `POST /api/campaigns/:id/assets/:assetId/cut` with `{start_seconds, duration_seconds}`. The segment's row shows a **"Memotong..."** status.
7. **api**: creates a `cut_jobs` row (`status: "pending"`), calls video-worker's `POST /cut` with `{file_path, start_seconds, duration_seconds, output_path, callback_url}`, returns 202 immediately.
8. **video-worker**: background task, trims via the existing ffmpeg trim primitive, POSTs the result back to `callback_url` (`{status: "done", output_path, duration_seconds}` or `{error: "..."}`) using the established `_post_callback` helper.
9. **api**'s callback route: on success, inserts a new `video_assets` row (`asset_type: "clip"`, `file_path` = the cut output, `duration_seconds`, `analysis_status: "done"` — already a purpose-cut, ready clip, no further scene/audio analysis needed — `campaign_id` = same as the source asset's), updates `cut_jobs.status = "done"` and `cut_jobs.result_asset_id`. On failure, `cut_jobs.status = "failed"` + `error_message`.
10. **web-ui**: polls the cut job (reusing the same polling pattern established for `analysis_status`/`hook_status`); once `done`, sets that segment draft's `video_asset_id` to the new clip asset's id and clears the "Memotong..." status. On `failed`, shows an inline error and lets the operator retry (re-trigger the cut) or change the start/duration.
11. Operator can reorder segments (up/down buttons reassign `order_index`) or delete a segment (🗑️) at any time. Deleting a segment never deletes its already-cut clip asset — that stays in the library, reusable.
12. `PUT /api/campaigns/:id/segments` saves the final list (same route, loosened validation — see API Endpoints).

**Uploading an asset with a category:**

1. `AssetUpload`'s category field becomes a combobox: 5 defaults (`footage`, `clip`, `broll`, `music`, `watermark`) + any category already used in this campaign (from `GET .../asset-categories`) + free text for a brand-new one.
2. Upload route behavior keyed on the category string: `"music"` → probe audio duration (unchanged); `"watermark"` → PNG/JPEG-only validation, skip duration probe (unchanged); everything else (`footage`, `clip`, `broll`, or any custom value) → treated as video, duration probed via ffprobe (today's `footage` path, now applied to any non-music/non-watermark category instead of collapsing to the literal string `"footage"`).

## Data Model

New table:

```sql
CREATE TABLE IF NOT EXISTS cut_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  source_asset_id TEXT NOT NULL REFERENCES video_assets(id),
  start_seconds REAL NOT NULL,
  duration_seconds REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_asset_id TEXT REFERENCES video_assets(id),
  error_message TEXT,
  created_at TEXT NOT NULL
);
```

`status`: `pending` | `done` | `failed`.

No schema change needed for `video_assets.asset_type` or `segment_assignments.segment_key` — both are already free `TEXT` columns with no `CHECK` constraint.

## API Endpoints

- `PUT /api/campaigns/:id/segments` (api, existing, validation rewritten) — drops the `content_plan`-derived `requiredKeys`/`missingSegments` check entirely. New rules: at least one segment in the submitted array (400 otherwise), `segment_key` unique within the array (400 with `duplicate_segment_keys` otherwise). All existing checks (crop-required-per-template, `trim_end > trim_start`, valid `layout_template`, asset ownership) are unchanged.
- `GET /api/campaigns/:id/asset-categories` (api, new) — returns a deduplicated array of category strings: the 5 defaults (`footage`, `clip`, `broll`, `music`, `watermark`) plus any distinct `asset_type` already used by this campaign's assets.
- `POST /api/campaigns/:id/assets/:assetId/cut` (api, new) — body `{start_seconds: number, duration_seconds: number}`. 404 if the asset doesn't exist or doesn't belong to the campaign. 400 if `duration_seconds <= 0` or `start_seconds < 0`. Creates the `cut_jobs` row, calls video-worker, returns `202 {cut_job_id}`.
- `GET /api/campaigns/:id/cut-jobs/:jobId` (api, new) — returns the `cut_jobs` row (for web-ui polling).
- `POST /api/internal/cut-jobs/:jobId/complete` (api, new, internal) — video-worker's callback target. Body `{status: "done", output_path: string, duration_seconds: number}` or `{error: string}`.
- `POST /cut` (video-worker, new) — body `{file_path: string, start_seconds: number, duration_seconds: number, output_path: string, callback_url: string}`. 202 immediately, background task does the actual ffmpeg trim, same shape as `/analyze`/`/render`/`/find-hooks`.
- `POST /api/campaigns/:id/assets` (api, existing, loosened) — `asset_type` accepted as any non-empty string from the request body instead of the current 3-way ternary; `"music"`/`"watermark"` keep their special validation, everything else gets the existing footage-style duration probe.

## Global Constraints

- Cut result assets are **always** `asset_type: "clip"`, regardless of the segment label being worked on when the cut was triggered — the segment's label is a UI/filter concept only, never written onto the resulting asset.
- The label ↔ category filter on the source-asset dropdown is **soft only** (UI convenience) — never enforced server-side, per explicit operator decision, to keep the workflow flexible (e.g. reusing a `footage` asset directly for a `"broll"`-labeled segment if the operator wants to).
- Assets (including cut clips) are scoped to the campaign (`campaign_id`), not to a single render job or segment — reusable across any future segment/render within the same campaign, matching existing `video_assets` scoping.
- `content_plan`'s prompt schema (`hook`/`script`/`assets`/`schedule`) is unchanged in this sub-project; it remains a strategy-reference display on the campaign detail page, no longer used to derive segments.
- No fixed enum/categories table for `asset_type` or `segment_key` — both stay free `TEXT`, with the 5 default asset categories and previously-used values shown as suggestions only.

## Error Handling

- Cut fails (video-worker: bad start/duration beyond the source's actual length, ffmpeg error) → `cut_jobs.status = "failed"` with `error_message`; the segment stays in the list showing "Gagal dipotong — coba lagi" with its previously-entered start/duration still editable, not removed.
- Deleting a segment while its cut is still `pending` → segment is removed from the draft list immediately; if the cut later completes, the resulting clip asset is still saved to the library (not wasted), just unattached to any segment.
- `PUT /segments` is rejected (400) if any segment still has no `video_asset_id` (i.e., its cut hasn't completed yet) — same principle as the existing crop/trim validation, extended to cover the new pending-cut case.
- `POST .../cut` with `duration_seconds` longer than what remains of the source asset past `start_seconds` → video-worker's ffmpeg trim naturally produces a shorter-than-requested output (ffmpeg's normal trim-past-EOF behavior) rather than erroring; the callback still reports `done` with the actual resulting `duration_seconds`, which may be less than requested. No special-case handling needed beyond passing the real duration back.

## Testing

- video-worker: unit tests for the `/cut` endpoint (202 + background task calls trim + posts callback), and for the trim-args reuse (confirm it's the same primitive `_render_single_segment` already uses, not a duplicate implementation).
- api: route tests for `PUT /segments`'s new validation (empty array, duplicate keys, still-pending cut), `GET /asset-categories` (defaults + campaign-specific), `POST .../cut` (404/400/202 paths), the internal callback (success inserts `video_assets` + updates `cut_jobs`; failure marks `cut_jobs` failed), and the loosened upload route (custom category accepted, music/watermark special-casing unchanged).
- web-ui: manual verification per this project's established "type-check + honest manual-check" pattern (no component test framework) — add/remove/reorder segments, category combobox suggestions, cut status transitions, applying a completed clip to a segment.

## Out of Scope (this sub-project)

- YouTube-link asset ingestion (separate sub-project, spec written next; this sub-project's category work — specifically `footage`/`clip` — is a direct dependency it builds on).
- `content_plan`'s LLM prompt schema itself (still `hook`/`script`/`assets`/`schedule`, unchanged).
- Any change to the render pipeline's segment concat/layout logic — segments still concat via `order_index` exactly as today; this sub-project only changes how a segment's `video_asset_id`/`trim_start`/`trim_end` are populated, not how they're consumed at render time.
