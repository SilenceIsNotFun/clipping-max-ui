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

    const cropSuggestion = req.body.crop_suggestion as
      | {
          crop_gameplay_rect: Record<string, number> | null;
          crop_facecam_rect: Record<string, number> | null;
          detection_method: "face" | "saliency";
          confidence: number;
        }
      | null
      | undefined;
    if (cropSuggestion) {
      db.prepare(
        `INSERT INTO crop_suggestions (id, video_asset_id, crop_gameplay_rect, crop_facecam_rect, detection_method, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        assetId,
        cropSuggestion.crop_gameplay_rect ? JSON.stringify(cropSuggestion.crop_gameplay_rect) : null,
        cropSuggestion.crop_facecam_rect ? JSON.stringify(cropSuggestion.crop_facecam_rect) : null,
        cropSuggestion.detection_method,
        cropSuggestion.confidence,
        now
      );
    }

    res.json({ status: "recorded" });
  });

  router.post("/assets/:assetId/hooks-complete", (req, res) => {
    const db = getDb(dbPath);
    const { assetId } = req.params;
    const now = new Date().toISOString();

    if (req.body.error) {
      console.error(`find-hooks failed for asset ${assetId}:`, req.body.error);
      db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("failed", assetId);
      res.json({ status: "recorded" });
      return;
    }

    const suggestions = (req.body.hook_suggestions ?? []) as Array<{
      start_ms: number;
      end_ms: number;
      title: string;
      reasoning: string;
    }>;
    const insert = db.prepare(
      `INSERT INTO hook_suggestions (id, video_asset_id, start_ms, end_ms, title, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows: typeof suggestions) => {
      for (const s of rows) {
        insert.run(randomUUID(), assetId, s.start_ms, s.end_ms, s.title, s.reasoning, now);
      }
    });
    insertMany(suggestions);

    db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("done", assetId);
    res.json({ status: "recorded" });
  });

  router.post("/render/:jobId/complete", (req, res) => {
    const db = getDb(dbPath);
    const { jobId } = req.params;
    const now = new Date().toISOString();

    if (req.body.error) {
      db.prepare("UPDATE render_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        req.body.error,
        now,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    db.prepare("UPDATE render_jobs SET status = ?, output_path = ?, updated_at = ? WHERE id = ?").run(
      "ready_for_preview",
      req.body.output_path,
      now,
      jobId
    );

    const words = (req.body.caption_words ?? []) as Array<{ word: string; start_ms: number; end_ms: number }>;
    const insert = db.prepare(
      `INSERT INTO caption_words (id, render_job_id, word, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows: typeof words) => {
      for (const w of rows) {
        insert.run(randomUUID(), jobId, w.word, w.start_ms, w.end_ms);
      }
    });
    insertMany(words);

    res.json({ status: "recorded" });
  });

  return router;
}
