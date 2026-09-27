# Find Hooks (Gemini-Powered Moment Suggestion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator send a footage asset to Gemini (with the campaign's BRD requirements as context) and get back 3-5 concrete hook/payoff candidates — each a time range, a suggested title, and a one-line reason — that can be applied to a segment with one click.

**Architecture:** `video-worker` gains a new async endpoint (`POST /find-hooks`, same 202+background-task+callback shape as the existing `/analyze`) that uploads the footage file to Gemini's File API and asks it for structured JSON hook candidates. `api` persists the results in a new `hook_suggestions` table and exposes them to `web-ui`, which gets a "Find Hooks" button and a "Suggested Hooks" panel in the segment editor. `ai-worker` is not involved — it never sees video files.

**Tech Stack:** `google-genai` (official Google GenAI Python SDK) in `video-worker`, added to the existing FastAPI/Express/Next.js stack.

**Spec:** `docs/superpowers/specs/2026-09-27-find-hooks-design.md`

## Global Constraints

- Manual trigger only — never runs automatically on upload.
- Advisory only: a suggestion only pre-fills `trim_start`/`trim_end`/`title_text` on a segment when the operator clicks it; nothing writes to `segment_assignments` automatically.
- 3-5 suggestions per run, not configurable in this MVP.
- No re-run deduplication: clicking "Find Hooks" again appends a fresh set of rows; old ones stay.
- No YouTube heatmap or other external engagement data — Gemini's own video understanding is the only signal.
- ai-worker is never involved in this feature; video-worker calls Gemini directly since it already has the file.

## Review Focus

- **Gemini API key missing or invalid at runtime** — the pipeline must fail the asset's `hook_status` to `failed` with a readable reason, not crash the background task silently or leave `hook_status` stuck at `pending` forever (the exact bug class Sub-proyek 3 already had to fix once for `/analyze`).
- **`find-hooks` called before a plan exists** — the route must 400 with a clear message, not crash trying to read a `null` plan's fields.
- **Gemini returns prose-wrapped or unfenced JSON** — smaller/less-compliant models (and Gemini itself, depending on prompt adherence) may not wrap output in a ```json fence; the parser must fall back to extracting the outermost `[...]` span, mirroring the exact fallback `ai-worker/planner.py` already had to add for the same failure mode.
- **`find-hooks` called on an asset from a DB created before this feature shipped** — `video_assets.hook_status` must be added via the same idempotent `PRAGMA table_info` + `ALTER TABLE` migration already established for `caption_style`, not a bare `CREATE TABLE IF NOT EXISTS` (a no-op on an existing table).
- **Multiple existing `hook_suggestions` rows for the same asset** — `GET .../hook-suggestions` must return every row (all runs so far), not silently overwrite/replace, per the explicit "no dedup" constraint above; a task that only tests a single run's output would miss this.

---

## File Structure

```
apps/video-worker/
  schemas.py                    # MODIFY: add HookSuggestion
  hook_finder.py                   # NEW: Gemini prompt building, response parsing, API call
  main.py                            # MODIFY: /find-hooks route + background task
  requirements.txt                     # MODIFY: add google-genai
  tests/
    test_hook_finder.py                  # NEW

apps/api/
  src/
    db.ts                        # MODIFY: hook_suggestions table + hook_status migration
    types.ts                       # MODIFY: HookSuggestion type, VideoAsset.hook_status
    routes/
      assets.ts                     # MODIFY: POST /:assetId/find-hooks, GET /:assetId/hook-suggestions
      internal.ts                     # MODIFY: POST /assets/:assetId/hooks-complete
    services/
      videoWorkerClient.ts               # MODIFY: findHooks function
  tests/
    db.test.ts, assets.test.ts, internal.test.ts, videoWorkerClient.test.ts   # all MODIFY

apps/web-ui/
  lib/apiClient.ts               # MODIFY: HookSuggestion type, findHooks, getHookSuggestions
  components/
    SegmentEditor.tsx              # MODIFY: "Find Hooks" button + suggestions panel
```

---

### Task 1: `HookSuggestion` schema and `google-genai` dependency

**Files:**
- Modify: `apps/video-worker/schemas.py`
- Modify: `apps/video-worker/requirements.txt`

**Interfaces:**
- Produces: `HookSuggestion` Pydantic model (`start_ms: int`, `end_ms: int`, `title: str`, `reasoning: str`). Task 2 depends on this exact shape.

- [ ] **Step 1: Add the dependency**

Add to `apps/video-worker/requirements.txt`:
```
google-genai==1.21.1
```

- [ ] **Step 2: Add the schema**

Add to `apps/video-worker/schemas.py` (after the existing `RenderResult` class at the end of the file):
```python
class HookSuggestion(BaseModel):
    start_ms: int
    end_ms: int
    title: str
    reasoning: str
```

- [ ] **Step 3: Verify the dependency installs**

Run:
```bash
cd apps/video-worker && pip install --quiet google-genai==1.21.1 2>&1 | tail -5
python3 -c "from google import genai; print('genai import OK')"
```
Expected: `genai import OK`. If the bare host lacks network access or pip is restricted, verify via the Docker build instead (build the `video-worker` image and run the same check inside a container — established pattern from every prior video-worker task).

- [ ] **Step 4: Commit**

```bash
git add apps/video-worker/schemas.py apps/video-worker/requirements.txt
git commit -m "feat(video-worker): add HookSuggestion schema and google-genai dependency"
```

---

### Task 2: `hook_finder.py` — prompt building and response parsing

**Files:**
- Create: `apps/video-worker/hook_finder.py`
- Create: `apps/video-worker/tests/test_hook_finder.py`

**Interfaces:**
- Consumes: `HookSuggestion` from `schemas.py` (Task 1).
- Produces: `build_prompt(hook: str, strategy_summary: str, requirements_checklist: list[str]) -> str`; `parse_hook_response(raw: str) -> list[HookSuggestion]`. Task 3 depends on both exact names/signatures.

- [ ] **Step 1: Write failing tests**

`apps/video-worker/tests/test_hook_finder.py`:
```python
import pytest

from hook_finder import build_prompt, parse_hook_response


def test_build_prompt_includes_all_inputs():
    prompt = build_prompt(
        hook="Lead with the Bitcoin prize",
        strategy_summary="Fast cuts, high energy, trending audio",
        requirements_checklist=["Length: 30-59 seconds", "Talking head only"],
    )
    assert "Lead with the Bitcoin prize" in prompt
    assert "Fast cuts, high energy, trending audio" in prompt
    assert "Length: 30-59 seconds" in prompt
    assert "Talking head only" in prompt


def test_build_prompt_handles_empty_checklist():
    prompt = build_prompt(hook="hook", strategy_summary="strategy", requirements_checklist=[])
    assert "none specified" in prompt


def test_parse_hook_response_extracts_json_from_fenced_block():
    raw = """Here are the hooks:
```json
[
  {"start_seconds": 12.5, "end_seconds": 38.0, "title": "He Bet a Bitcoin on THIS", "reasoning": "Opens on the prize reveal, matches the required hook direction."}
]
```
"""
    result = parse_hook_response(raw)
    assert len(result) == 1
    assert result[0].start_ms == 12500
    assert result[0].end_ms == 38000
    assert result[0].title == "He Bet a Bitcoin on THIS"
    assert "prize reveal" in result[0].reasoning


def test_parse_hook_response_extracts_json_without_fence():
    raw = '[{"start_seconds": 5, "end_seconds": 20, "title": "Clip A", "reasoning": "Reason A"}]'
    result = parse_hook_response(raw)
    assert len(result) == 1
    assert result[0].start_ms == 5000
    assert result[0].end_ms == 20000


def test_parse_hook_response_handles_multiple_candidates():
    raw = """[
  {"start_seconds": 0, "end_seconds": 15, "title": "A", "reasoning": "ra"},
  {"start_seconds": 100, "end_seconds": 130, "title": "B", "reasoning": "rb"},
  {"start_seconds": 200, "end_seconds": 225, "title": "C", "reasoning": "rc"}
]"""
    result = parse_hook_response(raw)
    assert len(result) == 3
    assert [r.title for r in result] == ["A", "B", "C"]


def test_parse_hook_response_raises_on_missing_json():
    with pytest.raises(ValueError):
        parse_hook_response("no json here at all")


def test_parse_hook_response_raises_on_malformed_json():
    with pytest.raises(ValueError):
        parse_hook_response("[ this is not valid json ]")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_hook_finder.py -v`
Expected: `ModuleNotFoundError: No module named 'hook_finder'`.

- [ ] **Step 3: Implement**

`apps/video-worker/hook_finder.py`:
```python
import json
import re

from schemas import HookSuggestion

JSON_ARRAY_RE = re.compile(r"```(?:json)?\s*(\[.*?\])\s*```", re.DOTALL)

PROMPT_TEMPLATE = """You are helping a video clipper find the strongest hook moments in this footage for a brand reward campaign.

Campaign hook direction: {hook}
Campaign strategy: {strategy_summary}
Requirements the final clip MUST satisfy:
{requirements_checklist}

Watch the video and identify the 3-5 strongest hook/payoff moments. For each, give:
- start_seconds, end_seconds (a tight window covering just that moment, typically 15-45 seconds)
- title: a short, punchy suggested clip title
- reasoning: one sentence on why this moment works as a hook, and how it fits the requirements above

Respond with ONLY a JSON array of objects with keys: start_seconds, end_seconds, title, reasoning.
"""


def build_prompt(hook: str, strategy_summary: str, requirements_checklist: list[str]) -> str:
    checklist_text = "\n".join(f"- {item}" for item in requirements_checklist) or "- none specified"
    return PROMPT_TEMPLATE.format(hook=hook, strategy_summary=strategy_summary, requirements_checklist=checklist_text)


def parse_hook_response(raw: str) -> list[HookSuggestion]:
    match = JSON_ARRAY_RE.search(raw)
    if match:
        candidate = match.group(1)
    else:
        # Gemini (like the smaller local models this project already deals
        # with in ai-worker/planner.py) doesn't always wrap output in a
        # ```json fence -- fall back to the outermost [...] span.
        start = raw.find("[")
        end = raw.rfind("]")
        if start == -1 or end == -1 or end < start:
            raise ValueError("no JSON array found in Gemini response")
        candidate = raw[start : end + 1]

    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Gemini response was not valid JSON: {exc}") from exc

    return [
        HookSuggestion(
            start_ms=int(float(item["start_seconds"]) * 1000),
            end_ms=int(float(item["end_seconds"]) * 1000),
            title=item["title"],
            reasoning=item["reasoning"],
        )
        for item in data
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_hook_finder.py -v`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/hook_finder.py apps/video-worker/tests/test_hook_finder.py
git commit -m "feat(video-worker): add hook-finding prompt builder and response parser"
```

---

### Task 3: Gemini API call, `/find-hooks` route, and background task

**Files:**
- Modify: `apps/video-worker/hook_finder.py`
- Modify: `apps/video-worker/tests/test_hook_finder.py`
- Modify: `apps/video-worker/main.py`
- Modify: `apps/video-worker/tests/test_main.py`

**Interfaces:**
- Consumes: `build_prompt`/`parse_hook_response` (Task 2), `_post_callback` from `main.py` (already exists, Sub-proyek 3).
- Produces: `find_hooks(file_path: str, hook: str, strategy_summary: str, requirements_checklist: list[str], api_key: str, model: str = "gemini-2.5-flash") -> list[HookSuggestion]`; `POST /find-hooks` route on video-worker accepting `{video_asset_id, file_path, hook, strategy_summary, requirements_checklist, callback_url}`, returning 202. Task 6 (api's videoWorkerClient) depends on this exact route path and payload shape.

- [ ] **Step 1: Write failing tests for `find_hooks`**

Append to `apps/video-worker/tests/test_hook_finder.py`:
```python
from unittest.mock import MagicMock, patch


class _FakeFile:
    def __init__(self, state: str = "ACTIVE", name: str = "files/abc123"):
        self.state = state
        self.name = name
        self.error = None


def test_find_hooks_uploads_file_and_returns_parsed_suggestions():
    fake_uploaded = _FakeFile(state="ACTIVE")
    fake_response = MagicMock()
    fake_response.text = '[{"start_seconds": 1, "end_seconds": 10, "title": "T", "reasoning": "R"}]'

    fake_client = MagicMock()
    fake_client.files.upload.return_value = fake_uploaded
    fake_client.models.generate_content.return_value = fake_response

    with patch("hook_finder.genai.Client", return_value=fake_client):
        from hook_finder import find_hooks

        result = find_hooks(
            file_path="/tmp/fake.mp4",
            hook="lead with the prize",
            strategy_summary="fast cuts",
            requirements_checklist=["30-59 seconds"],
            api_key="fake-key",
        )

    assert len(result) == 1
    assert result[0].title == "T"
    fake_client.files.upload.assert_called_once_with(file="/tmp/fake.mp4")
    # the uploaded file and the prompt must both be passed as contents
    call_kwargs = fake_client.models.generate_content.call_args.kwargs
    assert fake_uploaded in call_kwargs["contents"]
    assert any(isinstance(c, str) and "lead with the prize" in c for c in call_kwargs["contents"])


def test_find_hooks_waits_for_processing_state():
    processing_then_active = [_FakeFile(state="PROCESSING"), _FakeFile(state="ACTIVE")]
    fake_response = MagicMock()
    fake_response.text = '[{"start_seconds": 1, "end_seconds": 10, "title": "T", "reasoning": "R"}]'

    fake_client = MagicMock()
    fake_client.files.upload.return_value = processing_then_active[0]
    fake_client.files.get.return_value = processing_then_active[1]
    fake_client.models.generate_content.return_value = fake_response

    with patch("hook_finder.genai.Client", return_value=fake_client), patch("hook_finder.time.sleep"):
        from hook_finder import find_hooks

        result = find_hooks(
            file_path="/tmp/fake.mp4",
            hook="hook",
            strategy_summary="strategy",
            requirements_checklist=[],
            api_key="fake-key",
        )

    assert len(result) == 1
    fake_client.files.get.assert_called_once()


def test_find_hooks_raises_when_gemini_processing_fails():
    fake_uploaded = _FakeFile(state="FAILED")
    fake_uploaded.error = "corrupt video"

    fake_client = MagicMock()
    fake_client.files.upload.return_value = fake_uploaded

    with patch("hook_finder.genai.Client", return_value=fake_client):
        from hook_finder import find_hooks

        try:
            find_hooks(
                file_path="/tmp/fake.mp4",
                hook="hook",
                strategy_summary="strategy",
                requirements_checklist=[],
                api_key="fake-key",
            )
            assert False, "expected RuntimeError"
        except RuntimeError as exc:
            assert "corrupt video" in str(exc)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_hook_finder.py -v`
Expected: `ImportError: cannot import name 'find_hooks'`.

- [ ] **Step 3: Implement `find_hooks`**

Add to `apps/video-worker/hook_finder.py` (imports at the top, function at the end):
```python
import time

from google import genai
```
(Add these two lines to the existing `import json` / `import re` / `from schemas import HookSuggestion` block at the top of the file.)

Append to the end of the file:
```python
def find_hooks(
    file_path: str,
    hook: str,
    strategy_summary: str,
    requirements_checklist: list[str],
    api_key: str,
    model: str = "gemini-2.5-flash",
) -> list[HookSuggestion]:
    client = genai.Client(api_key=api_key)
    uploaded = client.files.upload(file=file_path)

    while uploaded.state == "PROCESSING":
        time.sleep(2)
        uploaded = client.files.get(name=uploaded.name)

    if uploaded.state == "FAILED":
        raise RuntimeError(f"Gemini failed to process uploaded video: {uploaded.error}")

    prompt = build_prompt(hook, strategy_summary, requirements_checklist)
    response = client.models.generate_content(model=model, contents=[uploaded, prompt])
    return parse_hook_response(response.text)
```

Note: comparing `uploaded.state == "PROCESSING"`/`"ACTIVE"`/`"FAILED"` as plain strings works both against the real SDK (its `FileState` enum members compare equal to their string value, e.g. `FileState.ACTIVE == "ACTIVE"`) and against the plain-string fakes used in the tests above — no need to import `FileState` for this comparison.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_hook_finder.py -v`
Expected: all 10 tests PASS.

- [ ] **Step 5: Write failing tests for the `/find-hooks` route**

Append to `apps/video-worker/tests/test_main.py`:
```python
def test_find_hooks_returns_202_and_calls_callback_with_suggestions():
    from schemas import HookSuggestion

    fake_suggestions = [HookSuggestion(start_ms=1000, end_ms=10000, title="T", reasoning="R")]
    with patch("main.find_hooks", return_value=fake_suggestions), patch("main.requests.post") as mock_post:
        resp = client.post(
            "/find-hooks",
            json={
                "video_asset_id": "asset-1",
                "file_path": os.path.join(FIXTURES, "short_clip.mp4"),
                "hook": "lead with the prize",
                "strategy_summary": "fast cuts",
                "requirements_checklist": ["30-59 seconds"],
                "callback_url": "http://api:4000/api/internal/assets/asset-1/hooks-complete",
            },
        )
        assert resp.status_code == 202
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

    _, kwargs = mock_post.call_args
    body = kwargs["json"]
    assert body["video_asset_id"] == "asset-1"
    assert body["hook_suggestions"][0]["title"] == "T"


def test_find_hooks_reports_error_on_gemini_failure():
    with patch("main.find_hooks", side_effect=RuntimeError("no GEMINI_API_KEY set")), patch(
        "main.requests.post"
    ) as mock_post:
        client.post(
            "/find-hooks",
            json={
                "video_asset_id": "asset-2",
                "file_path": os.path.join(FIXTURES, "short_clip.mp4"),
                "hook": "hook",
                "strategy_summary": "strategy",
                "requirements_checklist": [],
                "callback_url": "http://api:4000/api/internal/assets/asset-2/hooks-complete",
            },
        )
        for _ in range(20):
            if mock_post.called:
                break
            time.sleep(0.05)

    _, kwargs = mock_post.call_args
    assert "no GEMINI_API_KEY" in kwargs["json"]["error"]
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py -v`
Expected: `AttributeError: <module 'main'> does not have the attribute 'find_hooks'`.

- [ ] **Step 7: Wire the route into `main.py`**

Add to the imports at the top of `apps/video-worker/main.py`:
```python
from hook_finder import find_hooks
```
Add a module-level constant near `GEMINI_API_KEY` (after the existing `logger = logging.getLogger("video-worker")` line):
```python
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
```
Append to the end of `apps/video-worker/main.py`:
```python
def _run_find_hooks(
    video_asset_id: str,
    file_path: str,
    hook: str,
    strategy_summary: str,
    requirements_checklist: list[str],
    callback_url: str,
) -> None:
    try:
        suggestions = find_hooks(file_path, hook, strategy_summary, requirements_checklist, GEMINI_API_KEY)
        _post_callback(
            callback_url,
            {
                "video_asset_id": video_asset_id,
                "hook_suggestions": [s.model_dump() for s in suggestions],
            },
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        _post_callback(callback_url, {"video_asset_id": video_asset_id, "error": str(exc)})


@app.post("/find-hooks", status_code=202)
def find_hooks_route(payload: dict, background_tasks: BackgroundTasks) -> dict:
    background_tasks.add_task(
        _run_find_hooks,
        payload["video_asset_id"],
        payload["file_path"],
        payload["hook"],
        payload["strategy_summary"],
        payload["requirements_checklist"],
        payload["callback_url"],
    )
    return {"status": "accepted"}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/video-worker && python -m pytest tests/test_main.py tests/test_hook_finder.py -v`
Expected: all tests PASS (12 in `test_main.py`, 10 in `test_hook_finder.py`).

- [ ] **Step 9: Commit**

```bash
git add apps/video-worker/hook_finder.py apps/video-worker/tests/test_hook_finder.py apps/video-worker/main.py apps/video-worker/tests/test_main.py
git commit -m "feat(video-worker): call Gemini for hook suggestions via /find-hooks"
```

---

### Task 4: api schema — `hook_suggestions` table and `video_assets.hook_status`

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/tests/db.test.ts`

**Interfaces:**
- Produces: table `hook_suggestions` (`id`, `video_asset_id` FK, `start_ms`, `end_ms`, `title`, `reasoning`, `created_at`); `video_assets.hook_status TEXT NOT NULL DEFAULT 'none'` column, migrated for pre-existing DBs.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/db.test.ts`, inside the existing `describe` block:
```typescript
  it("creates the hook_suggestions table and a hook_status column on video_assets, migrated on an existing DB", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toContain("hook_suggestions");

    const columns = db.prepare("PRAGMA table_info(video_assets)").all().map((row: any) => row.name);
    expect(columns).toContain("hook_status");
    db.close();
  });

  it("adds hook_status to video_assets on a DB that predates this column", () => {
    resetDbCacheForTests();
    const oldDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "old-db-")), "app.db");
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE video_assets (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        duration_seconds REAL NOT NULL,
        analysis_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `);
    oldDb.close();

    const reopened = getDb(oldDbPath);
    const columns = reopened.prepare("PRAGMA table_info(video_assets)").all().map((row: any) => row.name);
    expect(columns).toContain("hook_status");
    reopened.close();
  });
```
Add these imports at the top of `apps/api/tests/db.test.ts` if not already present: `import Database from "better-sqlite3";`, `import fs from "fs";`, `import os from "os";`, `import path from "path";` (check the file first — it likely already imports `fs`/`os`/`path` for its existing tmpdir-based tests; only add what's missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: FAIL — `hook_suggestions` table doesn't exist, `hook_status` column not present.

- [ ] **Step 3: Add the schema changes**

In `apps/api/src/db.ts`, change the `video_assets` table definition:
```sql
CREATE TABLE IF NOT EXISTS video_assets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  file_path TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
```
to:
```sql
CREATE TABLE IF NOT EXISTS video_assets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  file_path TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  hook_status TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL
);
```
Add a new table (anywhere after `video_assets`, e.g. right after `crop_suggestions`):
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
In `getDb`, add the migration for pre-existing DBs right after the existing `caption_style` migration block:
```typescript
  const videoAssetColumns = db.prepare("PRAGMA table_info(video_assets)").all() as { name: string }[];
  if (!videoAssetColumns.some((c) => c.name === "hook_status")) {
    db.exec("ALTER TABLE video_assets ADD COLUMN hook_status TEXT NOT NULL DEFAULT 'none'");
  }
```

- [ ] **Step 4: Add TypeScript types**

In `apps/api/src/types.ts`, add `hook_status: "none" | "pending" | "done" | "failed";` to the existing `VideoAsset` interface (alongside `analysis_status`). Add a new interface:
```typescript
export interface HookSuggestion {
  id: string;
  video_asset_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  reasoning: string;
  created_at: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/tests/db.test.ts
git commit -m "feat(api): add hook_suggestions table and video_assets.hook_status column"
```

---

### Task 5: `videoWorkerClient.ts` — `findHooks` function

**Files:**
- Modify: `apps/api/src/services/videoWorkerClient.ts`
- Modify: `apps/api/tests/videoWorkerClient.test.ts`

**Interfaces:**
- Consumes: video-worker's `POST /find-hooks` (Task 3).
- Produces: `findHooks(videoWorkerUrl: string, videoAssetId: string, filePath: string, hook: string, strategySummary: string, requirementsChecklist: string[], callbackUrl: string): Promise<void>`. Task 7 (assets.ts) depends on this exact signature.

- [ ] **Step 1: Read the current test file to match its exact conventions**

Read `apps/api/tests/videoWorkerClient.test.ts` in full first — it already has tests for `analyzeAsset` and `submitRender` using mocked `global.fetch`; match that exact mocking style for the new test.

- [ ] **Step 2: Write the failing test**

Add to `apps/api/tests/videoWorkerClient.test.ts` (following the file's existing `describe`/`it` and fetch-mocking conventions):
```typescript
  it("findHooks posts video/BRD context to /find-hooks", async () => {
    const { findHooks } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await findHooks(
      "http://video-worker:8100",
      "asset-1",
      "/app/video-assets/clip.mp4",
      "lead with the prize",
      "fast cuts",
      ["30-59 seconds"],
      "http://api:4000/api/internal/assets/asset-1/hooks-complete"
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://video-worker:8100/find-hooks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          video_asset_id: "asset-1",
          file_path: "/app/video-assets/clip.mp4",
          hook: "lead with the prize",
          strategy_summary: "fast cuts",
          requirements_checklist: ["30-59 seconds"],
          callback_url: "http://api:4000/api/internal/assets/asset-1/hooks-complete",
        }),
      })
    );
  });

  it("findHooks throws when video-worker responds with a non-ok status", async () => {
    const { findHooks } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      findHooks("http://video-worker:8100", "asset-1", "/path.mp4", "h", "s", [], "http://cb")
    ).rejects.toThrow("video-worker /find-hooks failed with status 500");
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: FAIL — `findHooks` is not exported.

- [ ] **Step 4: Implement**

Add to the end of `apps/api/src/services/videoWorkerClient.ts`:
```typescript
export async function findHooks(
  videoWorkerUrl: string,
  videoAssetId: string,
  filePath: string,
  hook: string,
  strategySummary: string,
  requirementsChecklist: string[],
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/find-hooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video_asset_id: videoAssetId,
      file_path: filePath,
      hook,
      strategy_summary: strategySummary,
      requirements_checklist: requirementsChecklist,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /find-hooks failed with status ${res.status}`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/videoWorkerClient.ts apps/api/tests/videoWorkerClient.test.ts
git commit -m "feat(api): add findHooks video-worker client function"
```

---

### Task 6: `internal.ts` — hooks-complete callback route

**Files:**
- Modify: `apps/api/src/routes/internal.ts`
- Modify: `apps/api/tests/internal.test.ts`

**Interfaces:**
- Consumes: video-worker's callback payload (Task 3): `{video_asset_id, hook_suggestions: [{start_ms, end_ms, title, reasoning}]}` or `{video_asset_id, error}`.
- Produces: `POST /assets/:assetId/hooks-complete` — inserts all suggestion rows and sets `hook_status = 'done'` on success, or sets `hook_status = 'failed'` on error (no `review_tasks` row — this is scoped to one asset's optional feature, not a campaign-blocking failure).

- [ ] **Step 1: Write failing tests**

Add to `apps/api/tests/internal.test.ts`, inside its existing `describe` block (reuse the existing `beforeEach` setup that creates a campaign/asset, matching the file's established pattern):
```typescript
  it("stores hook suggestions and marks hook_status done", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/hooks-complete`)
      .send({
        video_asset_id: assetId,
        hook_suggestions: [
          { start_ms: 1000, end_ms: 10000, title: "T1", reasoning: "R1" },
          { start_ms: 20000, end_ms: 35000, title: "T2", reasoning: "R2" },
        ],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM hook_suggestions WHERE video_asset_id = ?").all(assetId) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("T1");

    const asset = db.prepare("SELECT hook_status FROM video_assets WHERE id = ?").get(assetId) as any;
    expect(asset.hook_status).toBe("done");
  });

  it("marks hook_status failed and stores no rows when video-worker reports an error", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/hooks-complete`)
      .send({ video_asset_id: assetId, error: "GEMINI_API_KEY not set" });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM hook_suggestions WHERE video_asset_id = ?").all(assetId);
    expect(rows).toHaveLength(0);

    const asset = db.prepare("SELECT hook_status FROM video_assets WHERE id = ?").get(assetId) as any;
    expect(asset.hook_status).toBe("failed");
  });

  it("appends to existing hook_suggestions rather than replacing them on a second run", async () => {
    const app = createApp();
    await request(app)
      .post(`/api/internal/assets/${assetId}/hooks-complete`)
      .send({ video_asset_id: assetId, hook_suggestions: [{ start_ms: 0, end_ms: 5000, title: "First run", reasoning: "r" }] });
    await request(app)
      .post(`/api/internal/assets/${assetId}/hooks-complete`)
      .send({ video_asset_id: assetId, hook_suggestions: [{ start_ms: 0, end_ms: 5000, title: "Second run", reasoning: "r" }] });

    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM hook_suggestions WHERE video_asset_id = ?").all(assetId) as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.title).sort()).toEqual(["First run", "Second run"]);
  });
```
(Check the file's existing `beforeEach` for the exact variable names it uses for the campaign/asset ids it sets up — reuse `assetId`/`dbPath` or whatever it's actually called there; this brief assumes the same names the file's existing `analysis-complete` tests already use.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/internal.test.ts`
Expected: FAIL — route doesn't exist (404) or `hook_suggestions` never inserted.

- [ ] **Step 3: Implement the route**

Add to `apps/api/src/routes/internal.ts`, after the existing `router.post("/assets/:assetId/analysis-complete", ...)` handler and before `router.post("/render/:jobId/complete", ...)`:
```typescript
  router.post("/assets/:assetId/hooks-complete", (req, res) => {
    const db = getDb(dbPath);
    const { assetId } = req.params;
    const now = new Date().toISOString();

    if (req.body.error) {
      db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("failed", assetId);
      res.json({ status: "recorded" });
      return;
    }

    const suggestions = (req.body.hook_suggestions ?? []) as Array<{
      start_ms: number;
      end_ms: number;
      title: string;
      reasoning: string;
    }>;
    const insert = db.prepare(
      `INSERT INTO hook_suggestions (id, video_asset_id, start_ms, end_ms, title, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows: typeof suggestions) => {
      for (const s of rows) {
        insert.run(randomUUID(), assetId, s.start_ms, s.end_ms, s.title, s.reasoning, now);
      }
    });
    insertMany(suggestions);

    db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("done", assetId);
    res.json({ status: "recorded" });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/internal.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/internal.ts apps/api/tests/internal.test.ts
git commit -m "feat(api): persist hook suggestions from video-worker callback"
```

---

### Task 7: `assets.ts` — trigger and read routes

**Files:**
- Modify: `apps/api/src/routes/assets.ts`
- Modify: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Consumes: `findHooks` (Task 5).
- Produces: `POST /:assetId/find-hooks` (202 on success, 404 if asset not found, 400 if campaign has no plan yet); `GET /:assetId/hook-suggestions` (200 with array, empty array if none yet — not a 404, since "no suggestions yet" is a normal state while `hook_status` is `pending`).

- [ ] **Step 1: Write failing tests**

Add to `apps/api/tests/assets.test.ts`, inside the existing `describe("asset routes"` block:
```typescript
  it("triggers find-hooks and returns 202", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const db = getDb(process.env.DB_PATH as string);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO plans (id, campaign_id, strategy_summary, requirements_checklist, content_plan, opportunity_score, pdf_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "plan-1",
      campaignId,
      "Fast cuts, high energy",
      JSON.stringify(["30-59 seconds only"]),
      JSON.stringify({ hook: "Lead with the prize" }),
      80,
      null,
      now
    );

    const res = await request(app).post(`/api/campaigns/${campaignId}/assets/${uploadRes.body.id}/find-hooks`);
    expect(res.status).toBe(202);
  });

  it("returns 404 for find-hooks on an unknown asset", async () => {
    const app = createApp();
    const res = await request(app).post(`/api/campaigns/${campaignId}/assets/does-not-exist/find-hooks`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for find-hooks when the campaign has no plan yet", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const res = await request(app).post(`/api/campaigns/${campaignId}/assets/${uploadRes.body.id}/find-hooks`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plan/i);
  });

  it("returns an empty array (not 404) when no hook suggestions exist yet", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const res = await request(app).get(
      `/api/campaigns/${campaignId}/assets/${uploadRes.body.id}/hook-suggestions`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns all hook_suggestions rows for an asset", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);
    const assetId = uploadRes.body.id;

    const db = getDb(process.env.DB_PATH as string);
    db.prepare(
      `INSERT INTO hook_suggestions (id, video_asset_id, start_ms, end_ms, title, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("hs-1", assetId, 1000, 10000, "Title A", "Reason A", new Date().toISOString());

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/${assetId}/hook-suggestions`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe("Title A");
  });
```
The file already has this at the top, above `describe("asset routes"`:
```typescript
jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
}));
```
Change it to also mock `findHooks` (Jest only honors one mock factory per module per file, hoisted to the top — extend this one rather than adding a second `jest.mock` call anywhere else):
```typescript
jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
  findHooks: jest.fn().mockResolvedValue(undefined),
}));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: FAIL — routes don't exist (404s where 202/400/200 expected).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/assets.ts`, add to the imports:
```typescript
import { analyzeAsset, findHooks } from "../services/videoWorkerClient";
```
Add two new routes after the existing `router.get("/:assetId/crop-suggestion", ...)` handler and before `router.delete("/:assetId", ...)`:
```typescript
  router.post("/:assetId/find-hooks", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(req.params.assetId) as
      | { id: string; file_path: string }
      | undefined;
    if (!asset) {
      res.status(404).json({ error: "asset not found" });
      return;
    }

    const plan = db
      .prepare("SELECT * FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { strategy_summary: string; requirements_checklist: string; content_plan: string } | undefined;
    if (!plan) {
      res.status(400).json({ error: "campaign has no plan yet; generate a plan before finding hooks" });
      return;
    }

    const requirementsChecklist = JSON.parse(plan.requirements_checklist) as string[];
    const contentPlan = JSON.parse(plan.content_plan) as { hook?: string };

    db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("pending", req.params.assetId);

    try {
      await findHooks(
        videoWorkerUrl,
        req.params.assetId,
        asset.file_path,
        contentPlan.hook ?? "",
        plan.strategy_summary,
        requirementsChecklist,
        `${callbackBase}/assets/${req.params.assetId}/hooks-complete`
      );
    } catch (err) {
      db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("failed", req.params.assetId);
      res.status(202).json({ status: "failed" });
      return;
    }

    res.status(202).json({ status: "pending" });
  }));

  router.get("/:assetId/hook-suggestions", (req, res) => {
    const db = getDb(dbPath);
    const suggestions = db
      .prepare("SELECT * FROM hook_suggestions WHERE video_asset_id = ? ORDER BY created_at ASC")
      .all(req.params.assetId);
    res.json(suggestions);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: all tests PASS. Some pre-existing tests in this file (unrelated to this change) may fail on a bare host without `ffprobe`/`ffmpeg` installed — that's a known, pre-existing environment gap documented throughout this project's history, not a regression from this task. Verify via Docker if the bare host lacks `ffprobe` (build the `api` image, run `npx jest tests/assets.test.ts` inside a container — the same pattern used for every prior `assets.test.ts` change).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/assets.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): add find-hooks trigger and hook-suggestions read routes"
```

---

### Task 8: web-ui — `apiClient.ts` additions

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`

**Interfaces:**
- Consumes: `GET .../hook-suggestions`, `POST .../find-hooks` (Task 7).
- Produces: `HookSuggestion` interface; `findHooks(campaignId, assetId): Promise<void>`; `getHookSuggestions(campaignId, assetId): Promise<HookSuggestion[]>`; `VideoAsset.hook_status` field.

- [ ] **Step 1: Implement**

In `apps/web-ui/lib/apiClient.ts`, add `hook_status: "none" | "pending" | "done" | "failed";` to the existing `VideoAsset` interface. Add after the existing `getCropSuggestion` function:
```typescript
export interface HookSuggestion {
  id: string;
  video_asset_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  reasoning: string;
  created_at: string;
}

export async function findHooks(campaignId: string, assetId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/find-hooks`, {
    method: "POST",
  });
  if (!res.ok) {
    if (res.status === 400) {
      const body = await res.json();
      throw new Error(body.error ?? "find hooks failed: campaign has no plan yet");
    }
    throw new Error(`find hooks failed with status ${res.status}`);
  }
}

export async function getHookSuggestions(campaignId: string, assetId: string): Promise<HookSuggestion[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/hook-suggestions`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get hook suggestions failed with status ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly (this file has no test suite in this project; the build's type-check is the verification).

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts
git commit -m "feat(web-ui): add findHooks/getHookSuggestions api client functions"
```

---

### Task 9: web-ui — "Find Hooks" button and suggestions panel

**Files:**
- Modify: `apps/web-ui/components/SegmentEditor.tsx`

**Interfaces:**
- Consumes: `findHooks`, `getHookSuggestions`, `HookSuggestion` (Task 8).
- Produces: a "Find Hooks 🎯" button (enabled once `asset.analysis_status === "done"`) and a "Suggested Hooks" panel; clicking a suggestion calls `onChange` with `trim_start`/`trim_end`/`title_text` set from that suggestion (start/end converted from ms to seconds), same one-click-apply pattern the crop-suggestion feature already established.

- [ ] **Step 1: Implement**

In `apps/web-ui/components/SegmentEditor.tsx`, update the import block:
```tsx
import {
  CropRect,
  CropSuggestion,
  HookSuggestion,
  LayoutTemplate,
  MomentCandidate,
  SegmentDraft,
  VideoAsset,
  findHooks,
  getCropSuggestion,
  getHookSuggestions,
  listMoments,
} from "../lib/apiClient";
```
Add new state and a fetch effect, alongside the existing `moments`/`cropSuggestion` state (after the existing `const [cropSuggestion, setCropSuggestion] = useState<CropSuggestion | null>(null);` line):
```tsx
  const [hookSuggestions, setHookSuggestions] = useState<HookSuggestion[]>([]);
  const [findingHooks, setFindingHooks] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);

  useEffect(() => {
    if (draft.video_asset_id) {
      getHookSuggestions(campaignId, draft.video_asset_id).then(setHookSuggestions);
    } else {
      setHookSuggestions([]);
    }
  }, [campaignId, draft.video_asset_id]);

  async function handleFindHooks() {
    if (!draft.video_asset_id) return;
    setFindingHooks(true);
    setHookError(null);
    try {
      await findHooks(campaignId, draft.video_asset_id);
    } catch (err) {
      setHookError((err as Error).message);
    } finally {
      setFindingHooks(false);
    }
  }

  function applyHookSuggestion(suggestion: HookSuggestion) {
    onChange({
      ...draft,
      trim_start: suggestion.start_ms / 1000,
      trim_end: suggestion.end_ms / 1000,
      title_text: suggestion.title,
    });
  }
```
Add the button and panel to the JSX, right after the existing `{asset && (<div className="rounded-xl bg-slate-50 p-3"><TimelineScrubber .../></div>)}` block:
```tsx
      {asset && asset.analysis_status === "done" && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleFindHooks}
            disabled={findingHooks}
            className="w-fit rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-orange-100 transition hover:opacity-90 disabled:opacity-50"
          >
            {findingHooks ? "Asking Gemini..." : "Find Hooks 🎯"}
          </button>
          {hookError && (
            <p role="alert" className="text-sm font-medium text-rose-500">
              {hookError}
            </p>
          )}
          {hookSuggestions.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-orange-100 bg-orange-50/50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">Suggested Hooks</p>
              {hookSuggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => applyHookSuggestion(s)}
                  className="rounded-lg border border-orange-200 bg-white p-3 text-left transition hover:border-orange-400 hover:bg-orange-50"
                >
                  <p className="text-sm font-semibold text-slate-800">{s.title}</p>
                  <p className="text-xs text-slate-500">
                    {(s.start_ms / 1000).toFixed(1)}s &ndash; {(s.end_ms / 1000).toFixed(1)}s
                  </p>
                  <p className="mt-1 text-xs text-slate-400">{s.reasoning}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Manual verification**

No component test framework in this project (established pattern). If a dev server is reachable, open the segments page for a campaign with a `done`-status footage asset and a generated plan, click "Find Hooks", and confirm the button disables while pending and a suggestion (once one exists in the DB) is clickable and fills `trim_start`/`trim_end`/`title_text`. If a live check isn't possible in this environment, say so honestly rather than claiming it was verified — consistent with this project's established practice.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/SegmentEditor.tsx
git commit -m "feat(web-ui): add Find Hooks button and suggestions panel to segment editor"
```

---

## Self-Review Notes

- **Spec coverage:** manual trigger only (Task 9's button, never auto-run) ✓; video-worker owns the Gemini call, ai-worker untouched ✓ (no ai-worker file appears anywhere in this plan); `hook_suggestions` table + `hook_status` migration ✓ (Task 4); BRD context (hook/strategy_summary/requirements_checklist) passed through ✓ (Task 7 reads and parses `plans`, Task 3's prompt uses all three); advisory-only apply-on-click ✓ (Task 9's `applyHookSuggestion` only fires from an explicit click, never automatically); append-not-replace on repeated runs ✓ (Task 6's INSERT never deletes existing rows, and a dedicated test pins this). Known long-video limitation is explicitly documented in the spec as out of scope for this MVP — no task needed.
- **Placeholder scan:** no TBD/TODO; every step has complete code or an exact command.
- **Type consistency:** `HookSuggestion` (`start_ms`, `end_ms`, `title`, `reasoning`) matches identically across Task 1 (Python schema), Task 3 (route payload + test), Task 4 (TS type + DB columns), Task 8 (web-ui type). `findHooks`'s parameter order in Task 5's `videoWorkerClient.ts` (`videoWorkerUrl, videoAssetId, filePath, hook, strategySummary, requirementsChecklist, callbackUrl`) matches exactly how Task 7 calls it. Route paths (`/find-hooks`, `/hook-suggestions`, `/hooks-complete`) are identical between the task that defines each and the task(s) that call it.
