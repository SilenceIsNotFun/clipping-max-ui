import { randomUUID } from "crypto";
import express, { Router } from "express";
import { asyncHandler } from "../asyncHandler";
import { getDb } from "../db";
import { analyzeAsset } from "../services/videoWorkerClient";

export function createInternalRouter(): Router {
  const router = express.Router();
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const videoWorkerUrl = process.env.VIDEO_WORKER_URL ?? "http://video-worker:8100";
  const callbackBase = process.env.API_INTERNAL_CALLBACK_URL ?? "http://api:4000/api/internal";

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

  router.post("/cut-jobs/:jobId/complete", (req, res) => {
    const db = getDb(dbPath);
    const { jobId } = req.params;
    const now = new Date().toISOString();

    if (req.body.status === "failed") {
      console.error(`cut failed for job ${jobId}:`, req.body.error);
      db.prepare("UPDATE cut_jobs SET status = ?, error_message = ? WHERE id = ?").run(
        "failed",
        req.body.error,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    const job = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get(jobId) as { campaign_id: string } | undefined;
    if (!job) {
      res.status(404).json({ error: "cut job not found" });
      return;
    }

    const clipId = randomUUID();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(clipId, job.campaign_id, req.body.output_path, "clip", req.body.duration_seconds, "done", now);

    db.prepare("UPDATE cut_jobs SET status = ?, result_asset_id = ? WHERE id = ?").run("done", clipId, jobId);
    res.json({ status: "recorded" });
  });

  router.post("/youtube-jobs/:jobId/progress", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const { jobId } = req.params;
    const now = new Date().toISOString();

    if (req.body.status === "downloading") {
      db.prepare(
        `UPDATE youtube_download_jobs
         SET status = ?, downloaded_bytes = ?, total_bytes = ?, speed_bytes_per_sec = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        "downloading",
        req.body.downloaded_bytes ?? null,
        req.body.total_bytes ?? null,
        req.body.speed_bytes_per_sec ?? null,
        now,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    if (req.body.status === "failed") {
      console.error(`youtube download failed for job ${jobId}:`, req.body.error);
      db.prepare("UPDATE youtube_download_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        req.body.error,
        now,
        jobId
      );
      res.json({ status: "recorded" });
      return;
    }

    if (req.body.status !== "done") {
      res.status(400).json({ error: "unexpected status" });
      return;
    }

    const job = db.prepare("SELECT * FROM youtube_download_jobs WHERE id = ?").get(jobId) as
      | { campaign_id: string; status: string }
      | undefined;
    if (!job) {
      res.status(404).json({ error: "youtube download job not found" });
      return;
    }

    if (job.status === "done") {
      // Idempotency guard: a retried "done" callback for a job already
      // recorded as done must be a safe no-op, not a second video_assets
      // row / overwritten result_asset_id.
      res.json({ status: "already recorded" });
      return;
    }

    const assetId = randomUUID();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(assetId, job.campaign_id, req.body.output_path, "footage", req.body.duration_seconds, "pending", now);

    db.prepare("UPDATE youtube_download_jobs SET status = ?, result_asset_id = ?, updated_at = ? WHERE id = ?").run(
      "done",
      assetId,
      now,
      jobId
    );

    try {
      await analyzeAsset(videoWorkerUrl, assetId, req.body.output_path, `${callbackBase}/assets/${assetId}/analysis-complete`);
    } catch (err) {
      console.error(`analyze trigger failed for downloaded asset ${assetId}:`, err);
      db.prepare("UPDATE video_assets SET analysis_status = ? WHERE id = ?").run("failed", assetId);
    }

    res.json({ status: "recorded" });
  }));

  return router;
}
