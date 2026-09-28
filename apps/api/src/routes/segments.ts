import { randomUUID } from "crypto";
import express, { Router } from "express";
import { getDb } from "../db";

interface SegmentPayload {
  segment_key: string;
  video_asset_id: string;
  secondary_video_asset_id?: string;
  trim_start: number;
  trim_end: number;
  order_index: number;
  layout_template: string;
  crop_gameplay_rect?: Record<string, number>;
  crop_facecam_rect?: Record<string, number>;
  title_text?: string;
  title_rect?: Record<string, number>;
  caption_style?: string;
}

const TEMPLATES_REQUIRING_GAMEPLAY_CROP = new Set(["gameplay_full_focus", "gameplay_facecam_split"]);
const TEMPLATES_REQUIRING_FACECAM_CROP = new Set(["gameplay_facecam_split"]);
const VALID_LAYOUT_TEMPLATES = new Set([
  "standard",
  "gameplay_facecam_split",
  "gameplay_full_focus",
  "cinematic_letterbox",
]);

function isValidCropRect(rect: unknown): boolean {
  if (!rect || typeof rect !== "object") return false;
  const r = rect as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every(
    (k) => typeof r[k] === "number" && (r[k] as number) >= 0 && (r[k] as number) <= 1
  );
}

export function createSegmentsRouter(): Router {
  const router = express.Router({ mergeParams: true });
  const dbPath = process.env.DB_PATH ?? "/app/data/app.db";

  router.put("/", (req, res) => {
    const db = getDb(dbPath);
    const campaignId = (req.params as { id: string }).id;
    const segments: SegmentPayload[] = req.body.segments ?? [];

    const plan = db
      .prepare("SELECT content_plan FROM plans WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(campaignId) as { content_plan: string } | undefined;
    if (!plan) {
      res.status(404).json({ error: "no plan found for this campaign" });
      return;
    }
    const requiredKeys = Object.keys(JSON.parse(plan.content_plan));
    const providedKeys = segments.map((s) => s.segment_key);
    const missingSegments = requiredKeys.filter((k) => !providedKeys.includes(k));
    if (missingSegments.length > 0) {
      res.status(400).json({ missing_segments: missingSegments });
      return;
    }

    const missingCrop = segments
      .filter((s) => {
        if (s.secondary_video_asset_id) return false;
        if (TEMPLATES_REQUIRING_GAMEPLAY_CROP.has(s.layout_template) && !s.crop_gameplay_rect) return true;
        if (TEMPLATES_REQUIRING_FACECAM_CROP.has(s.layout_template) && !s.crop_facecam_rect) return true;
        return false;
      })
      .map((s) => s.segment_key);
    if (missingCrop.length > 0) {
      res.status(400).json({ missing_crop: missingCrop });
      return;
    }

    const invalidSegments = segments
      .filter((s) => {
        if (s.trim_end <= s.trim_start) return true;
        if (!s.video_asset_id) return true;
        if (!VALID_LAYOUT_TEMPLATES.has(s.layout_template)) return true;
        if (s.crop_gameplay_rect && !isValidCropRect(s.crop_gameplay_rect)) return true;
        if (s.crop_facecam_rect && !isValidCropRect(s.crop_facecam_rect)) return true;
        return false;
      })
      .map((s) => s.segment_key);
    if (invalidSegments.length > 0) {
      res.status(400).json({ invalid_segments: invalidSegments });
      return;
    }

    const validAssetIds = new Set(
      (db.prepare("SELECT id FROM video_assets WHERE campaign_id = ?").all(campaignId) as { id: string }[]).map(
        (r) => r.id
      )
    );
    const unknownAssetSegments = segments
      .filter(
        (s) =>
          !validAssetIds.has(s.video_asset_id) ||
          (s.secondary_video_asset_id && !validAssetIds.has(s.secondary_video_asset_id))
      )
      .map((s) => s.segment_key);
    if (unknownAssetSegments.length > 0) {
      res.status(400).json({ unknown_asset_segments: unknownAssetSegments });
      return;
    }

    const deleteExisting = db.prepare("DELETE FROM segment_assignments WHERE campaign_id = ?");
    const insert = db.prepare(
      `INSERT INTO segment_assignments
       (id, campaign_id, segment_key, video_asset_id, secondary_video_asset_id, trim_start, trim_end, order_index, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text, caption_style, title_rect)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const replaceAll = db.transaction((rows: SegmentPayload[]) => {
      deleteExisting.run(campaignId);
      for (const s of rows) {
        insert.run(
          randomUUID(),
          campaignId,
          s.segment_key,
          s.video_asset_id,
          s.secondary_video_asset_id ?? null,
          s.trim_start,
          s.trim_end,
          s.order_index,
          s.layout_template,
          s.crop_gameplay_rect ? JSON.stringify(s.crop_gameplay_rect) : null,
          s.crop_facecam_rect ? JSON.stringify(s.crop_facecam_rect) : null,
          s.title_text ?? null,
          s.caption_style ?? null,
          s.title_rect ? JSON.stringify(s.title_rect) : null
        );
      }
    });
    replaceAll(segments);

    const saved = db.prepare("SELECT * FROM segment_assignments WHERE campaign_id = ?").all(campaignId);
    res.json(saved);
  });

  return router;
}
