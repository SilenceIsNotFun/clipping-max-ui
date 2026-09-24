import fs from "fs";
import os from "os";
import path from "path";
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
});
