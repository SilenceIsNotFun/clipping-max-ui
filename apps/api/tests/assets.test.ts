import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

jest.mock("../src/services/videoWorkerClient", () => ({
  analyzeAsset: jest.fn().mockResolvedValue(undefined),
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
});
