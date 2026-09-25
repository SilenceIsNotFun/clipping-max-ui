import { randomUUID } from "crypto";
import express, { Router } from "express";
import { asyncHandler } from "../asyncHandler";
import { getDb } from "../db";
import { submitRender, RenderSegmentPayload } from "../services/videoWorkerClient";

export function createRenderRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";
  const videoWorkerUrl = process.env.VIDEO_WORKER_URL ?? "http://video-worker:8100";
  const callbackBase = process.env.API_INTERNAL_CALLBACK_URL ?? "http://api:4000/api/internal";

  router.post("/", asyncHandler(async (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;

    const segments = db
      .prepare("SELECT * FROM segment_assignments WHERE campaign_id = ? ORDER BY order_index ASC")
      .all(campaignId) as any[];
    if (segments.length === 0) {
      res.status(400).json({ error: "no segment assignments found for this campaign" });
      return;
    }

    const plan = db
      .prepare("SELECT content_plan FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { content_plan: string } | undefined;
    const contentPlan = plan ? JSON.parse(plan.content_plan) : {};

    const assetPathById = new Map<string, string>();
    for (const row of db.prepare("SELECT id, file_path FROM video_assets WHERE campaign_id = ?").all(campaignId) as any[]) {
      assetPathById.set(row.id, row.file_path);
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const musicAssetId: string | null = req.body.music_asset_id ?? null;
    const ttsVoice: string = req.body.tts_voice ?? "id_ID-news_tts-medium";

    db.prepare(
      `INSERT INTO render_jobs (id, campaign_id, status, tts_voice, music_asset_id, output_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, campaignId, "rendering", ttsVoice, musicAssetId, null, null, now, now);

    const segmentPayloads: RenderSegmentPayload[] = segments.map((s) => ({
      file_path: assetPathById.get(s.video_asset_id) ?? "",
      secondary_file_path: s.secondary_video_asset_id ? assetPathById.get(s.secondary_video_asset_id) : undefined,
      trim_start: s.trim_start,
      trim_end: s.trim_end,
      order_index: s.order_index,
      script_text: contentPlan[s.segment_key]?.script ?? "",
      layout_template: s.layout_template,
      crop_gameplay_rect: s.crop_gameplay_rect ? JSON.parse(s.crop_gameplay_rect) : undefined,
      crop_facecam_rect: s.crop_facecam_rect ? JSON.parse(s.crop_facecam_rect) : undefined,
      title_text: s.title_text ?? undefined,
      caption_style: s.caption_style ?? undefined,
    }));

    const musicPath = musicAssetId ? assetPathById.get(musicAssetId) ?? null : null;

    try {
      await submitRender(
        videoWorkerUrl,
        jobId,
        segmentPayloads,
        ttsVoice,
        musicPath,
        `${callbackBase}/render/${jobId}/complete`
      );
    } catch (err) {
      db.prepare("UPDATE render_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        "video-worker unreachable",
        new Date().toISOString(),
        jobId
      );
      res.status(202).json({ job_id: jobId, status: "failed" });
      return;
    }

    res.status(202).json({ job_id: jobId, status: "queued" });
  }));

  router.get("/:jobId", (req, res) => {
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(req.params.jobId) as any;
    if (!job) {
      res.status(404).json({ error: "render job not found" });
      return;
    }
    const captionWords = db
      .prepare("SELECT * FROM caption_words WHERE render_job_id = ? ORDER BY start_ms ASC")
      .all(req.params.jobId);
    res.json({ ...job, caption_words: captionWords });
  });

  router.post("/:jobId/finalize", (req, res) => {
    const db = getDb(dbPath);
    const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(req.params.jobId) as any;
    if (!job) {
      res.status(404).json({ error: "render job not found" });
      return;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE render_jobs SET status = ?, updated_at = ? WHERE id = ?").run("final", now, req.params.jobId);
    const updated = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(req.params.jobId);
    res.json(updated);
  });

  return router;
}
