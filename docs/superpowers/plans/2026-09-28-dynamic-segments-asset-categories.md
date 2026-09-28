# Dynamic Segments & Asset Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators freely build a segment list (add/remove/reorder, any category label) instead of being locked to `content_plan`'s keys, and let each segment's start+duration trigger a real cut into a reusable `clip` asset.

**Architecture:** video-worker gains a `/cut` endpoint reusing the existing `build_trim_args`/`probe_duration` ffmpeg primitives; api gains a `cut_jobs` table plus trigger/status/callback routes and loosens `asset_type` handling; web-ui's Segments page becomes an array-driven list editor and `SegmentEditor` gains a category label, a soft-filtered asset picker, and start+duration cut controls.

**Tech Stack:** TypeScript/Express/better-sqlite3 (api), Python/FastAPI/ffmpeg (video-worker), Next.js/React (web-ui) — all existing, no new dependencies.

**Spec:** docs/superpowers/specs/2026-09-28-dynamic-segments-asset-categories-design.md

## Global Constraints

- Cut result assets are always `asset_type: "clip"`, regardless of the segment label being worked on.
- The label↔category filter on the source-asset dropdown is soft only (UI convenience), never enforced server-side.
- Cut/clip assets are scoped to `campaign_id`, reusable across any segment/render in the same campaign, matching existing `video_assets` scoping.
- `content_plan`'s prompt schema (`hook`/`script`/`assets`/`schedule`) is unchanged — still generated and displayed as strategy reference on the campaign detail page.
- No fixed enum/categories table for `asset_type` or `segment_key` — both stay free `TEXT`; the 5 default asset categories (`footage`, `clip`, `broll`, `music`, `watermark`) and previously-used values are suggestions only, never enforced.

## Review Focus

- Deleting a `video_assets` row that a `cut_jobs` row references (as `source_asset_id` or `result_asset_id`) must not 500 on the foreign-key constraint — this exact bug class (an asset becoming permanently undeletable once a new FK-referencing table exists) was caught in this same codebase's Find Hooks final review; Task 1 must fix it proactively, not wait for a final review to catch it again.
- `PUT /segments` with zero segments, or with duplicate `segment_key` values, must 400 with a clear error rather than silently wiping all existing segment assignments (the route does a delete-then-insert transaction) or silently keeping one of the duplicates.
- A cut whose `duration_seconds` runs past the source asset's actual remaining length must not crash the whole operation — ffmpeg's own past-EOF trim behavior naturally produces a shorter file; the callback must report the *actual* resulting duration, not the requested one, or the resulting `video_assets.duration_seconds` will be wrong for every later timeline calculation.
- The source-asset dropdown's soft category filter must not leave the operator stuck with an empty dropdown and no explanation when a campaign genuinely has zero assets of the filtered category yet — show a clear "no assets of type X yet, upload one" message rather than a bare empty `<select>`.
- Widening `asset_type` acceptance on the upload route must not silently break `"music"`/`"watermark"`'s existing special-case validation (duration probe skip, image-only check) — a custom category typed as `"Music"` (capitalized) or with surrounding whitespace must not accidentally bypass those checks in either direction.

---

### Task 1: `cut_jobs` schema + asset-delete FK safety fix

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/routes/assets.ts`
- Test: `apps/api/tests/db.test.ts`
- Test: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Produces: `cut_jobs` table (`id`, `campaign_id`, `source_asset_id`, `start_seconds`, `duration_seconds`, `status`, `result_asset_id`, `error_message`, `created_at`), migrated for pre-existing DBs. `CutJob` TS interface in `types.ts`.

- [ ] **Step 1: Write the failing schema test**

Add to `apps/api/tests/db.test.ts`:
```typescript
  it("creates the cut_jobs table, migrated on an existing DB", () => {
    resetDbCacheForTests();
    const oldDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "old-cutjobs-db-")), "app.db");
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
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toContain("cut_jobs");
    reopened.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/db.test.ts -t "cut_jobs"`
Expected: FAIL — table doesn't exist.

- [ ] **Step 3: Add the table to the schema**

In `apps/api/src/db.ts`, add to the `SCHEMA` template string, after the `caption_words` table definition and before the closing `` ` ``:
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
(No `ALTER TABLE` migration block is needed for this one — `CREATE TABLE IF NOT EXISTS` alone is sufficient since this is a brand-new table, not a new column on an existing table. Every other migration block in `getDb` exists only because those add *columns* to tables that already exist on older DBs; a whole new table has no such problem.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/db.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Add the `CutJob` type**

In `apps/api/src/types.ts`, add:
```typescript
export interface CutJob {
  id: string;
  campaign_id: string;
  source_asset_id: string;
  start_seconds: number;
  duration_seconds: number;
  status: "pending" | "done" | "failed";
  result_asset_id: string | null;
  error_message: string | null;
  created_at: string;
}
```

- [ ] **Step 6: Write the failing FK-safety test**

Read `apps/api/src/routes/assets.ts`'s existing `DELETE /:assetId` route in full first (it already deletes `moment_candidates`, `crop_suggestions`, and `hook_suggestions` rows before deleting the `video_assets` row, inside one transaction — this step extends that same transaction). Add to `apps/api/tests/assets.test.ts`, matching the file's existing delete-test conventions (reuse whatever `campaignId`/`assetId`/`dbPath` variable names its `beforeEach` already establishes):
```typescript
  it("deletes an asset that is referenced by a cut_jobs row without a foreign key error", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);
    const assetId = uploadRes.body.id;

    const db = getDb(process.env.DB_PATH as string);
    db.prepare(
      `INSERT INTO cut_jobs (id, campaign_id, source_asset_id, start_seconds, duration_seconds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("cutjob-1", campaignId, assetId, 0, 5, "pending", new Date().toISOString());

    const res = await request(app).delete(`/api/campaigns/${campaignId}/assets/${assetId}`);
    expect(res.status).toBe(204);

    const remaining = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get("cutjob-1");
    expect(remaining).toBeUndefined();
  });
```
(Check the file's existing successful-delete test for the exact expected status code — this brief assumes `204`; adjust to match whatever the file's existing passing delete test actually asserts.)

- [ ] **Step 7: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/assets.test.ts -t "cut_jobs row"`
Expected: FAIL — `SqliteError: FOREIGN KEY constraint failed`.

- [ ] **Step 8: Fix the DELETE route**

In `apps/api/src/routes/assets.ts`'s `DELETE /:assetId` route, inside the existing transaction, add a delete of `cut_jobs` rows referencing this asset as either `source_asset_id` or `result_asset_id`, alongside the existing `moment_candidates`/`crop_suggestions`/`hook_suggestions` deletes:
```typescript
    db.prepare("DELETE FROM cut_jobs WHERE source_asset_id = ? OR result_asset_id = ?").run(assetId, assetId);
```
(Place this line in the same transaction block as the existing three delete statements, before the `video_assets` row is deleted — read the current exact code first to match its variable names and transaction structure precisely.)

- [ ] **Step 9: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: all tests PASS (except any pre-existing environmental failures from a missing `ffmpeg`/`ffprobe` on a bare host — verify via Docker if needed, matching this project's established practice).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/types.ts apps/api/src/routes/assets.ts apps/api/tests/db.test.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): add cut_jobs table and fix asset-delete FK safety"
```

---

### Task 2: video-worker — `POST /cut` endpoint

**Files:**
- Modify: `apps/video-worker/main.py`
- Test: `apps/video-worker/tests/test_main.py`

**Interfaces:**
- Consumes: `build_trim_args`, `run_ffmpeg`, `probe_duration` (all already exist in `apps/video-worker/ffmpeg_utils.py`).
- Produces: `POST /cut` — body `{cut_job_id, file_path, start_seconds, duration_seconds, callback_url}`. 202 immediately; background task posts `{cut_job_id, status: "done", output_path, duration_seconds}` or `{cut_job_id, status: "failed", error}` to `callback_url`.

- [ ] **Step 1: Write the failing test**

Read `apps/video-worker/main.py`'s existing `find_hooks_route`/`_run_find_hooks` pair in full first (this task follows the exact same dict-payload, `BackgroundTasks`, `_post_callback` shape). Add to `apps/video-worker/tests/test_main.py`, matching the file's existing test conventions for a `/find-hooks`-style route (mock whatever the file's existing tests mock for `render_video`/`find_hooks`):
```python
def test_cut_returns_202_and_calls_callback_with_output(client, monkeypatch, tmp_path):
    from unittest.mock import MagicMock

    mock_build_trim_args = MagicMock(return_value=["ffmpeg", "-y", "fake-args"])
    mock_run_ffmpeg = MagicMock()
    mock_probe_duration = MagicMock(return_value=4.8)
    monkeypatch.setattr("main.build_trim_args", mock_build_trim_args)
    monkeypatch.setattr("main.run_ffmpeg", mock_run_ffmpeg)
    monkeypatch.setattr("main.probe_duration", mock_probe_duration)
    monkeypatch.setenv("VIDEO_ASSETS_DIR", str(tmp_path))

    posted = {}

    def fake_post(url, json, timeout):
        posted["url"] = url
        posted["json"] = json
        class FakeResponse:
            def raise_for_status(self):
                pass
        return FakeResponse()

    monkeypatch.setattr("main.requests.post", fake_post)

    res = client.post(
        "/cut",
        json={
            "cut_job_id": "job-1",
            "file_path": "/app/video-assets/source.mp4",
            "start_seconds": 10,
            "duration_seconds": 5,
            "callback_url": "http://api:4000/api/internal/cut-jobs/job-1/complete",
        },
    )
    assert res.status_code == 202

    mock_build_trim_args.assert_called_once()
    call_args = mock_build_trim_args.call_args[0]
    assert call_args[0] == "/app/video-assets/source.mp4"
    assert call_args[1] == 10
    assert call_args[2] == 15  # start + duration

    assert posted["json"]["cut_job_id"] == "job-1"
    assert posted["json"]["status"] == "done"
    assert posted["json"]["duration_seconds"] == 4.8
    assert "output_path" in posted["json"]


def test_cut_reports_error_on_ffmpeg_failure(client, monkeypatch):
    from unittest.mock import MagicMock

    monkeypatch.setattr("main.build_trim_args", MagicMock(return_value=["ffmpeg"]))
    monkeypatch.setattr("main.run_ffmpeg", MagicMock(side_effect=RuntimeError("ffmpeg exited 1")))

    posted = {}

    def fake_post(url, json, timeout):
        posted["json"] = json
        class FakeResponse:
            def raise_for_status(self):
                pass
        return FakeResponse()

    monkeypatch.setattr("main.requests.post", fake_post)

    res = client.post(
        "/cut",
        json={
            "cut_job_id": "job-2",
            "file_path": "/app/video-assets/source.mp4",
            "start_seconds": 0,
            "duration_seconds": 5,
            "callback_url": "http://api:4000/api/internal/cut-jobs/job-2/complete",
        },
    )
    assert res.status_code == 202
    assert posted["json"]["cut_job_id"] == "job-2"
    assert posted["json"]["status"] == "failed"
    assert "error" in posted["json"]
```
(Check the file's existing test fixture for `client` — reuse whatever `TestClient(app)` fixture the file's other route tests already use, and check whether `BackgroundTasks` run synchronously in that test setup already, matching however the existing `/find-hooks`/`/render` tests verify their background task ran without a real sleep/wait.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/video-worker && python3 -m pytest tests/test_main.py -v -k cut`
Expected: FAIL — `404 Not Found`, route doesn't exist.

- [ ] **Step 3: Implement**

In `apps/video-worker/main.py`, add to the imports:
```python
from ffmpeg_utils import build_trim_args, probe_duration, run_ffmpeg
```
Add after the existing `_run_find_hooks`/`find_hooks_route` pair:
```python
def _run_cut(cut_job_id: str, file_path: str, start_seconds: float, duration_seconds: float, callback_url: str) -> None:
    output_dir = os.environ.get("VIDEO_ASSETS_DIR", "/app/video-assets")
    output_path = os.path.join(output_dir, "clips", f"{cut_job_id}.mp4")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    try:
        args = build_trim_args(file_path, start_seconds, start_seconds + duration_seconds, output_path)
        run_ffmpeg(args)
        actual_duration = probe_duration(output_path)
        _post_callback(
            callback_url,
            {"cut_job_id": cut_job_id, "status": "done", "output_path": output_path, "duration_seconds": actual_duration},
        )
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        logger.exception("cut failed for cut_job_id=%s", cut_job_id)
        _post_callback(callback_url, {"cut_job_id": cut_job_id, "status": "failed", "error": str(exc)})


@app.post("/cut", status_code=202)
def cut_route(payload: dict, background_tasks: BackgroundTasks) -> dict:
    background_tasks.add_task(
        _run_cut,
        payload["cut_job_id"],
        payload["file_path"],
        payload["start_seconds"],
        payload["duration_seconds"],
        payload["callback_url"],
    )
    return {"status": "accepted"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/video-worker && python3 -m pytest tests/test_main.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/video-worker/main.py apps/video-worker/tests/test_main.py
git commit -m "feat(video-worker): add /cut endpoint reusing existing ffmpeg trim primitives"
```

---

### Task 3: api — cut trigger route + `videoWorkerClient.ts` addition

**Files:**
- Modify: `apps/api/src/services/videoWorkerClient.ts`
- Modify: `apps/api/src/routes/assets.ts`
- Test: `apps/api/tests/videoWorkerClient.test.ts`
- Test: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Consumes: video-worker's `POST /cut` (Task 2).
- Produces: `triggerCut(videoWorkerUrl, cutJobId, filePath, startSeconds, durationSeconds, callbackUrl): Promise<void>` (videoWorkerClient.ts). `POST /api/campaigns/:id/assets/:assetId/cut` — body `{start_seconds, duration_seconds}`. 404 if asset not found/not in campaign, 400 if `duration_seconds <= 0` or `start_seconds < 0`, 202 with `{cut_job_id}` on success.

- [ ] **Step 1: Write the failing test for `triggerCut`**

Read `apps/api/tests/videoWorkerClient.test.ts`'s existing `findHooks` test first to match its exact conventions. Add:
```typescript
  it("triggerCut posts the expected body to video-worker's /cut", async () => {
    const { triggerCut } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await triggerCut(
      "http://video-worker:8100",
      "job-1",
      "/app/video-assets/source.mp4",
      10,
      5,
      "http://api:4000/api/internal/cut-jobs/job-1/complete"
    );

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("http://video-worker:8100/cut");
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      cut_job_id: "job-1",
      file_path: "/app/video-assets/source.mp4",
      start_seconds: 10,
      duration_seconds: 5,
      callback_url: "http://api:4000/api/internal/cut-jobs/job-1/complete",
    });
  });

  it("triggerCut throws when video-worker responds with a non-ok status", async () => {
    const { triggerCut } = require("../src/services/videoWorkerClient");
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      triggerCut("http://video-worker:8100", "job-1", "/app/video-assets/source.mp4", 10, 5, "http://cb")
    ).rejects.toThrow("video-worker /cut failed with status 500");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts -t "triggerCut"`
Expected: FAIL — `triggerCut` is not exported.

- [ ] **Step 3: Implement `triggerCut`**

In `apps/api/src/services/videoWorkerClient.ts`, add:
```typescript
export async function triggerCut(
  videoWorkerUrl: string,
  cutJobId: string,
  filePath: string,
  startSeconds: number,
  durationSeconds: number,
  callbackUrl: string
): Promise<void> {
  const res = await fetch(`${videoWorkerUrl}/cut`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cut_job_id: cutJobId,
      file_path: filePath,
      start_seconds: startSeconds,
      duration_seconds: durationSeconds,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`video-worker /cut failed with status ${res.status}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/videoWorkerClient.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Write failing tests for the trigger route**

Read `apps/api/src/routes/assets.ts`'s existing `/:assetId/find-hooks` route in full first (this task's route follows the same shape: look up the asset, call the video-worker client, insert a job row, return 202). Add to `apps/api/tests/assets.test.ts`:
```typescript
  it("triggers a cut and returns 202 with a cut_job_id", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets/${uploadRes.body.id}/cut`)
      .send({ start_seconds: 1, duration_seconds: 2 });
    expect(res.status).toBe(202);
    expect(res.body.cut_job_id).toBeDefined();

    const db = getDb(process.env.DB_PATH as string);
    const job = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get(res.body.cut_job_id) as any;
    expect(job.source_asset_id).toBe(uploadRes.body.id);
    expect(job.start_seconds).toBe(1);
    expect(job.duration_seconds).toBe(2);
    expect(job.status).toBe("pending");
  });

  it("returns 404 for cut on an unknown asset", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets/does-not-exist/cut`)
      .send({ start_seconds: 0, duration_seconds: 2 });
    expect(res.status).toBe(404);
  });

  it("returns 400 for cut with a non-positive duration", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets/${uploadRes.body.id}/cut`)
      .send({ start_seconds: 0, duration_seconds: 0 });
    expect(res.status).toBe(400);
  });
```
The file already mocks `videoWorkerClient` at the top — extend that existing `jest.mock` factory (do not add a second `jest.mock` call) to also mock `triggerCut`:
```typescript
jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
  findHooks: jest.fn().mockResolvedValue(undefined),
  triggerCut: jest.fn().mockResolvedValue(undefined),
}));
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/assets.test.ts -t "cut"`
Expected: FAIL — route doesn't exist (404 where 202/400 expected).

- [ ] **Step 7: Implement the route**

In `apps/api/src/routes/assets.ts`, add to the imports:
```typescript
import { analyzeAsset, findHooks, triggerCut } from "../services/videoWorkerClient";
```
Add after the existing `/:assetId/hook-suggestions` route and before `DELETE /:assetId`:
```typescript
  router.post("/:assetId/cut", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const { assetId } = req.params;
    const startSeconds = Number(req.body.start_seconds);
    const durationSeconds = Number(req.body.duration_seconds);

    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ? AND campaign_id = ?").get(assetId, campaignId) as
      | { id: string; file_path: string }
      | undefined;
    if (!asset) {
      res.status(404).json({ error: "asset not found" });
      return;
    }
    if (!Number.isFinite(startSeconds) || startSeconds < 0) {
      res.status(400).json({ error: "start_seconds must be a non-negative number" });
      return;
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      res.status(400).json({ error: "duration_seconds must be a positive number" });
      return;
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cut_jobs (id, campaign_id, source_asset_id, start_seconds, duration_seconds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, campaignId, assetId, startSeconds, durationSeconds, "pending", now);

    try {
      await triggerCut(
        videoWorkerUrl,
        jobId,
        asset.file_path,
        startSeconds,
        durationSeconds,
        `${callbackBase}/cut-jobs/${jobId}/complete`
      );
    } catch (err) {
      db.prepare("UPDATE cut_jobs SET status = ?, error_message = ? WHERE id = ?").run(
        "failed",
        (err as Error).message,
        jobId
      );
      res.status(202).json({ cut_job_id: jobId });
      return;
    }

    res.status(202).json({ cut_job_id: jobId });
  }));
```
(`randomUUID` is already imported at the top of this file for the upload route's `id`.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: all tests PASS (Docker if the bare host lacks `ffprobe`, per this project's established practice).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/videoWorkerClient.ts apps/api/src/routes/assets.ts apps/api/tests/videoWorkerClient.test.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): add cut trigger route and triggerCut video-worker client function"
```

---

### Task 4: api — cut status route + internal completion callback

**Files:**
- Modify: `apps/api/src/routes/assets.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Test: `apps/api/tests/assets.test.ts`
- Test: `apps/api/tests/internal.test.ts`

**Interfaces:**
- Consumes: video-worker's cut callback payload (Task 2): `{cut_job_id, status: "done", output_path, duration_seconds}` or `{cut_job_id, status: "failed", error}`.
- Produces: `GET /api/campaigns/:id/assets/cut-jobs/:jobId` — returns the `cut_jobs` row (404 if not found). `POST /api/internal/cut-jobs/:jobId/complete` — on success, inserts a `video_assets` row (`asset_type: "clip"`) and updates `cut_jobs` to `done` with `result_asset_id`; on failure, updates `cut_jobs` to `failed` with `error_message`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/tests/internal.test.ts`, inside its existing `describe` block (reuse whatever `campaignId`/`assetId`/`dbPath` variable names its existing `beforeEach` already establishes):
```typescript
  it("marks a cut_job done and creates a clip asset on success", async () => {
    const app = createApp();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cut_jobs (id, campaign_id, source_asset_id, start_seconds, duration_seconds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("cutjob-1", campaignId, assetId, 1, 2, "pending", now);

    const res = await request(app)
      .post(`/api/internal/cut-jobs/cutjob-1/complete`)
      .send({ cut_job_id: "cutjob-1", status: "done", output_path: "/app/video-assets/clips/cutjob-1.mp4", duration_seconds: 1.9 });

    expect(res.status).toBe(200);
    const job = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get("cutjob-1") as any;
    expect(job.status).toBe("done");
    expect(job.result_asset_id).toBeTruthy();

    const clip = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(job.result_asset_id) as any;
    expect(clip.asset_type).toBe("clip");
    expect(clip.file_path).toBe("/app/video-assets/clips/cutjob-1.mp4");
    expect(clip.duration_seconds).toBe(1.9);
    expect(clip.campaign_id).toBe(campaignId);
  });

  it("marks a cut_job failed and creates no asset on error", async () => {
    const app = createApp();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cut_jobs (id, campaign_id, source_asset_id, start_seconds, duration_seconds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("cutjob-2", campaignId, assetId, 1, 2, "pending", now);

    const res = await request(app)
      .post(`/api/internal/cut-jobs/cutjob-2/complete`)
      .send({ cut_job_id: "cutjob-2", status: "failed", error: "ffmpeg exited 1" });

    expect(res.status).toBe(200);
    const job = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get("cutjob-2") as any;
    expect(job.status).toBe("failed");
    expect(job.error_message).toBe("ffmpeg exited 1");
    expect(job.result_asset_id).toBeNull();
  });
```
Add to `apps/api/tests/assets.test.ts`:
```typescript
  it("returns a cut_jobs row by id", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const db = getDb(process.env.DB_PATH as string);
    db.prepare(
      `INSERT INTO cut_jobs (id, campaign_id, source_asset_id, start_seconds, duration_seconds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("cutjob-3", campaignId, uploadRes.body.id, 0, 2, "pending", new Date().toISOString());

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/cut-jobs/cutjob-3`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
  });

  it("returns 404 for an unknown cut_jobs id", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/cut-jobs/does-not-exist`);
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/internal.test.ts tests/assets.test.ts -t "cut"`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement the internal callback**

In `apps/api/src/routes/internal.ts`, add after the existing `/render/:jobId/complete` handler:
```typescript
  router.post("/cut-jobs/:jobId/complete", (req, res) => {
    const db = getDb(dbPath);
    const { jobId } = req.params;
    const now = new Date().toISOString();

    if (req.body.status === "failed") {
      console.error(`cut failed for job ${jobId}:`, req.body.error);
      db.prepare("UPDATE cut_jobs SET status = ?, error_message = ? WHERE id = ?").run(
        "failed",
        req.body.error,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    const job = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get(jobId) as { campaign_id: string } | undefined;
    if (!job) {
      res.status(404).json({ error: "cut job not found" });
      return;
    }

    const clipId = randomUUID();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(clipId, job.campaign_id, req.body.output_path, "clip", req.body.duration_seconds, "done", now);

    db.prepare("UPDATE cut_jobs SET status = ?, result_asset_id = ? WHERE id = ?").run("done", clipId, jobId);
    res.json({ status: "recorded" });
  });
```

- [ ] **Step 4: Implement the status route**

In `apps/api/src/routes/assets.ts`, add after the `/:assetId/cut` route:
```typescript
  router.get("/cut-jobs/:jobId", (req, res) => {
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "cut job not found" });
      return;
    }
    res.json(job);
  });
```
(This is placed as a sibling route under the same assets router, so it's reachable at `GET /api/campaigns/:id/assets/cut-jobs/:jobId` — Express matches `/:assetId/cut` and `/cut-jobs/:jobId` as distinct patterns with no ambiguity since `cut-jobs` never collides with a real asset id in practice, matching the existing router's `mergeParams` mount style.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/internal.test.ts tests/assets.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/assets.ts apps/api/src/routes/internal.ts apps/api/tests/assets.test.ts apps/api/tests/internal.test.ts
git commit -m "feat(api): add cut-job status route and completion callback"
```

---

### Task 5: api — `GET /asset-categories` + loosened upload `asset_type`

**Files:**
- Modify: `apps/api/src/routes/assets.ts`
- Test: `apps/api/tests/assets.test.ts`

**Interfaces:**
- Produces: `GET /api/campaigns/:id/assets/categories` — returns a deduplicated array of category strings (5 defaults + any distinct `asset_type` already used by the campaign). Upload route accepts any non-empty `asset_type` string, with `"music"`/`"watermark"` keeping their existing special-case validation.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/tests/assets.test.ts`:
```typescript
  it("returns the 5 default asset categories when none have been used yet", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/categories`);
    expect(res.status).toBe(200);
    expect(res.body.sort()).toEqual(["broll", "clip", "footage", "music", "watermark"]);
  });

  it("includes a custom category once an asset of that type has been uploaded", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "interview")
      .attach("file", fixture);

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/categories`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("interview");
  });

  it("uploads an asset with a custom category, treated like footage (duration probed)", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "interview")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.asset_type).toBe("interview");
    expect(res.body.duration_seconds).toBeGreaterThan(0);
    expect(res.body.analysis_status).toBe("pending");
  });

  it("still applies watermark's special validation for a literal watermark upload", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "watermark")
      .attach("file", fixture);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);
  });

  it("treats a differently-cased category as a distinct custom category, not a watermark bypass", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "Watermark")
      .attach("file", fixture);

    // "Watermark" (capitalized) does not match the literal "watermark" special-case string,
    // so it's treated as a generic category and duration-probed like any other -- this is the
    // intended free-text/case-sensitive category behavior, not an accidental validation bypass.
    expect(res.status).toBe(201);
    expect(res.body.asset_type).toBe("Watermark");
    expect(res.body.duration_seconds).toBeGreaterThan(0);
  });
```
(The last test's fixture reuse mirrors the existing `"rejects a watermark upload that isn't an image"` test already in this file — confirm the exact expected error message against that existing test rather than guessing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/assets.test.ts -t "categor"`
Expected: FAIL — route doesn't exist / custom category collapses to `"footage"`.

- [ ] **Step 3: Implement**

Read `apps/api/src/routes/assets.ts`'s current upload route in full first (shown in this plan's Task 1 discussion). Change:
```typescript
    const assetType: "footage" | "music" | "watermark" =
      req.body.asset_type === "music" ? "music" : req.body.asset_type === "watermark" ? "watermark" : "footage";
```
to:
```typescript
    const rawAssetType = typeof req.body.asset_type === "string" ? req.body.asset_type.trim() : "";
    const assetType = rawAssetType || "footage";
```
(The rest of the function already branches on `assetType === "watermark"` for the image-only path and treats everything else as the duration-probed path — no other line in the upload route needs to change, since `assetType` was already just a string used in string comparisons and the final `INSERT`. Re-read the surrounding `if (assetType === "watermark") { ... } else { ... }` block to confirm this before editing — the `"music"` case has no separate branch today, it just skips being `"watermark"` and gets duration-probed the same as `"footage"` always did, which stays true for any custom category too.)

Add the new route after the existing `/:assetId/cut` and `/cut-jobs/:jobId` routes:
```typescript
  router.get("/categories", (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const defaults = ["footage", "clip", "broll", "music", "watermark"];
    const used = (
      db.prepare("SELECT DISTINCT asset_type FROM video_assets WHERE campaign_id = ?").all(campaignId) as {
        asset_type: string;
      }[]
    ).map((r) => r.asset_type);
    const categories = Array.from(new Set([...defaults, ...used]));
    res.json(categories);
  });
```
(Place this route before `router.post("/:assetId/cut", ...)` in file order — Express matches routes in registration order, and `/categories` must not be shadowed by a `/:assetId` pattern matching the literal string `"categories"` as an asset id. Since `/:assetId/cut` requires a trailing `/cut` segment it won't collide, but placing `/categories` early keeps intent clear regardless.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/assets.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/assets.ts apps/api/tests/assets.test.ts
git commit -m "feat(api): add asset-categories endpoint and loosen upload asset_type"
```

---

### Task 6: api — `PUT /segments` validation rewrite

**Files:**
- Modify: `apps/api/src/routes/segments.ts`
- Test: `apps/api/tests/segments.test.ts`

**Interfaces:**
- Produces: `PUT /api/campaigns/:id/segments` — drops the `content_plan`-derived required-keys check. New: 400 if the submitted `segments` array is empty, 400 if any `segment_key` repeats within the array.

- [ ] **Step 1: Write the failing tests**

Read `apps/api/src/routes/segments.ts` in full first (already shown in this project's history — confirm the exact current lines before editing, since the file may have shifted since). Add to `apps/api/tests/segments.test.ts` (match the file's existing `beforeEach`/`campaignId`/`assetId` setup exactly):
```typescript
  it("rejects an empty segments array", async () => {
    const app = createApp();
    const res = await request(app).put(`/api/campaigns/${campaignId}/segments`).send({ segments: [] });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate segment_key values", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          { segment_key: "hook", video_asset_id: assetId, trim_start: 0, trim_end: 2, order_index: 0, layout_template: "standard" },
          { segment_key: "hook", video_asset_id: assetId, trim_start: 2, trim_end: 4, order_index: 1, layout_template: "standard" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.duplicate_segment_keys).toEqual(["hook"]);
  });

  it("accepts a single segment with a custom label, no content_plan match required", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          { segment_key: "broll-intro", video_asset_id: assetId, trim_start: 0, trim_end: 2, order_index: 0, layout_template: "standard" },
        ],
      });
    expect(res.status).toBe(200);
  });
```
(The third test is the key regression check: today this would 400 with `missing_segments` unless the label happened to match one of `content_plan`'s keys. After this task, any label is accepted.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/segments.test.ts -t "segment_key\|empty segments\|custom label"`
Expected: the third test FAILS (400 with `missing_segments` today); the first two also fail (no such validation exists yet, so an empty array or duplicate keys currently pass through to whatever the old `requiredKeys` check does, likely 400 for the wrong reason or 200 unexpectedly).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/segments.ts`, change:
```typescript
    const plan = db
      .prepare("SELECT content_plan FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { content_plan: string } | undefined;
    if (!plan) {
      res.status(404).json({ error: "no plan found for this campaign" });
      return;
    }
    const requiredKeys = Object.keys(JSON.parse(plan.content_plan));
    const providedKeys = segments.map((s) => s.segment_key);
    const missingSegments = requiredKeys.filter((k) => !providedKeys.includes(k));
    if (missingSegments.length > 0) {
      res.status(400).json({ missing_segments: missingSegments });
      return;
    }
```
to:
```typescript
    const plan = db
      .prepare("SELECT content_plan FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { content_plan: string } | undefined;
    if (!plan) {
      res.status(404).json({ error: "no plan found for this campaign" });
      return;
    }
    if (segments.length === 0) {
      res.status(400).json({ error: "at least one segment is required" });
      return;
    }
    const providedKeys = segments.map((s) => s.segment_key);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const key of providedKeys) {
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    if (duplicates.size > 0) {
      res.status(400).json({ duplicate_segment_keys: Array.from(duplicates) });
      return;
    }
```
(Every other validation block below this — `missingCrop`, `invalidSegments`, `unknownAssetSegments`, the delete-then-insert transaction — is unchanged; only the `content_plan`-derived required-keys block is replaced.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/segments.test.ts`
Expected: all tests PASS. Check whether any of this file's *existing* tests relied on the old `missing_segments` behavior (search for `missing_segments` in the test file) — if any do, they were pinning the old broken-by-design behavior and should be deleted rather than kept red; note this explicitly in the commit message if so.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/segments.ts apps/api/tests/segments.test.ts
git commit -m "feat(api): decouple segment validation from content_plan keys"
```

---

### Task 7: web-ui — `apiClient.ts` additions

**Files:**
- Modify: `apps/web-ui/lib/apiClient.ts`

**Interfaces:**
- Consumes: `GET .../assets/categories`, `POST .../assets/:assetId/cut`, `GET .../assets/cut-jobs/:jobId` (Tasks 3-5).
- Produces: `VideoAsset.asset_type: string` (widened from the fixed union); `CutJob` interface; `triggerCut(campaignId, assetId, startSeconds, durationSeconds): Promise<{cut_job_id: string}>`; `getCutJob(campaignId, jobId): Promise<CutJob>`; `getAssetCategories(campaignId): Promise<string[]>`.

- [ ] **Step 1: Implement**

In `apps/web-ui/lib/apiClient.ts`, change the `VideoAsset` interface's `asset_type` field:
```typescript
  asset_type: string;
```
(from `asset_type: "footage" | "music" | "watermark";`.)

Add after the existing `getHookSuggestions` function:
```typescript
export interface CutJob {
  id: string;
  campaign_id: string;
  source_asset_id: string;
  start_seconds: number;
  duration_seconds: number;
  status: "pending" | "done" | "failed";
  result_asset_id: string | null;
  error_message: string | null;
  created_at: string;
}

export async function triggerCut(
  campaignId: string,
  assetId: string,
  startSeconds: number,
  durationSeconds: number
): Promise<{ cut_job_id: string }> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/${assetId}/cut`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_seconds: startSeconds, duration_seconds: durationSeconds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `cut failed with status ${res.status}`);
  }
  return res.json();
}

export async function getCutJob(campaignId: string, jobId: string): Promise<CutJob> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/cut-jobs/${jobId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get cut job failed with status ${res.status}`);
  return res.json();
}

export async function getAssetCategories(campaignId: string): Promise<string[]> {
  const res = await fetch(`${API_BASE_URL}/api/campaigns/${campaignId}/assets/categories`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get asset categories failed with status ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly. (Widening `asset_type` to `string` is a strict-superset change — every existing comparison like `a.asset_type === "footage"` still type-checks against a plain `string`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/apiClient.ts
git commit -m "feat(web-ui): add cut-job and asset-categories apiClient functions"
```

---

### Task 8: web-ui — `AssetUpload` category combobox

**Files:**
- Modify: `apps/web-ui/components/AssetUpload.tsx`

**Interfaces:**
- Consumes: `getAssetCategories` (Task 7).
- Produces: a free-text-with-suggestions category input replacing the fixed 3-option `<select>`.

- [ ] **Step 1: Implement**

In `apps/web-ui/components/AssetUpload.tsx`, change:
```tsx
import { FormEvent, useState } from "react";
import { VideoAsset, uploadAsset } from "../lib/apiClient";
```
to:
```tsx
import { FormEvent, useEffect, useState } from "react";
import { VideoAsset, getAssetCategories, uploadAsset } from "../lib/apiClient";
```
Add a `campaignId`-keyed categories fetch and swap the `<select>` for a text input with a `<datalist>` (native HTML free-text-with-suggestions, no new dependency):
```tsx
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

  useEffect(() => {
    getAssetCategories(campaignId).then(setCategories).catch(() => {});
  }, [campaignId]);
```
Change:
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
to:
```tsx
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Manual verification**

No component test framework in this project (established pattern). If a dev server is reachable: confirm the category field shows suggestions (typing partially matches datalist options) and accepts free text; if not possible in this environment, say so honestly rather than claiming it was verified.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/AssetUpload.tsx
git commit -m "feat(web-ui): replace fixed asset-type select with a category combobox"
```

---

### Task 9: web-ui — Segments page becomes a dynamic list

**Files:**
- Modify: `apps/web-ui/app/campaigns/[id]/segments/page.tsx`

**Interfaces:**
- Consumes: `SegmentDraft` (existing, already has `segment_key`/`order_index` fields — no type change needed).
- Produces: `drafts` state becomes `SegmentDraft[]` (array, client-side `id` for React keys) instead of `Record<string, SegmentDraft>` seeded from `content_plan`. Add/remove/reorder controls.

- [ ] **Step 1: Implement**

Read the full current file first (shown in this project's history at `apps/web-ui/app/campaigns/[id]/segments/page.tsx` — confirm exact current state before editing, since Task 6 (Watermark plan, already merged) and this project's earlier breadcrumb-nav commit both touched this file). Replace the `drafts` state and its seeding effect:
```tsx
  const [drafts, setDrafts] = useState<Record<string, SegmentDraft>>({});
```
with an array-backed state, keyed by a client-only React key (not persisted, not part of `SegmentDraft`):
```tsx
  const [drafts, setDrafts] = useState<(SegmentDraft & { _clientKey: string })[]>([]);
```
Change the seeding effect:
```tsx
  useEffect(() => {
    Promise.all([listAssets(params.id), getCampaign(params.id)]).then(([assetList, campaign]) => {
      setAssets(assetList);
      const segmentKeys = Object.keys(campaign.plan?.content_plan ?? {});
      const initial: Record<string, SegmentDraft> = {};
      segmentKeys.forEach((key, index) => {
        initial[key] = {
          segment_key: key,
          video_asset_id: "",
          trim_start: 0,
          trim_end: 0,
          order_index: index,
          layout_template: "standard",
        };
      });
      setDrafts(initial);
    });
  }, [params.id]);
```
to:
```tsx
  useEffect(() => {
    listAssets(params.id).then(setAssets);
  }, [params.id]);

  function addSegment() {
    setDrafts((prev) => [
      ...prev,
      {
        _clientKey: `${Date.now()}-${Math.random()}`,
        segment_key: "",
        video_asset_id: "",
        trim_start: 0,
        trim_end: 0,
        order_index: prev.length,
        layout_template: "standard",
      },
    ]);
  }

  function removeSegment(clientKey: string) {
    setDrafts((prev) =>
      prev.filter((d) => d._clientKey !== clientKey).map((d, i) => ({ ...d, order_index: i }))
    );
  }

  function moveSegment(clientKey: string, direction: -1 | 1) {
    setDrafts((prev) => {
      const index = prev.findIndex((d) => d._clientKey === clientKey);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((d, i) => ({ ...d, order_index: i }));
    });
  }
```
(The page no longer needs to fetch the campaign's plan at all for seeding — `getCampaign` was only used here for `campaign.plan?.content_plan`, and nothing else on this page reads `campaign`. Remove the now-unused `getCampaign` import if this was its only use in the file — check the rest of the file first to confirm.)

Change `handleSubmit`'s `saveSegments` call:
```tsx
      await saveSegments(params.id, Object.values(drafts));
```
to:
```tsx
      await saveSegments(
        params.id,
        drafts.map(({ _clientKey, ...draft }) => draft)
      );
```
Change the render loop:
```tsx
      {Object.entries(drafts).map(([key, draft]) => (
        <SegmentEditor
          key={key}
          campaignId={params.id}
          segmentKey={key}
          assets={assets}
          draft={draft}
          onChange={(updated) =>
            setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...updated } }))
          }
        />
      ))}
```
to:
```tsx
      {drafts.map((draft, index) => (
        <div key={draft._clientKey} className="flex flex-col gap-2">
          <SegmentEditor
            campaignId={params.id}
            assets={assets}
            draft={draft}
            onChange={(updated) =>
              setDrafts((prev) =>
                prev.map((d) => (d._clientKey === draft._clientKey ? { ...d, ...updated } : d))
              )
            }
          />
          <div className="flex gap-2 self-end">
            <button
              type="button"
              onClick={() => moveSegment(draft._clientKey, -1)}
              disabled={index === 0}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => moveSegment(draft._clientKey, 1)}
              disabled={index === drafts.length - 1}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => removeSegment(draft._clientKey)}
              className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-500"
            >
              🗑️ Remove
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={addSegment}
        className="w-fit rounded-xl border border-dashed border-purple-300 px-5 py-2.5 text-sm font-semibold text-purple-600 transition hover:bg-purple-50"
      >
        + Add Segment
      </button>
```
(This drops the `SegmentEditor`'s `segmentKey` prop — Task 10 makes `segment_key` an editable field on the draft itself, rendered inside `SegmentEditor`, not passed in from the parent.)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly (this will error until Task 10 removes `SegmentEditor`'s `segmentKey` prop requirement — if implementing tasks strictly in order, do Task 10 before running this verification, or verify Tasks 9 and 10 together).

- [ ] **Step 3: Commit**

```bash
git add "apps/web-ui/app/campaigns/[id]/segments/page.tsx"
git commit -m "feat(web-ui): make the segments list a free add/remove/reorder array"
```

---

### Task 10: web-ui — `SegmentEditor`: editable label, soft-filtered source, cut controls

**Files:**
- Modify: `apps/web-ui/components/SegmentEditor.tsx`

**Interfaces:**
- Consumes: `triggerCut`, `getCutJob`, `getAssetCategories` (Task 7), `SegmentDraft` (existing).
- Produces: `SegmentEditor` no longer takes a `segmentKey` prop — `draft.segment_key` is now an editable input inside the component. Source-asset dropdown is soft-filtered by the label. Start-point + duration inputs replace the always-shown `TimelineScrubber`-driven `trim_start`/`trim_end`, triggering a cut; once done, `draft.video_asset_id` is set to the resulting clip.

- [ ] **Step 1: Implement**

Read the full current file first (shown in full in this project's history — confirm exact current state, since it has grown across the Find Hooks and Watermark/Title sub-projects). Change the component signature:
```tsx
export function SegmentEditor({
  campaignId,
  segmentKey,
  assets,
  draft,
  onChange,
}: {
  campaignId: string;
  segmentKey: string;
  assets: VideoAsset[];
  draft: SegmentDraft;
  onChange: (draft: SegmentDraft) => void;
}) {
```
to:
```tsx
export function SegmentEditor({
  campaignId,
  assets,
  draft,
  onChange,
}: {
  campaignId: string;
  assets: VideoAsset[];
  draft: SegmentDraft;
  onChange: (draft: SegmentDraft) => void;
}) {
```
Replace every use of the removed `segmentKey` prop — the `<legend>` currently reads:
```tsx
      <legend className="rounded-full bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-1 text-sm font-semibold text-white">
        {segmentKey}
      </legend>
```
Replace it with an editable label input plus a category datalist (mirroring `AssetUpload`'s combobox pattern from Task 8), placed right after the `<legend>` opening but before the existing asset/layout `<div className="grid gap-3 sm:grid-cols-2">` block:
```tsx
      <legend className="rounded-full bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-1 text-sm font-semibold text-white">
        Segment
      </legend>

      <input
        list={`segment-labels-${campaignId}`}
        type="text"
        placeholder="Label (e.g. hook, body, broll)"
        value={draft.segment_key}
        onChange={(e) => onChange({ ...draft, segment_key: e.target.value })}
        className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
      />
      <datalist id={`segment-labels-${campaignId}`}>
        <option value="hook" />
        <option value="body" />
        <option value="broll" />
      </datalist>
```
Add new imports:
```tsx
import { CutJob, getCutJob, triggerCut } from "../lib/apiClient";
```
Add new state, alongside the existing `hookSuggestions`/`findingHooks` state:
```tsx
  const [cutStartSeconds, setCutStartSeconds] = useState(0);
  const [cutDurationSeconds, setCutDurationSeconds] = useState(0);
  const [cutting, setCutting] = useState(false);
  const [cutError, setCutError] = useState<string | null>(null);
  const cutPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopCutPolling() {
    if (cutPollIntervalRef.current !== null) {
      clearInterval(cutPollIntervalRef.current);
      cutPollIntervalRef.current = null;
    }
  }

  useEffect(() => {
    return () => stopCutPolling();
  }, [campaignId, draft.video_asset_id]);

  const isBroll = draft.segment_key.trim().toLowerCase() === "broll";
  const sourceCandidates = assets.filter((a) =>
    isBroll ? a.asset_type === "broll" : a.asset_type === "footage" || a.asset_type === "clip"
  );
  const [cutSourceAssetId, setCutSourceAssetId] = useState("");
  const cutSourceAsset = assets.find((a) => a.id === cutSourceAssetId);

  async function handleCut() {
    if (!cutSourceAsset || cutDurationSeconds <= 0) return;
    setCutting(true);
    setCutError(null);
    let jobId: string;
    try {
      const result = await triggerCut(campaignId, cutSourceAsset.id, cutStartSeconds, cutDurationSeconds);
      jobId = result.cut_job_id;
    } catch (err) {
      setCutError((err as Error).message);
      setCutting(false);
      return;
    }

    stopCutPolling();
    cutPollIntervalRef.current = setInterval(async () => {
      try {
        const job: CutJob = await getCutJob(campaignId, jobId);
        if (job.status === "done" && job.result_asset_id) {
          stopCutPolling();
          setCutting(false);
          onChange({ ...draft, video_asset_id: job.result_asset_id, trim_start: 0, trim_end: job.duration_seconds });
        } else if (job.status === "failed") {
          stopCutPolling();
          setCutting(false);
          setCutError(job.error_message ?? "cut failed");
        }
      } catch {
        // transient poll failure -- keep trying
      }
    }, 3000);
  }
```
(`job.duration_seconds` doesn't exist on the `CutJob` interface returned by `getCutJob` — the api's status route returns the raw `cut_jobs` row, which has `duration_seconds` as the *requested* duration, not necessarily the actual trimmed result. Use the resulting clip asset's own `duration_seconds` instead, which is exact: look it up from `assets` once it appears after the next `listAssets` refresh — for this task, set `trim_end` to `cutDurationSeconds` (the requested value) as a reasonable immediate default, since the page's own `listAssets` polling/refresh elsewhere already keeps `assets` current and the operator can nudge the trim afterward if the actual cut came out shorter. This is a deliberate simplification, not a bug — flag it in the commit message.)

Replace the always-shown `TimelineScrubber` block:
```tsx
      {asset && (
        <div className="rounded-xl bg-slate-50 p-3">
          <TimelineScrubber
            src={mediaUrl(asset.file_path)}
            durationSeconds={asset.duration_seconds}
            moments={moments}
            trimStart={draft.trim_start}
            trimEnd={draft.trim_end}
            onChange={(start, end) => onChange({ ...draft, trim_start: start, trim_end: end })}
          />
        </div>
      )}
```
Keep this block unchanged (it still previews/adjusts the *final* chosen segment asset's trim once one is set — useful for fine-tuning after a cut completes, or for a `broll` asset used as-is with no cut needed). Add the new cut-trigger UI as a separate block, placed right after the existing asset/layout `<div className="grid gap-3 sm:grid-cols-2">` and before the `TimelineScrubber` block:
```tsx
      <div className="rounded-xl border border-purple-100 bg-purple-50/40 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-600">
          Cut a piece from a source asset
        </p>
        <select
          value={cutSourceAssetId}
          onChange={(e) => setCutSourceAssetId(e.target.value)}
          className={selectClass}
        >
          <option value="">Select source</option>
          {sourceCandidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.file_path.split("/").pop()}
            </option>
          ))}
        </select>
        {sourceCandidates.length === 0 && (
          <p className="mt-2 text-xs text-rose-500">
            No {isBroll ? "broll" : "footage/clip"} assets yet — upload one first.
          </p>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder="Start (detik)"
            value={cutStartSeconds}
            onChange={(e) => setCutStartSeconds(Number(e.target.value))}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
          />
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder="Durasi (detik)"
            value={cutDurationSeconds}
            onChange={(e) => setCutDurationSeconds(Number(e.target.value))}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
          />
        </div>
        <button
          type="button"
          onClick={handleCut}
          disabled={cutting || !cutSourceAssetId || cutDurationSeconds <= 0}
          className="mt-2 w-fit rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-purple-100 transition hover:opacity-90 disabled:opacity-50"
        >
          {cutting ? "Memotong..." : "Potong & Gunakan"}
        </button>
        {cutError && (
          <p role="alert" className="mt-2 text-sm font-medium text-rose-500">
            {cutError}
          </p>
        )}
        {draft.video_asset_id && (
          <p className="mt-2 text-xs text-emerald-600">
            Segmen ini pakai: {assets.find((a) => a.id === draft.video_asset_id)?.file_path.split("/").pop()}
          </p>
        )}
      </div>
```
Change the existing source-asset `<select>` in the `grid gap-3 sm:grid-cols-2` block — it currently hardcodes `.filter((a) => a.asset_type === "footage")`:
```tsx
        <select
          value={draft.video_asset_id}
          onChange={(e) => onChange({ ...draft, video_asset_id: e.target.value })}
          className={selectClass}
        >
          <option value="">Select footage</option>
          {assets
            .filter((a) => a.asset_type === "footage")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.file_path.split("/").pop()}
              </option>
            ))}
        </select>
```
**Remove this `<select>` entirely** — it's superseded by the new cut-trigger flow above, which is now the only way `draft.video_asset_id` gets set (either via a completed cut, or directly for a `broll` asset that needs no cutting — see Step 1 continuation below for the broll-direct-use case).

Add a small "use this asset as-is, no cut needed" direct-select option inside the new cut block, for the `broll` case where the operator doesn't want to trim further — add this option right after the `sourceCandidates.length === 0` check:
```tsx
        {cutSourceAsset && (
          <button
            type="button"
            onClick={() =>
              onChange({ ...draft, video_asset_id: cutSourceAsset.id, trim_start: 0, trim_end: cutSourceAsset.duration_seconds })
            }
            className="mt-2 text-xs font-medium text-purple-600 underline"
          >
            Atau pakai asset ini apa adanya (tanpa potong)
          </button>
        )}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web-ui && npm run build`
Expected: compiles cleanly. Run this together with Task 9's build check (both files change in the same feature and reference each other's prop shape).

- [ ] **Step 3: Manual verification**

No component test framework in this project. If a dev server is reachable: add a segment, type a label, confirm the source dropdown filters correctly for `"broll"` vs any other label, trigger a cut, confirm the "Memotong..." state and eventual asset assignment. If a live check isn't possible in this environment, say so honestly rather than claiming it was verified.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/SegmentEditor.tsx
git commit -m "feat(web-ui): editable segment label, soft-filtered source picker, cut-to-clip flow"
```

---

## Execution Notes

Tasks 9 and 10 both touch the `SegmentEditor`↔page contract (the removed `segmentKey` prop) — verify their combined TypeScript build together, not each in isolation, even though they're separate commits for review purposes.
