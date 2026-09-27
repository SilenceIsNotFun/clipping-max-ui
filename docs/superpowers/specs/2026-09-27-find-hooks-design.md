# Find Hooks (Gemini-Powered Moment Suggestion) — Design

## Background

ContentRewardFarm's existing moment-detection (`detect_audio_peaks`/`detect_scene_changes`, generic audio-loudness and scene-cut signal processing) does not understand what a moment is *about*. Real operator feedback, backed by a real BRD ("Todd V Phase 2") and a real third-party tool the operator already uses (built on Gemini's video-understanding API), confirms that finding a genuinely good "hook" requires understanding the video's actual content — not signal spikes.

This sub-project adds a content-aware "Find Hooks" feature: the operator sends a footage asset to Gemini (Google's multimodal LLM, which can ingest a video file directly and reason about its audio+visual content) along with the campaign's BRD requirements, and gets back concrete hook/payoff candidates with suggested titles, ready to drop straight into a segment.

This is independent of and does not replace the existing `moment_candidates` (audio-peak/scene-change) feature — both remain available. It also does not touch the render pipeline, layout templates, or captions (Sub-proyek 3's territory).

## Goal

Given a footage asset and its campaign's plan (requirements checklist, hook/strategy fields), let the operator request Gemini's opinion on which time ranges make the strongest hook/payoff, with a suggested title for each — then apply one of those suggestions to a segment with one click, auto-filling `trim_start`, `trim_end`, and `title_text`.

## Architecture

Three services already exist and each keeps its existing responsibility:
- **video-worker** owns the video file and everything that touches it directly (ffmpeg, face/crop detection, render). It gains the new Gemini call here because it already has the file on its local volume — no new cross-service file transfer needed.
- **api** owns persistence and orchestration between services — unchanged in kind, just a new table and two new routes.
- **web-ui** gains one new UI surface (a "Suggested Hooks" panel in the segment editor).

**ai-worker is NOT involved.** It only ever talks to Ollama and only ever sees BRD document text, not video files, and adding a `video-assets` volume mount to it just to make a text-only proxy call would duplicate video-worker's existing async-job/callback plumbing for no benefit.

## Data Flow

1. Operator clicks "Find Hooks 🎯" next to a footage asset (only enabled once that asset's existing `analysis_status` is `done` — reuses the existing signal, doesn't add a new precondition to check for).
2. **web-ui** calls `POST /api/campaigns/:id/assets/:assetId/find-hooks`.
3. **api**:
   - Loads the asset (404 if missing) and the campaign's latest `plans` row (400 if no plan exists yet — hooks need BRD context, and there's no plan before the two-step campaign flow reaches `planned`). `plans.requirements_checklist` and `plans.content_plan` are both stored as JSON-stringified TEXT columns (same as everywhere else this table is read) — `JSON.parse` both; the hook direction is `JSON.parse(content_plan).hook`, not a top-level plan column.
   - Sets `video_assets.hook_status = 'pending'`.
   - Calls **video-worker**'s `POST /find-hooks` with `{video_asset_id, file_path, requirements_checklist: string[], hook: string, strategy_summary: string, callback_url}` (already-parsed values, not raw JSON strings), mirroring the existing `analyzeAsset` client pattern. Returns 202 to the operator immediately.
4. **video-worker**: background task (same `BackgroundTasks` pattern as `/analyze`):
   - Uploads the video file to Gemini's File API.
   - Prompts Gemini (a `gemini-2.5-flash`-class model — cheap, fast, video-capable) with the BRD context and an instruction to return structured JSON: a list of hook candidates, each `{start_seconds, end_seconds, title, reasoning}`.
   - POSTs the parsed result back to `callback_url` (or `{error: "..."}` on failure) — same `_post_callback` helper Sub-proyek 3 already added for reliability (raises on non-2xx, logs on failure instead of silently vanishing).
5. **api**'s new internal callback route inserts each candidate into `hook_suggestions` and sets `video_assets.hook_status = 'done'` (or `'failed'` with a `review_tasks`-style reason on error, but scoped to this asset, not the whole campaign).
6. **web-ui**: the assets/segment-editor pages poll `hook_status` the same way they already do for `analysis_status`, and once `done`, fetch `GET .../hook-suggestions` and render the panel.

## Data Model

New table:

```sql
CREATE TABLE IF NOT EXISTS hook_suggestions (
  id TEXT PRIMARY KEY,
  video_asset_id TEXT NOT NULL REFERENCES video_assets(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`video_assets` gains one column: `hook_status TEXT NOT NULL DEFAULT 'none'` (`none` | `pending` | `done` | `failed`) — additive column, needs the same idempotent `ALTER TABLE` migration pattern Sub-proyek 3 already established in `getDb` for `caption_style` (an existing DB predates this feature too).

## API Endpoints

- `POST /api/campaigns/:id/assets/:assetId/find-hooks` (api, new) — triggers the pipeline. 404 if asset not found, 400 if no plan exists yet for the campaign. 202 on success.
- `GET /api/campaigns/:id/assets/:assetId/hook-suggestions` (api, new) — returns the array of `hook_suggestions` rows for that asset (empty array if `hook_status` isn't `done` yet, not an error — same shape as the existing `listMoments`).
- `POST /api/internal/assets/:assetId/hooks-complete` (api, new, internal) — video-worker's callback target. Body: `{hook_suggestions: [{start_ms, end_ms, title, reasoning}, ...]}` on success, or `{error: string}` on failure.
- `POST /find-hooks` (video-worker, new) — `{video_asset_id, file_path, requirements_checklist: string[], hook: string, strategy_summary: string, callback_url}`. 202 immediately, same as `/analyze`.

## Prompt & Response Contract (video-worker → Gemini)

Gemini is asked for strict JSON (same "may not follow a fence instruction" resilience Sub-proyek 3's `parse_llm_response` already handles — reuse that fallback-extraction logic rather than re-inventing it for this second LLM caller):

```
You are helping a video clipper find the strongest hook moments in this footage for a brand reward campaign.

Campaign hook direction: {hook}
Campaign strategy: {strategy_summary}
Requirements the final clip MUST satisfy: {requirements_checklist joined as bullet list}

Watch the video and identify the 3-5 strongest hook/payoff moments. For each, give:
- start_seconds, end_seconds (a tight window covering just that moment, typically 15-45 seconds)
- title: a short, punchy suggested clip title
- reasoning: one sentence on why this moment works as a hook, and how it fits the requirements above

Respond with ONLY a JSON array of objects with keys: start_seconds, end_seconds, title, reasoning.
```

## Global Constraints

- No YouTube heatmap or other external engagement data (consistent with Sub-proyek 3's existing constraint) — Gemini's own video understanding is the only signal, nothing retention-based, since most footage here isn't a public YouTube video with retention data available at all.
- Manual trigger only — never runs automatically on upload (unlike crop-suggestion), since it's a paid external API call and can take a while for longer footage.
- Advisory only, same principle as crop-suggestion: a suggestion only pre-fills a segment's `trim_start`/`trim_end`/`title_text` when the operator clicks it. Nothing writes to `segment_assignments` on its own.
- 3-5 suggestions per run, not configurable in this MVP.
- No re-run deduplication logic: clicking "Find Hooks" again on the same asset appends a fresh set of rows (old ones stay, both shown) — simplest correct behavior, avoids deciding a replace-vs-append policy prematurely.

## Known Limitation (MVP)

Very long source videos (multi-hour VODs) may exceed what a single Gemini File API call handles well, both in practical processing time and in the model's ability to pinpoint specific moments across hours of content in one pass. No chunking/splitting is implemented for this MVP — if this proves to be a real problem in practice, it's a natural follow-up (split the file into e.g. 20-30 minute segments and run one Gemini call per segment, then merge/rank results, mirroring the chunking approach originally considered before this design pivoted to Gemini's native video understanding).

## Error Handling

- Missing `GEMINI_API_KEY` or any Gemini API error (quota, invalid file, timeout) → video-worker catches it in the same try/except shape as `_run_analysis`, calls `_post_callback` with `{error: str(exc)}`, api sets `hook_status = 'failed'`.
- Malformed/non-JSON Gemini response → same fallback-JSON-extraction as `parser.py`'s LLM response handling; if that still fails, treated as a `ValueError` → `failed`.
- `find-hooks` called with no plan yet → 400, clear error message telling the operator to generate a plan first.

## Testing

- video-worker: unit tests for prompt-building, response-parsing (valid JSON, JSON without fence, malformed JSON), and the Gemini client call itself mocked (no real API calls in the test suite — consistent with how `call_ollama` is tested).
- api: route tests for the two new endpoints plus the internal callback, following the existing `assets.test.ts`/`internal.test.ts` patterns (mocked video-worker client).
- web-ui: the new panel component, manually verified in a browser per this project's established "type-check + honest manual-check" pattern (no component test framework in this project).
- One real end-to-end check against the actual Gemini API is the user's responsibility post-merge (needs a real `GEMINI_API_KEY`, which isn't available in this development environment) — same "live check on your machine" pattern already used for GPU/Ollama verification earlier in this project's history.
