import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
  findHooks: jest.fn().mockResolvedValue(undefined),
  triggerCut: jest.fn().mockResolvedValue(undefined),
  triggerYoutubeDownload: jest.fn().mockResolvedValue(undefined),
}));

describe("asset routes", () => {
  let dataDir: string;
  let campaignId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    process.env.UPLOAD_DIR = uploadDir;
    process.env.DATA_DIR = dataDir;
    process.env.DB_PATH = path.join(dataDir, "app.db");
    process.env.VIDEO_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "video-assets-"));
    process.env.VIDEO_WORKER_URL = "http://video-worker:8100";
    process.env.API_INTERNAL_CALLBACK_URL = "http://api:4000/api/internal";
    jest.clearAllMocks();

    const { getDb } = require("../src/db");
    const db = getDb(process.env.DB_PATH);
    campaignId = "campaign-1";
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test Campaign", "planned", "/uploads/brd.pdf", now, now);
  });

  it("uploads a footage asset and triggers analysis", async () => {
    const { analyzeAsset } = require("../src/services/videoWorkerClient");
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.asset_type).toBe("footage");
    expect(res.body.analysis_status).toBe("pending");
    expect(analyzeAsset).toHaveBeenCalledTimes(1);
  });

  it("lists assets for a campaign", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    await request(app).post(`/api/campaigns/${campaignId}/assets`).field("asset_type", "footage").attach("file", fixture);

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("still creates the asset (marked failed) when analyzeAsset rejects", async () => {
    const { analyzeAsset } = require("../src/services/videoWorkerClient");
    (analyzeAsset as jest.Mock).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    expect(res.status).toBe(201);
    expect(res.body.asset_type).toBe("footage");

    const getRes = await request(app).get(`/api/campaigns/${campaignId}/assets`);
    expect(getRes.status).toBe(200);
    expect(getRes.body[0].analysis_status).toBe("failed");
  });

  it("rejects upload with unreadable/zero-duration file", async () => {
    const app = createApp();
    const badFile = path.join(os.tmpdir(), "bad.mp4");
    fs.writeFileSync(badFile, "not a real video");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", badFile);

    expect(res.status).toBe(400);
  });

  it("returns the crop suggestion for an asset", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);
    const assetId = uploadRes.body.id;

    const db = getDb(process.env.DB_PATH as string);
    db.prepare(
      `INSERT INTO crop_suggestions (id, video_asset_id, crop_gameplay_rect, crop_facecam_rect, detection_method, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "suggestion-1",
      assetId,
      JSON.stringify({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }),
      null,
      "face",
      0.7,
      new Date().toISOString()
    );

    const res = await request(app).get(`/api/campaigns/${campaignId}/assets/${assetId}/crop-suggestion`);
    expect(res.status).toBe(200);
    expect(res.body.detection_method).toBe("face");
    expect(JSON.parse(res.body.crop_gameplay_rect).x).toBe(0.2);
  });

  it("returns 404 when no crop suggestion exists for an asset", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);

    const res = await request(app).get(
      `/api/campaigns/${campaignId}/assets/${uploadRes.body.id}/crop-suggestion`
    );
    expect(res.status).toBe(404);
  });

  it("deletes an asset, its file, and its moment/crop-suggestion rows", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);
    const assetId = uploadRes.body.id;
    const filePath = uploadRes.body.file_path;
    expect(fs.existsSync(filePath)).toBe(true);

    const db = getDb(process.env.DB_PATH as string);
    db.prepare(
      `INSERT INTO moment_candidates (id, video_asset_id, timestamp_ms, score, detection_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("moment-1", assetId, 1000, 0.8, "audio_peak", new Date().toISOString());
    db.prepare(
      `INSERT INTO crop_suggestions (id, video_asset_id, crop_gameplay_rect, crop_facecam_rect, detection_method, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("suggestion-1", assetId, null, null, "saliency", 0.4, new Date().toISOString());

    const res = await request(app).delete(`/api/campaigns/${campaignId}/assets/${assetId}`);
    expect(res.status).toBe(204);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(db.prepare("SELECT * FROM video_assets WHERE id = ?").get(assetId)).toBeUndefined();
    expect(db.prepare("SELECT * FROM moment_candidates WHERE video_asset_id = ?").all(assetId)).toHaveLength(0);
    expect(db.prepare("SELECT * FROM crop_suggestions WHERE video_asset_id = ?").all(assetId)).toHaveLength(0);

    const listRes = await request(app).get(`/api/campaigns/${campaignId}/assets`);
    expect(listRes.body).toHaveLength(0);
  });

  it("deletes an asset that has hook_suggestions rows without a foreign key error", async () => {
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
    ).run("hs-delete-1", assetId, 1000, 10000, "Title A", "Reason A", new Date().toISOString());

    const res = await request(app).delete(`/api/campaigns/${campaignId}/assets/${assetId}`);
    expect(res.status).toBe(204);

    expect(db.prepare("SELECT * FROM video_assets WHERE id = ?").get(assetId)).toBeUndefined();
    expect(db.prepare("SELECT * FROM hook_suggestions WHERE video_asset_id = ?").all(assetId)).toHaveLength(0);
  });

  it("returns 404 when deleting an unknown asset", async () => {
    const app = createApp();
    const res = await request(app).delete(`/api/campaigns/${campaignId}/assets/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("refuses to delete an asset that is used in a segment assignment", async () => {
    const app = createApp();
    const fixture = path.join(__dirname, "fixtures", "short_clip.mp4");
    const uploadRes = await request(app)
      .post(`/api/campaigns/${campaignId}/assets`)
      .field("asset_type", "footage")
      .attach("file", fixture);
    const assetId = uploadRes.body.id;

    const db = getDb(process.env.DB_PATH as string);
    db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, trim_start, trim_end, order_index, layout_template)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("segment-1", campaignId, "hook", assetId, 0, 5, 0, "standard");

    const res = await request(app).delete(`/api/campaigns/${campaignId}/assets/${assetId}`);
    expect(res.status).toBe(409);

    expect(fs.existsSync(uploadRes.body.file_path)).toBe(true);
    expect(db.prepare("SELECT * FROM video_assets WHERE id = ?").get(assetId)).toBeDefined();
  });

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
});
