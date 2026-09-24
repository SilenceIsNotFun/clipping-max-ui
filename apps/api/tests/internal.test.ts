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
});
