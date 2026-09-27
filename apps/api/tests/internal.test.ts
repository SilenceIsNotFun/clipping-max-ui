import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

describe("internal analysis-complete callback", () => {
  let dbPath: string;
  let assetId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    process.env.DATA_DIR = dataDir;
    process.env.VIDEO_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "video-assets-"));

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("campaign-1", "Test", "planned", "/x.pdf", now, now);
    assetId = "asset-1";
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, "campaign-1", "/video-assets/a.mp4", "footage", 2.0, "pending", now);
  });

  it("stores moment candidates and marks analysis done", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({
        video_asset_id: assetId,
        moment_candidates: [{ timestamp_ms: 1500, score: 0.9, detection_type: "audio_peak" }],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(assetId) as any;
    expect(asset.analysis_status).toBe("done");
    const candidates = db.prepare("SELECT * FROM moment_candidates WHERE video_asset_id = ?").all(assetId);
    expect(candidates).toHaveLength(1);
  });

  it("marks analysis failed when video-worker reports an error", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({ video_asset_id: assetId, error: "corrupt file" });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(assetId) as any;
    expect(asset.analysis_status).toBe("failed");
  });

  it("stores a crop suggestion when the callback includes one", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({
        video_asset_id: assetId,
        moment_candidates: [],
        crop_suggestion: {
          crop_gameplay_rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
          crop_facecam_rect: null,
          detection_method: "face",
          confidence: 0.7,
        },
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM crop_suggestions WHERE video_asset_id = ?").all(assetId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].detection_method).toBe("face");
    expect(JSON.parse(rows[0].crop_gameplay_rect).x).toBe(0.1);
  });

  it("does not store a crop suggestion when the callback's crop_suggestion is null", async () => {
    const app = createApp();
    await request(app)
      .post(`/api/internal/assets/${assetId}/analysis-complete`)
      .send({ video_asset_id: assetId, moment_candidates: [], crop_suggestion: null });

    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM crop_suggestions WHERE video_asset_id = ?").all(assetId);
    expect(rows).toHaveLength(0);
  });
});

describe("internal render-complete callback", () => {
  let dbPath: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    process.env.DATA_DIR = dataDir;
    process.env.VIDEO_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "video-assets-"));

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("campaign-1", "Test", "planned", "/x.pdf", now, now);
    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("job-1", "campaign-1", "rendering", "id_ID-voice-medium", null, null, null, now, now);
  });

  it("marks job ready_for_preview and stores caption_words on success", async () => {
    const app = createApp();
    const res = await request(app).post("/api/internal/render/job-1/complete").send({
      job_id: "job-1",
      output_path: "/video-assets/exports/job-1.mp4",
      caption_words: [{ word: "hi", start_ms: 0, end_ms: 300 }],
    });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get("job-1") as any;
    expect(job.status).toBe("ready_for_preview");
    expect(job.output_path).toBe("/video-assets/exports/job-1.mp4");
    const words = db.prepare("SELECT * FROM caption_words WHERE render_job_id = ?").all("job-1");
    expect(words).toHaveLength(1);
  });

  it("marks job failed with error_message on failure", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/internal/render/job-1/complete")
      .send({ job_id: "job-1", error: "ffmpeg exploded" });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get("job-1") as any;
    expect(job.status).toBe("failed");
    expect(job.error_message).toBe("ffmpeg exploded");
  });
});

describe("internal hooks-complete callback", () => {
  let dbPath: string;
  let assetId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    process.env.DATA_DIR = dataDir;
    process.env.VIDEO_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "video-assets-"));

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("campaign-1", "Test", "planned", "/x.pdf", now, now);
    assetId = "asset-1";
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, "campaign-1", "/video-assets/a.mp4", "footage", 2.0, "pending", now);
  });

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
});
