# Title & Caption Styling (Font, Color, Caption Position) — Design

## Background

Title overlay and caption (subtitle) styling are both currently hardcoded:

- **Title** (`apps/video-worker/title_render.py`): always DejaVu Sans Bold, white fill with a black stroke. Only its screen *position* is operator-configurable (`title_rect`, from a prior sub-project reusing `CropCanvas`).
- **Caption** (`apps/video-worker/render.py`'s `_write_ass`): font is hardcoded `DejaVu Sans` at a fixed size, position is a hardcoded ASS `Alignment`/`MarginV` (bottom-center). Only *color* is operator-configurable, and only via 3 fixed named presets (`default`/`energetic`/`warning`) that bundle a primary/highlight/outline color triple.

This means a BRD requirement like "font must be X, color must be Y" (one of the concrete rule categories this project's own BRD-parsing prompt already extracts into `requirements_checklist`) has no way to actually be satisfied — the render pipeline cannot follow it.

A sibling project on this machine, `clipper-service`, already solved font bundling for exactly this purpose: its Dockerfile downloads Anton and Montserrat Bold (both Google Fonts, OFL-licensed, freely redistributable) at build time and registers them via fontconfig; its `app/styles.py` maps named font choices to the bundled files. This design reuses that proven pattern.

## Goal

Let the operator choose, per segment: a font and color for the title overlay, and a font, color, and approximate screen position for captions — each independently, each falling back to today's exact default behavior when left unset.

## Data Model & UI Pattern

New nullable fields, all per-segment (matching `title_rect`/`title_text`/`caption_style`'s existing per-segment granularity):

- `title_font: string | null`
- `title_color: string | null`
- `caption_font: string | null` (`caption_style` is renamed in meaning, see below — kept as the color field)
- `caption_rect: CropRect | null` (same shape as `title_rect`)

Every one of these follows the same UI pattern already established elsewhere in this app (asset categories, segment labels): a single free-text combobox with suggestions, not separate "preset vs custom" controls. The field's *value* determines how it's resolved:

- **Font fields** (`title_font`, `caption_font`): a bundled preset name (`"dejavu"`, `"anton"`, `"montserrat"`), an `http(s)://` URL, or a path from an uploaded font file (see Font Upload below). Unset, unrecognized, or a failed resolution all fall back to today's default (DejaVu).
- **Color fields** (`title_color`, and `caption_style` reused for caption color): a preset name, or a `#RRGGBB` hex string. Unset or invalid falls back to today's default (white for title, `"default"` preset for caption).
- **Caption position** (`caption_rect`): identical drag-a-box UI as `title_rect`'s existing `CropCanvas` reuse. The operator drags freely; the backend approximates it to the nearest ASS `Alignment`/margin (see Caption Position below) rather than a literal pixel coordinate, since captions render via ffmpeg's ASS subtitle filter (needed to keep the existing per-word karaoke highlight effect), not as a composited PNG like the title.

## Font Resolution

Three recognized forms for `title_font`/`caption_font`, resolved in this order:

1. **Preset name** (`"dejavu"`, `"anton"`, `"montserrat"`) → path to a file bundled in the video-worker Docker image at build time (Anton and Montserrat Bold downloaded exactly as `clipper-service`'s Dockerfile already does — no network dependency at render time).
2. **`http://`/`https://` URL** → downloaded once to a local cache (`/app/font-cache/<sha256(url)>.ttf`), reused on subsequent renders without re-downloading. A bounded download timeout (10s) prevents a dead link from hanging a render.
3. **Uploaded file's local path** (see Font Upload) → used directly, no download needed (already on the shared `video-assets` volume both api and video-worker mount).

Any other value (unset, unrecognized preset name, failed download, invalid font file) falls back to the current default (DejaVu Sans Bold) — a font problem degrades styling, it never fails the render.

## Font Upload

New route, `POST /api/campaigns/:id/fonts` — multipart upload accepting `.ttf`/`.otf` only (validated by extension/mimetype, same pattern as the existing watermark upload's PNG/JPEG check), stored under `<VIDEO_ASSETS_DIR>/fonts/<uuid>.<ext>`. Returns the stored path, which the operator's `title_font`/`caption_font` combobox value then becomes — from video-worker's perspective this is indistinguishable from any other local path once stored (case 3 above).

## Color Resolution

- **Title** (`title_color`): preset names `white` (current default), `yellow`, `black`, `red`, each a fill/stroke pair maintaining the same contrast principle as today's white-fill/black-stroke. A `#RRGGBB` value is used directly as the fill color (stroke stays black for readability against any fill). Invalid/unset falls back to `white`.
- **Caption** (`caption_style`, unchanged field name — it already meant "color" only): the existing 3 presets are unchanged. A `#RRGGBB` value is additionally accepted and used directly as `PrimaryColour` (converted to ASS's `&HBBGGRR` format), with the existing preset's outline color kept. Invalid/unset falls back to `"default"`.

## Caption Position

`caption_rect` (normalized `{x, y, width, height}`, identical shape to `title_rect`) is converted server-side, at render time, into the nearest ASS `Alignment` (numpad-style: bottom/middle/top × left/center/right) plus a computed `MarginV` (vertical) and `MarginL`/`MarginR` (horizontal) — a small, pure conversion function with no failure mode (any rect produces some valid alignment/margin combination). This keeps the operator's drag experience genuinely free-form while the backend approximates within ASS's real constraints (confirmed acceptable in brainstorming: the alternative, switching captions to PNG-per-word compositing for pixel-perfect position, would jeopardize the existing per-word karaoke highlight effect — not worth the tradeoff). Unset `caption_rect` falls back to today's exact fixed bottom-center position (byte-for-byte unchanged ASS header output when no rect is given — this must be pinned by a test, the same "no-op when absent" principle every prior overlay feature in this project has required).

## Global Constraints

- All four new fields are per-segment, matching `title_rect`/`caption_style`'s existing granularity — no new per-campaign or per-render-job scope introduced.
- Font/color/position all fail soft: any resolution failure falls back to the current default, never fails the render.
- Font upload accepts `.ttf`/`.otf` only.
- Font URL downloads are cached (never re-downloaded once fetched) and bounded by a 10s timeout.
- No opacity, blend-mode, gradient, or multi-color-per-word controls — solid colors only, consistent with this project's established "no unrequested feature creep" pattern from the watermark/title-positioning sub-project.
- The existing karaoke per-word caption highlight effect is preserved unchanged — this design explicitly avoids the PNG-compositing alternative that would put it at risk.

## Error Handling

- Font URL unreachable/times out/isn't a valid font file → log a warning, render proceeds with the default font.
- Font upload with a non-`.ttf`/`.otf` file → 400 at upload time, same convention as the existing watermark image-type check.
- Invalid hex string (doesn't match `#RRGGBB`) → falls back to the field's default, no error surfaced to the operator beyond the visual result.
- `caption_rect`/`title_rect` absent → today's exact current behavior, unchanged (already true for `title_rect`; extended to `caption_rect`).

## Testing

- video-worker: unit tests for font resolution (preset hit, URL download+cache with a mocked HTTP call, local-path passthrough, and each fallback case — unrecognized value, failed download, invalid font file), color resolution (hex parse for both title and caption, preset lookup, invalid-value fallback for both), and the rect-to-ASS conversion function (a handful of representative rects — e.g. top-left, bottom-right, dead-center — each asserted against its expected `Alignment`/margin values), plus the explicit no-`caption_rect` byte-for-byte-unchanged-output pin.
- api: route test for the font upload endpoint (accepts `.ttf`/`.otf`, rejects other types, returns a usable path).
- web-ui: manual verification per this project's established "type-check + honest manual-check" pattern (no component test framework) — the font/color comboboxes and the reused `CropCanvas` for `caption_rect`.

## Out of Scope

- Any change to how `title_rect`/title positioning already works (unchanged).
- Any change to the karaoke per-word highlight mechanism itself (unchanged, only its position/font/color become configurable).
- Font/color choices are not validated against BRD `requirements_checklist` automatically — the operator is responsible for matching what the BRD asked for; there is no automated compliance check in this sub-project.
