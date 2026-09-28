import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import express, { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../asyncHandler";
import { getDb } from "../db";
import { analyzeAsset, findHooks, triggerCut, triggerYoutubeDownload } from "../services/videoWorkerClient";

function probeDurationSeconds(filePath: string): number {
  try {
    const output = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    const duration = parseFloat(output.toString().trim());
    return Number.isFinite(duration) ? duration : 0;
  } catch {
    return 0;
  }
}

export function createAssetsRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const videoAssetsDir = process.env.VIDEO_ASSETS_DIR ?? "/app/video-assets";
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const videoWorkerUrl = process.env.VIDEO_WORKER_URL ?? "http://video-worker:8100";
  const callbackBase = process.env.API_INTERNAL_CALLBACK_URL ?? "http://api:4000/api/internal";
  fs.mkdirSync(videoAssetsDir, { recursive: true });

  const upload = multer({ dest: videoAssetsDir });

  router.post("/", upload.single("file"), asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const file = req.file;
    const campaignId = req.params.id;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const rawAssetType = typeof req.body.asset_type === "string" ? req.body.asset_type.trim() : "";
    const assetType = rawAssetType || "footage";

    let duration = 0;
    if (assetType === "watermark") {
      if (file.mimetype !== "image/png" && file.mimetype !== "image/jpeg") {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: "watermark must be a PNG or JPEG image" });
        return;
      }
    } else {
      duration = probeDurationSeconds(file.path);
      if (duration <= 0) {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: "file is not a readable audio/video file" });
        return;
      }
    }

    const finalPath = path.join(videoAssetsDir, `${file.filename}${path.extname(file.originalname)}`);
    fs.renameSync(file.path, finalPath);

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, campaignId, finalPath, assetType, duration, assetType !== "watermark" ? "pending" : "done", now);

    if (assetType !== "watermark") {
      try {
        await analyzeAsset(videoWorkerUrl, id, finalPath, `${callbackBase}/assets/${id}/analysis-complete`);
      } catch (err) {
        db.prepare("UPDATE video_assets SET analysis_status = ? WHERE id = ?").run("failed", id);
      }
    }

    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(id);
    res.status(201).json(asset);
  }));

  router.get("/", (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const assets = db
      .prepare("SELECT * FROM video_assets WHERE campaign_id = ? ORDER BY created_at ASC")
      .all(campaignId);
    res.json(assets);
  });

  router.get("/:assetId/moments", (req, res) => {
    const db = getDb(dbPath);
    const moments = db
      .prepare("SELECT * FROM moment_candidates WHERE video_asset_id = ? ORDER BY timestamp_ms ASC")
      .all(req.params.assetId);
    res.json(moments);
  });

  router.get("/:assetId/crop-suggestion", (req, res) => {
    const db = getDb(dbPath);
    const suggestion = db
      .prepare("SELECT * FROM crop_suggestions WHERE video_asset_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.params.assetId);
    if (!suggestion) {
      res.status(404).json({ error: "no crop suggestion found for this asset" });
      return;
    }
    res.json(suggestion);
  });

  router.post("/:assetId/find-hooks", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(req.params.assetId) as
      | { id: string; file_path: string }
      | undefined;
    if (!asset) {
      res.status(404).json({ error: "asset not found" });
      return;
    }

    const plan = db
      .prepare("SELECT * FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { strategy_summary: string; requirements_checklist: string; content_plan: string } | undefined;
    if (!plan) {
      res.status(400).json({ error: "campaign has no plan yet; generate a plan before finding hooks" });
      return;
    }

    const requirementsChecklist = JSON.parse(plan.requirements_checklist) as string[];
    const contentPlan = JSON.parse(plan.content_plan) as { hook?: string };

    db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("pending", req.params.assetId);

    try {
      await findHooks(
        videoWorkerUrl,
        req.params.assetId,
        asset.file_path,
        contentPlan.hook ?? "",
        plan.strategy_summary,
        requirementsChecklist,
        `${callbackBase}/assets/${req.params.assetId}/hooks-complete`
      );
    } catch (err) {
      console.error(`find-hooks trigger failed for asset ${req.params.assetId}:`, err);
      db.prepare("UPDATE video_assets SET hook_status = ? WHERE id = ?").run("failed", req.params.assetId);
      res.status(202).json({ status: "failed" });
      return;
    }

    res.status(202).json({ status: "pending" });
  }));

  router.get("/:assetId/hook-suggestions", (req, res) => {
    const db = getDb(dbPath);
    const suggestions = db
      .prepare("SELECT * FROM hook_suggestions WHERE video_asset_id = ? ORDER BY created_at ASC")
      .all(req.params.assetId);
    res.json(suggestions);
  });

  router.get("/categories", (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const defaults = ["footage", "clip", "broll", "music", "watermark"];
    const used = (
      db.prepare("SELECT DISTINCT asset_type FROM video_assets WHERE campaign_id = ?").all(campaignId) as {
        asset_type: string;
      }[]
    ).map((r) => r.asset_type);
    const categories = Array.from(new Set([...defaults, ...used]));
    res.json(categories);
  });

  router.post("/youtube", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const url = typeof req.body.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      res.status(400).json({ error: "url is not a valid URL" });
      return;
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO youtube_download_jobs (id, campaign_id, url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(jobId, campaignId, url, "pending", now, now);

    try {
      await triggerYoutubeDownload(videoWorkerUrl, jobId, url, `${callbackBase}/youtube-jobs/${jobId}/progress`);
    } catch (err) {
      db.prepare("UPDATE youtube_download_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        (err as Error).message,
        new Date().toISOString(),
        jobId
      );
      res.status(202).json({ job_id: jobId });
      return;
    }

    res.status(202).json({ job_id: jobId });
  }));

  router.post("/:assetId/cut", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const { assetId } = req.params;
    const startSeconds = Number(req.body.start_seconds);
    const durationSeconds = Number(req.body.duration_seconds);

    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ? AND campaign_id = ?").get(assetId, campaignId) as
      | { id: string; file_path: string }
      | undefined;
    if (!asset) {
      res.status(404).json({ error: "asset not found" });
      return;
    }
    if (!Number.isFinite(startSeconds) || startSeconds < 0) {
      res.status(400).json({ error: "start_seconds must be a non-negative number" });
      return;
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      res.status(400).json({ error: "duration_seconds must be a positive number" });
      return;
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cut_jobs (id, campaign_id, source_asset_id, start_seconds, duration_seconds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, campaignId, assetId, startSeconds, durationSeconds, "pending", now);

    try {
      await triggerCut(
        videoWorkerUrl,
        jobId,
        asset.file_path,
        startSeconds,
        durationSeconds,
        `${callbackBase}/cut-jobs/${jobId}/complete`
      );
    } catch (err) {
      db.prepare("UPDATE cut_jobs SET status = ?, error_message = ? WHERE id = ?").run(
        "failed",
        (err as Error).message,
        jobId
      );
      res.status(202).json({ cut_job_id: jobId });
      return;
    }

    res.status(202).json({ cut_job_id: jobId });
  }));

  router.get("/cut-jobs/:jobId", (req, res) => {
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM cut_jobs WHERE id = ?").get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "cut job not found" });
      return;
    }
    res.json(job);
  });

  router.delete("/:assetId", (req, res) => {
    const db = getDb(dbPath);
    const asset = db.prepare("SELECT * FROM video_assets WHERE id = ?").get(req.params.assetId) as
      | { id: string; file_path: string }
      | undefined;
    if (!asset) {
      res.status(404).json({ error: "asset not found" });
      return;
    }

    const usedInSegments = db
      .prepare(
        "SELECT COUNT(*) as count FROM segment_assignments WHERE video_asset_id = ? OR secondary_video_asset_id = ?"
      )
      .get(req.params.assetId, req.params.assetId) as { count: number };
    if (usedInSegments.count > 0) {
      res.status(409).json({ error: "asset is used in a segment assignment; remove it from segments first" });
      return;
    }

    db.transaction(() => {
      db.prepare("DELETE FROM moment_candidates WHERE video_asset_id = ?").run(req.params.assetId);
      db.prepare("DELETE FROM crop_suggestions WHERE video_asset_id = ?").run(req.params.assetId);
      db.prepare("DELETE FROM hook_suggestions WHERE video_asset_id = ?").run(req.params.assetId);
      db.prepare("DELETE FROM cut_jobs WHERE source_asset_id = ? OR result_asset_id = ?").run(req.params.assetId, req.params.assetId);
      db.prepare("DELETE FROM youtube_download_jobs WHERE result_asset_id = ?").run(req.params.assetId);
      db.prepare("DELETE FROM video_assets WHERE id = ?").run(req.params.assetId);
    })();

    fs.unlink(asset.file_path, () => {
      // best-effort: an already-missing file on disk shouldn't block the DB delete succeeding
    });

    res.status(204).send();
  });

  return router;
}
