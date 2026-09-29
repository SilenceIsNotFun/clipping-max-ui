import fs from "fs";
import path from "path";
import express, { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../asyncHandler";
import { getDb } from "../db";

export function createFontsRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const videoAssetsDir = process.env.VIDEO_ASSETS_DIR ?? "/app/video-assets";
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const fontsDir = path.join(videoAssetsDir, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });

  const upload = multer({ dest: fontsDir });

  router.post("/", upload.single("file"), asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = req.params.id;
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".ttf" && ext !== ".otf") {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: "font must be a .ttf or .otf file" });
      return;
    }
    const campaignFontsDir = path.join(fontsDir, campaignId);
    fs.mkdirSync(campaignFontsDir, { recursive: true });
    const finalPath = path.join(campaignFontsDir, `${file.filename}${ext}`);
    fs.renameSync(file.path, finalPath);
    res.status(201).json({ path: finalPath });
  }));

  return router;
}
