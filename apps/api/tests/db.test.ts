import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { getDb, resetDbCacheForTests } from "../src/db";

describe("getDb", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
    resetDbCacheForTests();
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("creates all four tables", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["campaigns", "brd_documents", "plans", "review_tasks"])
    );
    db.close();
  });

  it("inserts and reads a campaign row", () => {
    const db = getDb(dbPath);
    db.prepare(
      `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("c1", "Test Campaign", "uploaded", "/uploads/c1.pdf", "2026-09-21", "2026-09-21");
    const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get("c1") as any;
    expect(row.title).toBe("Test Campaign");
    expect(row.status).toBe("uploaded");
    db.close();
  });

  it("creates the video content generation tables", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "video_assets",
        "moment_candidates",
        "segment_assignments",
        "render_jobs",
        "caption_words",
      ])
    );
    db.close();
  });

  it("creates the crop_suggestions table with a caption_style column on segment_assignments", () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(tables).toContain("crop_suggestions");

    const columns = db
      .prepare("PRAGMA table_info(segment_assignments)")
      .all()
      .map((row: any) => row.name);
    expect(columns).toContain("caption_style");
    db.close();
  });

  it("adds caption_style via migration when opening a pre-existing DB created without it", () => {
    // Simulate a DB file created by a pre-branch version of the schema: segment_assignments
    // exists already, but without the caption_style column. getDb's CREATE TABLE IF NOT EXISTS
    // is a no-op against an existing table, so the migration path must ALTER TABLE it in.
    const preexisting = new Database(dbPath);
    preexisting.exec(`
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
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        file_path TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        duration_seconds REAL NOT NULL,
        analysis_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE TABLE segment_assignments (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        segment_key TEXT NOT NULL,
        video_asset_id TEXT NOT NULL REFERENCES video_assets(id),
        secondary_video_asset_id TEXT REFERENCES video_assets(id),
        trim_start REAL NOT NULL,
        trim_end REAL NOT NULL,
        order_index INTEGER NOT NULL,
        layout_template TEXT NOT NULL,
        crop_gameplay_rect TEXT,
        crop_facecam_rect TEXT,
        title_text TEXT
      );
    `);
    const preexistingColumns = preexisting
      .prepare("PRAGMA table_info(segment_assignments)")
      .all()
      .map((row: any) => row.name);
    expect(preexistingColumns).not.toContain("caption_style");
    preexisting.close();

    // Reopen the SAME db file path via getDb() — the migration should add the missing column.
    resetDbCacheForTests();
    const migrated = getDb(dbPath);
    const migratedColumns = migrated
      .prepare("PRAGMA table_info(segment_assignments)")
      .all()
      .map((row: any) => row.name);
    expect(migratedColumns).toContain("caption_style");

    // And the column should actually be usable for inserts.
    migrated
      .prepare(
        `INSERT INTO campaigns (id, title, status, source_file_path, created_at, updated_at)
         VALUES ('c1', 'Test', 'uploaded', '/uploads/c1.pdf', '2026-09-21', '2026-09-21')`
      )
      .run();
    migrated
      .prepare(
        `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, created_at)
         VALUES ('v1', 'c1', '/uploads/v1.mp4', 'gameplay', 10, '2026-09-21')`
      )
      .run();
    migrated
      .prepare(
        `INSERT INTO segment_assignments
         (id, campaign_id, segment_key, video_asset_id, trim_start, trim_end, order_index, layout_template, caption_style)
         VALUES ('s1', 'c1', 'seg-1', 'v1', 0, 1, 0, 'single', 'energetic')`
      )
      .run();
    const row = migrated.prepare("SELECT caption_style FROM segment_assignments WHERE id = ?").get("s1") as any;
    expect(row.caption_style).toBe("energetic");
    migrated.close();
  });

  it("adds watermark_asset_id and watermark_rect columns to render_jobs, migrated on an existing DB", () => {
    resetDbCacheForTests();
    const oldDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "old-render-db-")), "app.db");
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE render_jobs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        status TEXT NOT NULL,
        tts_voice TEXT NOT NULL,
        music_asset_id TEXT,
        output_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    oldDb.close();

    const reopened = getDb(oldDbPath);
    const columns = reopened.prepare("PRAGMA table_info(render_jobs)").all().map((row: any) => row.name);
    expect(columns).toContain("watermark_asset_id");
    expect(columns).toContain("watermark_rect");
    reopened.close();
  });

  it("creates render_jobs table with watermark_asset_id and watermark_rect columns on fresh DB", () => {
    const db = getDb(dbPath);
    const columns = db.prepare("PRAGMA table_info(render_jobs)").all().map((row: any) => row.name);
    expect(columns).toContain("watermark_asset_id");
    expect(columns).toContain("watermark_rect");
    db.close();
  });
});
