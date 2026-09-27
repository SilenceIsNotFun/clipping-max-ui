export type CampaignStatus =
  | "uploaded"
  | "parsing"
  | "planned"
  | "needs_review"
  | "failed";

export interface Campaign {
  id: string;
  title: string;
  status: CampaignStatus;
  source_file_path: string;
  created_at: string;
  updated_at: string;
}

export interface BrdDocument {
  id: string;
  campaign_id: string;
  doc_type: "pdf" | "docx" | "image";
  raw_text: string;
  extracted_links: string; // JSON-encoded string[]
  parsing_confidence: number;
  created_at: string;
}

export interface Plan {
  id: string;
  campaign_id: string;
  strategy_summary: string;
  requirements_checklist: string; // JSON-encoded string[]
  content_plan: string; // JSON-encoded object
  opportunity_score: number;
  pdf_path: string | null;
  created_at: string;
}

export interface ReviewTask {
  id: string;
  campaign_id: string;
  reason: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

export interface VideoAsset {
  id: string;
  campaign_id: string;
  file_path: string;
  asset_type: "footage" | "music" | "watermark";
  duration_seconds: number;
  analysis_status: "pending" | "done" | "failed";
  created_at: string;
}

export interface MomentCandidate {
  id: string;
  video_asset_id: string;
  timestamp_ms: number;
  score: number;
  detection_type: "audio_peak" | "scene_change";
  created_at: string;
}

export interface CropSuggestion {
  id: string;
  video_asset_id: string;
  crop_gameplay_rect: string | null; // JSON-encoded CropRect
  crop_facecam_rect: string | null; // JSON-encoded CropRect
  detection_method: "face" | "saliency";
  confidence: number;
  created_at: string;
}

export type LayoutTemplate =
  | "standard"
  | "gameplay_facecam_split"
  | "gameplay_full_focus"
  | "cinematic_letterbox";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SegmentAssignment {
  id: string;
  campaign_id: string;
  segment_key: string;
  video_asset_id: string;
  secondary_video_asset_id: string | null;
  trim_start: number;
  trim_end: number;
  order_index: number;
  layout_template: LayoutTemplate;
  crop_gameplay_rect: string | null; // JSON-encoded CropRect
  crop_facecam_rect: string | null; // JSON-encoded CropRect
  title_text: string | null;
  caption_style: string | null;
}

export type RenderJobStatus = "queued" | "rendering" | "ready_for_preview" | "final" | "failed";

export interface RenderJob {
  id: string;
  campaign_id: string;
  status: RenderJobStatus;
  tts_voice: string;
  music_asset_id: string | null;
  watermark_asset_id: string | null;
  watermark_rect: string | null; // JSON-encoded CropRect
  output_path: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CaptionWord {
  id: string;
  render_job_id: string;
  word: string;
  start_ms: number;
  end_ms: number;
}
