import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

describe("segment assignment route", () => {
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

    const db = getDb(dbPath);
    const now = new Date().toISOString();
    campaignId = "campaign-1";
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test", "planned", "/x.pdf", now, now);
    db.prepare(
      `INSERT INTO plans (id, campaign_id, strategy_summary, requirements_checklist, content_plan, opportunity_score, pdf_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "plan-1",
      campaignId,
      "s",
      "[]",
      JSON.stringify({ hook: { script: "hi" }, body: { script: "yo" } }),
      50,
      null,
      now
    );
    assetId = "asset-1";
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, campaignId, "/video-assets/a.mp4", "footage", 5.0, "done", now);
  });

  it("saves segment assignments covering all content_plan segments", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          {
            segment_key: "hook",
            video_asset_id: assetId,
            trim_start: 0,
            trim_end: 2,
            order_index: 0,
            layout_template: "standard",
            caption_style: "energetic",
          },
          {
            segment_key: "body",
            video_asset_id: assetId,
            trim_start: 2,
            trim_end: 4,
            order_index: 1,
            layout_template: "standard",
          },
        ],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const rows = db.prepare("SELECT * FROM segment_assignments WHERE campaign_id = ?").all(campaignId) as any[];
    expect(rows).toHaveLength(2);
    const hookRow = rows.find((r: any) => r.segment_key === "hook");
    expect(hookRow.caption_style).toBe("energetic");
  });

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

  it("rejects gameplay_full_focus without crop_gameplay_rect", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          { segment_key: "hook", video_asset_id: assetId, trim_start: 0, trim_end: 2, order_index: 0, layout_template: "gameplay_full_focus" },
          { segment_key: "body", video_asset_id: assetId, trim_start: 2, trim_end: 4, order_index: 1, layout_template: "standard" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.missing_crop).toEqual(["hook"]);
  });

  it("rejects a segment where trim_end <= trim_start", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          { segment_key: "hook", video_asset_id: assetId, trim_start: 2, trim_end: 2, order_index: 0, layout_template: "standard" },
          { segment_key: "body", video_asset_id: assetId, trim_start: 2, trim_end: 4, order_index: 1, layout_template: "standard" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.invalid_segments).toEqual(["hook"]);
  });

  it("rejects a segment referencing a video_asset_id that doesn't exist", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          { segment_key: "hook", video_asset_id: "nonexistent-asset", trim_start: 0, trim_end: 2, order_index: 0, layout_template: "standard" },
          { segment_key: "body", video_asset_id: assetId, trim_start: 2, trim_end: 4, order_index: 1, layout_template: "standard" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.unknown_asset_segments).toEqual(["hook"]);
  });

  it("persists title_rect when provided", async () => {
    const app = createApp();
    const res = await request(app)
      .put(`/api/campaigns/${campaignId}/segments`)
      .send({
        segments: [
          {
            segment_key: "hook",
            video_asset_id: assetId,
            trim_start: 0,
            trim_end: 5,
            order_index: 0,
            layout_template: "standard",
            title_text: "Hello",
            title_rect: { x: 0.1, y: 0.8, width: 0.8, height: 0.1 },
          },
          { segment_key: "body", video_asset_id: assetId, trim_start: 2, trim_end: 4, order_index: 1, layout_template: "standard" },
        ],
      });

    expect(res.status).toBe(200);
    const db = getDb(dbPath);
    const row = db
      .prepare("SELECT * FROM segment_assignments WHERE campaign_id = ? AND segment_key = ?")
      .get(campaignId, "hook") as any;
    expect(JSON.parse(row.title_rect)).toEqual({ x: 0.1, y: 0.8, width: 0.8, height: 0.1 });
  });
});
