import fs from "fs";
import path from "path";
import express, { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../asyncHandler";

export function createFontsRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const videoAssetsDir = process.env.VIDEO_ASSETS_DIR ?? "/app/video-assets";
  const fontsDir = path.join(videoAssetsDir, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });

  const upload = multer({ dest: fontsDir });

  router.post("/", upload.single("file"), asyncHandler(async (req, res) => {
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
    const finalPath = path.join(fontsDir, `${file.filename}${ext}`);
    fs.renameSync(file.path, finalPath);
    res.status(201).json({ path: finalPath });
  }));

  return router;
}
