import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import express, { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../asyncHandler";
import { getDb } from "../db";
import { analyzeAsset } from "../services/videoWorkerClient";

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
    const assetType = req.body.asset_type === "music" ? "music" : "footage";
    const duration = probeDurationSeconds(file.path);
    if (duration <= 0) {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: "file is not a readable audio/video file" });
      return;
    }

    const finalPath = path.join(videoAssetsDir, `${file.filename}${path.extname(file.originalname)}`);
    fs.renameSync(file.path, finalPath);

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_assets (id, campaign_id, file_path, asset_type, duration_seconds, analysis_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, campaignId, finalPath, assetType, duration, assetType === "footage" ? "pending" : "done", now);

    if (assetType === "footage") {
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

  return router;
}
