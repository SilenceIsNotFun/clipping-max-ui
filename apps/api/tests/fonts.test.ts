import fs from "fs";
import path from "path";
import request from "supertest";
import { createApp } from "../src/server";
import { getDb, resetDbCacheForTests } from "../src/db";

describe("font upload route", () => {
  let dataDir: string;
  let campaignId: string;
  let dbPath: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "font-test-"));
    dbPath = path.join(dataDir, "app.db");
    process.env.DB_PATH = dbPath;
    process.env.VIDEO_ASSETS_DIR = path.join(dataDir, "video-assets");
    process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(require("os").tmpdir(), "uploads-"));
    resetDbCacheForTests();
    const db = getDb(dbPath);
    const now = new Date().toISOString();
    campaignId = "campaign-1";
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(campaignId, "Test", "planned", "/x.pdf", now, now);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("accepts a .ttf upload and returns a usable path", async () => {
    const app = createApp();
    const fontPath = path.join(dataDir, "MyFont.ttf");
    fs.writeFileSync(fontPath, Buffer.from("fake-ttf-bytes"));

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/fonts`)
      .attach("file", fontPath);

    expect(res.status).toBe(201);
    expect(typeof res.body.path).toBe("string");
    expect(fs.existsSync(res.body.path)).toBe(true);
  });

  it("rejects a non-font file extension", async () => {
    const app = createApp();
    const badPath = path.join(dataDir, "not-a-font.txt");
    fs.writeFileSync(badPath, "plain text");

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/fonts`)
      .attach("file", badPath);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ttf|otf/i);
  });

  it("returns 400 when no file is attached", async () => {
    const app = createApp();
    const res = await request(app).post(`/api/campaigns/${campaignId}/fonts`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent campaign", async () => {
    const app = createApp();
    const fontPath = path.join(dataDir, "MyFont.ttf");
    fs.writeFileSync(fontPath, Buffer.from("fake-ttf-bytes"));

    const res = await request(app)
      .post(`/api/campaigns/does-not-exist/fonts`)
      .attach("file", fontPath);

    expect(res.status).toBe(404);
  });
});
