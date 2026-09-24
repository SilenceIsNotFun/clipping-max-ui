import { randomUUID } from "crypto";
import express, { Router } from "express";
import { getDb } from "../db";

export function createInternalRouter(): Router {
  const router = express.Router();
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";

  router.post("/assets/:assetId/analysis-complete", (req, res) => {
    const db = getDb(dbPath);
    const { assetId } = req.params;
    const now = new Date().toISOString();

    if (req.body.error) {
      db.prepare("UPDATE video_assets SET analysis_status = ? WHERE id = ?").run("failed", assetId);
      res.json({ status: "recorded" });
      return;
    }

    const candidates = (req.body.moment_candidates ?? []) as Array<{
      timestamp_ms: number;
      score: number;
      detection_type: string;
    }>;
    const insert = db.prepare(
      `INSERT INTO moment_candidates (id, video_asset_id, timestamp_ms, score, detection_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows: typeof candidates) => {
      for (const c of rows) {
        insert.run(randomUUID(), assetId, c.timestamp_ms, c.score, c.detection_type, now);
      }
    });
    insertMany(candidates);

    db.prepare("UPDATE video_assets SET analysis_status = ? WHERE id = ?").run("done", assetId);
    res.json({ status: "recorded" });
  });

  return router;
}
