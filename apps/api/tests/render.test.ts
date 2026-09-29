import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
  submitRender: jest.fn().mockResolvedValue(undefined),
}));

describe("render routes", () => {
  let dbPath: string;
  let campaignId: string;
  let assetId: string;

  beforeEach(() => {
    resetDbCacheForTests();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    process.env.DATA_DIR = dataDir;
    process.env.VIDEO_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "video-assets-"));
    process.env.VIDEO_WORKER_URL = "http://video-worker:8100";
    process.env.API_INTERNAL_CALLBACK_URL = "http://api:4000/api/internal";
    jest.clearAllMocks();

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    campaignId = "campaign-1";
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test", "planned", "/x.pdf", now, now);
    db.prepare(
      `INSERT INTO plans (id, campaign_id, strategy_summary, requirements_checklist, content_plan, opportunity_score, pdf_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("plan-1", campaignId, "s", "[]", JSON.stringify({ hook: { script: "hi" } }), 50, null, now);
    assetId = "asset-1";
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, campaignId, "/video-assets/a.mp4", "footage", 5.0, "done", now);
    db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text, caption_style)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("seg-1", campaignId, "hook", assetId, null, 0, 2, 0, "standard", null, null, null, "warning");
  });

  it("submits a render job and returns queued status", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({ tts_voice: "id_ID-voice-medium" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).toBeDefined();

    const { submitRender } = require("../src/services/videoWorkerClient");
    const callArgs = (submitRender as jest.Mock).mock.calls[0];
    const segmentsPayload = callArgs[2];
    expect(segmentsPayload[0].caption_style).toBe("warning");
  });

  it("returns job status via GET", async () => {
    const app = createApp();
    const submitRes = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({ tts_voice: "id_ID-voice-medium" });

    const statusRes = await request(app).get(
      `/api/campaigns/${campaignId}/render/${submitRes.body.job_id}`
    );
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("rendering");
  });

  it("marks the job failed and still responds when submitRender rejects", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    (submitRender as jest.Mock).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({ tts_voice: "id_ID-voice-medium" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("failed");

    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(res.body.job_id) as any;
    expect(job.status).toBe("failed");
    expect(job.error_message).toBe("video-worker unreachable");
  });

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

  it("rejects watermark_asset_id without watermark_rect with a 400", async () => {
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("watermark-asset-2", campaignId, "/app/video-assets/logo2.png", "watermark", 0, "done", now);

    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({
        tts_voice: "id_ID-news_tts-medium",
        watermark_asset_id: "watermark-asset-2",
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "watermark_rect is required when watermark_asset_id is set" });

    const jobRows = db.prepare("SELECT * FROM render_jobs WHERE campaign_id = ?").all(campaignId);
    expect(jobRows.length).toBe(0);
  });

  it("rejects a nonexistent watermark_asset_id with a 400, not a 500", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({
        tts_voice: "id_ID-news_tts-medium",
        watermark_asset_id: "does-not-exist",
        watermark_rect: { x: 0.7, y: 0.05, width: 0.25, height: 0.1 },
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "watermark_asset_id does not refer to a valid watermark asset in this campaign" });
  });

  it("rejects a watermark_asset_id belonging to a different campaign with a 400", async () => {
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    const otherCampaignId = "campaign-other";
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(otherCampaignId, "Other", "planned", "/y.pdf", now, now);
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("watermark-other-campaign", otherCampaignId, "/app/video-assets/other-logo.png", "watermark", 0, "done", now);

    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({
        tts_voice: "id_ID-news_tts-medium",
        watermark_asset_id: "watermark-other-campaign",
        watermark_rect: { x: 0.7, y: 0.05, width: 0.25, height: 0.1 },
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "watermark_asset_id does not refer to a valid watermark asset in this campaign" });
  });

  it("rejects a watermark_asset_id pointing to a non-watermark asset with a 400", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/render`)
      .send({
        tts_voice: "id_ID-news_tts-medium",
        watermark_asset_id: assetId, // this is a "footage" asset from beforeEach
        watermark_rect: { x: 0.7, y: 0.05, width: 0.25, height: 0.1 },
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "watermark_asset_id does not refer to a valid watermark asset in this campaign" });
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

  it("includes title_font, title_color, caption_font, and caption_rect in the segment payload", async () => {
    const { submitRender } = require("../src/services/videoWorkerClient");
    const db = getDb(dbPath);
    db.prepare(
      "UPDATE segment_assignments SET title_font = ?, title_color = ?, caption_font = ?, caption_rect = ? WHERE campaign_id = ?"
    ).run("anton", "#FFD700", "montserrat", JSON.stringify({ x: 0.1, y: 0.05, width: 0.8, height: 0.1 }), campaignId);

    const app = createApp();
    await request(app).post(`/api/campaigns/${campaignId}/render`).send({ tts_voice: "id_ID-news_tts-medium" });

    const callArgs = (submitRender as jest.Mock).mock.calls[0];
    const segmentPayloads = callArgs[2];
    expect(segmentPayloads[0].title_font).toBe("anton");
    expect(segmentPayloads[0].title_color).toBe("#FFD700");
    expect(segmentPayloads[0].caption_font).toBe("montserrat");
    expect(segmentPayloads[0].caption_rect).toEqual({ x: 0.1, y: 0.05, width: 0.8, height: 0.1 });
  });

  it("finalizes a ready render job", async () => {
    const app = createApp();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("job-1", campaignId, "ready_for_preview", "id_ID-voice-medium", null, "/exports/job-1.mp4", null, now, now);

    const res = await request(app).post(`/api/campaigns/${campaignId}/render/job-1/finalize`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
  });
});
